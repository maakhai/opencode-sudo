import { spawn } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Plugin } from "@opencode/plugin"
import { formatCommand, hasResetFlag, parseArgv, truncate } from "./command.js"
import { Policies, resolvePolicy, writePolicyFile } from "./policy.js"
import { redactText, redactValue } from "./redact.js"
import { emptyRequest, SudoRpc, type SudoRequest, type SudoStatus } from "./rpc.js"
import { createRuntime, type AskpassRequest, type AskpassResponse, type Runtime } from "./runtime.js"
import { hasSudoSite } from "./scanner.js"

type Policy = "on" | "ask" | "off"

interface Config {
  readonly policy: Policy
  readonly timeout: number
  readonly ttl: number
  readonly validate: boolean
  readonly notify: boolean
  readonly audit: boolean
}

interface Cache {
  readonly password: string
  readonly expiresAt: number
}

interface Validation {
  readonly nonce: string
  readonly password: string
}

interface Pending {
  readonly request: SudoRequest
  finish(response: AskpassResponse): void
}

interface ContextInfo {
  readonly sessionID: string
  readonly command: string
  readonly cwd: string
}

interface SharedState {
  lastTuiSeen: number
  cache?: Cache
  validation?: Validation
  readonly pending: Map<string, Pending>
  lastError: string
}

interface Shared {
  refs: number
  readonly runtime: Runtime
  options: Config
  readonly state: SharedState
  readonly emits: Set<(request: SudoRequest) => void>
}

const SHARED_KEY = Symbol.for("opencode-sudo.shared.v1")

function numberOption(value: unknown, fallback: number, min: number, max: number) {
  const parsed = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.floor(parsed)))
}

function readConfig(raw: Record<string, unknown>): Config {
  const policy = raw.policy
  return {
    policy:
      typeof policy === "string" && (Policies as readonly string[]).includes(policy)
        ? (policy as Policy)
        : "on",
    timeout: numberOption(raw.timeout, 120, 5, 3600),
    ttl: numberOption(raw.ttl, 900, 0, 86_400),
    validate: raw.validate !== false,
    notify: raw.notify !== false,
    audit: raw.audit === true,
  }
}

function readArgv(ppid: number): string[] {
  if (!Number.isFinite(ppid) || ppid <= 0) return []
  try {
    return parseArgv(fs.readFileSync(`/proc/${ppid}/cmdline`))
  } catch {
    return []
  }
}

function readCwd(ppid: number): string {
  if (!Number.isFinite(ppid) || ppid <= 0) return ""
  try {
    return fs.readlinkSync(`/proc/${ppid}/cwd`)
  } catch {
    return ""
  }
}

function parseContext(text: string): ContextInfo {
  try {
    const value = JSON.parse(text) as Record<string, unknown>
    return {
      sessionID: typeof value.sessionID === "string" ? value.sessionID : "",
      command: typeof value.command === "string" ? value.command : "",
      cwd: typeof value.cwd === "string" ? value.cwd : "",
    }
  } catch {
    return { sessionID: "", command: "", cwd: "" }
  }
}

function safeUser() {
  try {
    return os.userInfo().username
  } catch {
    return "user"
  }
}

function safeHost() {
  try {
    return os.hostname()
  } catch {
    return "host"
  }
}

function buildRequest(request: AskpassRequest, argv = readArgv(request.ppid)): SudoRequest {
  const context = parseContext(request.context)
  const command = truncate(formatCommand(argv, context.command || "sudo"), 4000)
  const cwd = readCwd(request.ppid) || context.cwd || ""
  const user = safeUser()
  return {
    id: "",
    command,
    contextCommand: truncate(context.command || "", 4000),
    cwd: truncate(cwd, 500),
    sessionID: request.sessionID || context.sessionID,
    prompt: truncate(request.prompt || `[sudo] password for ${user}:`, 500),
    user,
    host: safeHost(),
    createdAt: Date.now(),
  }
}

function safeStringify(value: unknown) {
  try {
    return JSON.stringify(value) ?? ""
  } catch {
    return ""
  }
}

function runProcess(
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeout: number; signal?: AbortSignal },
): Promise<number> {
  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let child: ReturnType<typeof spawn> | undefined

    const onAbort = () => {
      try {
        child?.kill("SIGKILL")
      } catch {
        // ignore
      }
      done(130)
    }

    const done = (code: number) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      options.signal?.removeEventListener("abort", onAbort)
      resolve(code)
    }

    try {
      child = spawn(command, args, {
        stdio: ["ignore", "ignore", "ignore"],
        env: options.env,
      })
    } catch {
      done(1)
      return
    }

    timer = setTimeout(() => {
      try {
        child?.kill("SIGKILL")
      } catch {
        // ignore
      }
      done(124)
    }, Math.max(1000, options.timeout))

    if (options.signal) {
      if (options.signal.aborted) {
        onAbort()
        return
      }
      options.signal.addEventListener("abort", onAbort, { once: true })
    }

    child.on("error", () => done(1))
    child.on("close", (code) => done(code ?? 1))
  })
}

function hasTui(shared: Shared) {
  return Date.now() - shared.state.lastTuiSeen < 5000
}

function audit(shared: Shared, entry: Record<string, unknown>) {
  if (!shared.options.audit) return
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state")
  const file = path.join(base, "opencode-sudo", "audit.jsonl")
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    fs.appendFileSync(file, JSON.stringify({ ts: Date.now(), ...entry }) + "\n", { mode: 0o600 })
  } catch {
    // audit is best effort
  }
}

function emitAll(shared: Shared, request: SudoRequest) {
  for (const emit of Array.from(shared.emits)) {
    try {
      void emit(request)
    } catch {
      // a location may have gone away
    }
  }
}

async function handleAskpass(
  shared: Shared,
  request: AskpassRequest,
  signal: AbortSignal,
): Promise<AskpassResponse> {
  const state = shared.state
  const options = shared.options

  if (request.validate) {
    if (state.validation && state.validation.nonce === request.validate) {
      return { ok: true, value: state.validation.password }
    }
    return { ok: false, error: "validation expired" }
  }

  if (!hasTui(shared)) {
    state.lastError = "no TUI connected"
    return {
      ok: false,
      error:
        "sudo requires interactive authentication in the OpenCode TUI. Run `opencode` in a terminal (not `opencode run`), or configure NOPASSWD for specific commands.",
    }
  }

  const policy = resolvePolicy(options.policy)
  if (policy === "off") {
    return { ok: false, error: "sudo is disabled in OpenCode (use `/sudo on` to enable it)." }
  }

  const argv = readArgv(request.ppid)
  const resetTimestamp = hasResetFlag(argv)

  if (
    policy === "on" &&
    !resetTimestamp &&
    state.cache &&
    state.cache.expiresAt > Date.now()
  ) {
    return { ok: true, value: state.cache.password }
  }

  const info = buildRequest(request, argv)
  const id = crypto.randomUUID()
  const pendingRequest: SudoRequest = { ...info, id }

  return await new Promise<AskpassResponse>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let done = false

    const finish = (response: AskpassResponse) => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      state.pending.delete(id)
      resolve(response)
    }

    const onAbort = () => {
      finish({ ok: false, error: "command ended" })
    }

    if (signal.aborted) {
      finish({ ok: false, error: "command ended" })
      return
    }

    signal.addEventListener("abort", onAbort, { once: true })
    timer = setTimeout(
      () => finish({ ok: false, error: "timed out" }),
      Math.max(5, options.timeout) * 1000,
    )
    state.pending.set(id, { request: pendingRequest, finish })
    audit(shared, {
      event: "request",
      command: pendingRequest.command,
      cwd: pendingRequest.cwd,
      sessionID: pendingRequest.sessionID,
    })
    emitAll(shared, pendingRequest)
  })
}

async function validatePassword(
  shared: Shared,
  password: string,
  signal: AbortSignal,
): Promise<boolean> {
  if (!shared.options.validate) return true
  const nonce = crypto.randomBytes(8).toString("hex")
  const helper = shared.runtime.writeValidationHelper(nonce)
  shared.state.validation = { nonce, password }
  try {
    const code = await runProcess(shared.runtime.sudoPath, ["-k", "-A", "-v"], {
      env: {
        ...process.env,
        SUDO_ASKPASS: helper,
        OPENCODE_SUDO_CONTEXT: "",
      },
      timeout: 20_000,
      signal,
    })
    return code === 0
  } finally {
    shared.state.validation = undefined
    try {
      fs.rmSync(helper, { force: true })
    } catch {
      // best effort
    }
  }
}

async function getShared(options: Config): Promise<Shared> {
  const store = globalThis as unknown as Record<PropertyKey, unknown>
  const existing = store[SHARED_KEY] as Shared | undefined
  if (existing) {
    existing.refs += 1
    existing.options = options
    return existing
  }

  const state: SharedState = {
    lastTuiSeen: 0,
    cache: undefined,
    validation: undefined,
    pending: new Map(),
    lastError: "",
  }
  const emits = new Set<(request: SudoRequest) => void>()
  let shared: Shared | undefined

  const runtime = await createRuntime({
    onRequest: (request, signal) =>
      shared
        ? handleAskpass(shared, request, signal)
        : Promise.resolve({ ok: false, error: "plugin starting" }),
  })

  shared = { refs: 1, runtime, options, state, emits }
  store[SHARED_KEY] = shared
  return shared
}

async function releaseShared(shared: Shared) {
  shared.refs -= 1
  if (shared.refs > 0) return

  const store = globalThis as unknown as Record<PropertyKey, unknown>
  if (store[SHARED_KEY] === shared) delete store[SHARED_KEY]

  for (const pending of Array.from(shared.state.pending.values())) {
    pending.finish({ ok: false, error: "plugin stopped" })
  }
  shared.state.pending.clear()
  shared.state.cache = undefined
  shared.state.validation = undefined
  shared.emits.clear()
  await shared.runtime.close()
}

function createHandlers(shared: Shared) {
  const mark = () => {
    shared.state.lastTuiSeen = Date.now()
  }

  return {
    hello: async () => {
      mark()
      return { ok: true }
    },
    pending: async () => {
      mark()
      const first = shared.state.pending.values().next().value as Pending | undefined
      return { request: first ? first.request : emptyRequest() }
    },
    unlock: async (
      input: unknown,
      call: { readonly signal: AbortSignal },
    ) => {
      mark()
      const value = (input ?? {}) as { requestID?: unknown; password?: unknown }
      const requestID = typeof value.requestID === "string" ? value.requestID : ""
      const password = typeof value.password === "string" ? value.password : ""
      const pending = shared.state.pending.get(requestID)
      if (!pending) return { ok: false, reason: "expired" }
      if (!password) return { ok: false, reason: "empty" }

      const valid = await validatePassword(shared, password, call.signal)
      if (!valid) {
        shared.state.lastError = "incorrect password"
        audit(shared, { event: "invalid", requestID, command: pending.request.command })
        return { ok: false, reason: "invalid" }
      }

      if (!shared.state.pending.has(requestID)) return { ok: false, reason: "expired" }

      shared.state.cache = {
        password,
        expiresAt: Date.now() + Math.max(0, shared.options.ttl) * 1000,
      }
      shared.state.lastError = ""
      pending.finish({ ok: true, value: password })
      audit(shared, {
        event: "unlock",
        requestID,
        command: pending.request.command,
        cwd: pending.request.cwd,
        sessionID: pending.request.sessionID,
      })
      return { ok: true, reason: "" }
    },
    cancel: async (input: unknown) => {
      mark()
      const value = (input ?? {}) as { requestID?: unknown }
      const requestID = typeof value.requestID === "string" ? value.requestID : ""
      const pending = shared.state.pending.get(requestID)
      if (!pending) return { ok: false }
      pending.finish({ ok: false, error: "cancelled by user" })
      shared.state.lastError = "cancelled"
      audit(shared, { event: "cancel", requestID, command: pending.request.command })
      return { ok: true }
    },
    lock: async () => {
      mark()
      shared.state.cache = undefined
      shared.state.lastError = ""
      await runProcess(shared.runtime.sudoPath, ["-K"], {
        env: process.env,
        timeout: 5000,
      })
      audit(shared, { event: "lock" })
      return { ok: true }
    },
    status: async (): Promise<SudoStatus> => {
      mark()
      return {
        policy: resolvePolicy(shared.options.policy),
        pending: shared.state.pending.size,
        cached: Boolean(shared.state.cache && shared.state.cache.expiresAt > Date.now()),
        expiresAt: shared.state.cache?.expiresAt ?? 0,
        tui: hasTui(shared),
        runtime: shared.runtime.dir,
        lastError: shared.state.lastError,
      }
    },
    setPolicy: async (input: unknown) => {
      mark()
      const value = (input ?? {}) as { policy?: unknown }
      const policy = value.policy
      if (policy !== "on" && policy !== "ask" && policy !== "off") {
        return { ok: false, policy: resolvePolicy(shared.options.policy) }
      }
      writePolicyFile(policy)
      shared.state.lastError = ""
      audit(shared, { event: "policy", policy })
      return { ok: true, policy }
    },
  }
}

export default Plugin.define({
  id: "opencode-sudo",
  async setup(ctx) {
    const options = readConfig(ctx.options as Record<string, unknown>)
    const shared = await getShared(options)
    const runtime = shared.runtime
    const disposers: Array<() => Promise<void>> = []

    try {
      const registration = await ctx.rpc.register(SudoRpc, createHandlers(shared))
      disposers.push(() => registration.dispose())

      const emit = (request: SudoRequest) => {
        try {
          void registration.events.emit("need", { request }).catch(() => {})
        } catch {
          // the location may be shutting down
        }
      }
      shared.emits.add(emit)
      disposers.push(async () => {
        shared.emits.delete(emit)
      })

      console.error(
        `[opencode-sudo] setup location=${ctx.location.directory} runtime=${runtime.dir} refs=${shared.refs}`,
      )

      const shell = await ctx.shell.hook("create.before", (event) => {
        const policy = resolvePolicy(shared.options.policy)
        const basePath =
          event.env.PATH ??
          process.env.PATH ??
          "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
        event.env.PATH = runtime.binDir + ":" + basePath
        event.env.OPENCODE_SUDO_CONTEXT = JSON.stringify({
          sessionID: event.env.OPENCODE_SESSION_ID ?? "",
          command: truncate(event.command, 4000),
          cwd: event.cwd,
        })
        event.env.OPENCODE_SUDO_FORCE = policy === "ask" ? "1" : "0"
      })
      disposers.push(() => shell.dispose())

      const permission = await ctx.permission.hook("evaluate", (event) => {
        if (event.action !== "shell") return
        if (!event.resources.some((resource) => hasSudoSite(resource))) return

        const policy = resolvePolicy(shared.options.policy)
        if (policy === "off") {
          event.effect = "deny"
          event.message = "sudo is disabled in OpenCode. Use `/sudo on` to enable it."
          return
        }
        if (!hasTui(shared)) {
          event.effect = "deny"
          event.message =
            "sudo requires interactive authentication in the OpenCode TUI. Run OpenCode in a terminal (not `opencode run`), or configure NOPASSWD for specific commands."
        }
      })
      disposers.push(() => permission.dispose())

      const tool = await ctx.tool.hook("execute.after", (event) => {
        const secret = shared.state.cache?.password
        if (secret) {
          if (event.status === "completed") {
            event.result = redactValue(event.result, secret) as typeof event.result
          } else {
            event.error = redactValue(event.error, secret) as typeof event.error
          }
        }

        if (event.tool !== "shell" && event.tool !== "bash") return
        const text = safeStringify(event.status === "completed" ? event.result : event.error)
        if (/Authentication failed|incorrect password|maximum \d+ incorrect/i.test(text)) {
          shared.state.cache = undefined
          shared.state.lastError = "authentication failed; unlock again"
          audit(shared, { event: "auth-failed", sessionID: event.sessionID })
        }
      })
      disposers.push(() => tool.dispose())

      const prompt = await ctx.session.hook("prompt", (event) => {
        const secret = shared.state.cache?.password
        if (secret) event.prompt.text = redactText(event.prompt.text, secret)
      })
      disposers.push(() => prompt.dispose())

      return async () => {
        await Promise.allSettled(disposers.map((dispose) => dispose()))
        await releaseShared(shared)
      }
    } catch (error) {
      await Promise.allSettled(disposers.map((dispose) => dispose()))
      await releaseShared(shared)
      throw error
    }
  },
})
