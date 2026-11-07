import crypto from "node:crypto"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { shellQuote } from "./command.js"
import { which } from "./policy.js"

export interface AskpassRequest {
  readonly pid: number
  readonly ppid: number
  readonly prompt: string
  readonly context: string
  readonly sessionID: string
  readonly validate: string
}

export interface AskpassResponse {
  readonly ok: boolean
  readonly value?: string
  readonly error?: string
}

export interface RuntimeOptions {
  onRequest(request: AskpassRequest, signal: AbortSignal): Promise<AskpassResponse>
}

export interface Runtime {
  readonly dir: string
  readonly binDir: string
  readonly socketPath: string
  readonly askpassPath: string
  readonly sudoPath: string
  writeValidationHelper(nonce: string): string
  close(): Promise<void>
}

const ASKPASS_TIMEOUT_SECONDS = 180
const MAX_REQUEST_BYTES = 64 * 1024

function writeExecutable(file: string, content: string) {
  fs.writeFileSync(file, content, { mode: 0o700 })
  fs.chmodSync(file, 0o700)
}

function askpassSource(socketPath: string, validate: string) {
  return `#!/usr/bin/python3
import json
import os
import socket
import sys

SOCKET_PATH = ${JSON.stringify(socketPath)}
VALIDATE = ${JSON.stringify(validate)}


def fail(message):
    sys.stderr.write("opencode-sudo: " + message + "\\n")
    sys.exit(1)


def main():
    try:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(${ASKPASS_TIMEOUT_SECONDS})
        sock.connect(SOCKET_PATH)
        request = {
            "pid": os.getpid(),
            "ppid": os.getppid(),
            "prompt": sys.argv[1] if len(sys.argv) > 1 else "",
            "context": os.environ.get("OPENCODE_SUDO_CONTEXT", ""),
            "sessionID": os.environ.get("OPENCODE_SESSION_ID", ""),
            "validate": VALIDATE,
        }
        sock.sendall((json.dumps(request) + "\\n").encode("utf-8"))
        data = b""
        while not data.endswith(b"\\n"):
            chunk = sock.recv(4096)
            if not chunk:
                break
            data += chunk
            if len(data) > ${MAX_REQUEST_BYTES}:
                fail("response too large")
        if not data:
            fail("no response from OpenCode")
        response = json.loads(data.decode("utf-8"))
        if response.get("ok") is not True:
            fail(str(response.get("error") or "authentication denied"))
        value = response.get("value")
        if not isinstance(value, str):
            fail("invalid response")
        sys.stdout.buffer.write((value + "\\n").encode("utf-8"))
        sys.stdout.buffer.flush()
    except SystemExit:
        raise
    except Exception as error:
        fail(str(error))


if __name__ == "__main__":
    main()
`
}

function shimSource(sudoPath: string, askpassPath: string, socketPath: string) {
  return `#!/bin/sh
export SUDO_ASKPASS=${shellQuote(askpassPath)}
export OPENCODE_SUDO_SOCK=${shellQuote(socketPath)}
if [ "\${OPENCODE_SUDO_FORCE:-0}" = "1" ]; then
  exec ${shellQuote(sudoPath)} -k -A "$@"
fi
exec ${shellQuote(sudoPath)} -A "$@"
`
}

function normalizeRequest(raw: unknown): AskpassRequest {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
  const pid = Number(value.pid)
  const ppid = Number(value.ppid)
  return {
    pid: Number.isFinite(pid) ? pid : 0,
    ppid: Number.isFinite(ppid) ? ppid : 0,
    prompt: typeof value.prompt === "string" ? value.prompt : "",
    context: typeof value.context === "string" ? value.context : "",
    sessionID: typeof value.sessionID === "string" ? value.sessionID : "",
    validate: typeof value.validate === "string" ? value.validate : "",
  }
}

export async function createRuntime(options: RuntimeOptions): Promise<Runtime> {
  const base =
    process.env.XDG_RUNTIME_DIR ||
    path.join(os.tmpdir(), `opencode-sudo-${process.getuid?.() ?? "user"}`)
  const instance = `${process.pid}-${crypto.randomBytes(4).toString("hex")}`
  const dir = path.join(base, "opencode-sudo", instance)
  const binDir = path.join(dir, "bin")
  const socketPath = path.join(dir, "agent.sock")
  const askpassPath = path.join(dir, "askpass.py")

  if (socketPath.length > 100) {
    throw new Error(`opencode-sudo: socket path too long: ${socketPath}`)
  }

  fs.mkdirSync(binDir, { recursive: true, mode: 0o700 })
  fs.chmodSync(path.join(base, "opencode-sudo"), 0o700)
  fs.chmodSync(dir, 0o700)
  fs.chmodSync(binDir, 0o700)

  const resolved = which("sudo")
  const sudoPath = resolved.startsWith("/") ? resolved : "/usr/bin/sudo"

  writeExecutable(askpassPath, askpassSource(socketPath, ""))
  writeExecutable(path.join(binDir, "sudo"), shimSource(sudoPath, askpassPath, socketPath))

  const writeValidationHelper = (nonce: string) => {
    const file = path.join(dir, `askpass-${nonce}.py`)
    writeExecutable(file, askpassSource(socketPath, nonce))
    return file
  }

  fs.rmSync(socketPath, { force: true })
  const server = net.createServer((socket) => {
    let buffer = ""
    let handled = false
    const controller = new AbortController()

    const finish = (response: AskpassResponse) => {
      if (handled) return
      handled = true
      try {
        socket.end(JSON.stringify(response) + "\n")
      } catch {
        // the helper may have gone away
      }
    }

    socket.setEncoding("utf8")
    socket.on("data", (chunk: string) => {
      if (handled) return
      buffer += chunk
      if (buffer.length > MAX_REQUEST_BYTES) {
        finish({ ok: false, error: "request too large" })
        return
      }
      const newline = buffer.indexOf("\n")
      if (newline === -1) return
      const line = buffer.slice(0, newline)
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        finish({ ok: false, error: "invalid request" })
        return
      }
      const request = normalizeRequest(parsed)
      Promise.resolve()
        .then(() => options.onRequest(request, controller.signal))
        .then(finish, (error) => {
          finish({ ok: false, error: error instanceof Error ? error.message : String(error) })
        })
    })
    socket.on("error", () => controller.abort())
    socket.on("close", () => controller.abort())
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once("error", onError)
    server.listen(socketPath, () => {
      server.off("error", onError)
      resolve()
    })
  })

  fs.chmodSync(socketPath, 0o600)
  server.on("error", (error) => {
    console.error("[opencode-sudo] socket error:", error)
  })

  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    try {
      server.closeAllConnections?.()
    } catch {
      // not available in every runtime
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1000)
      try {
        server.close(() => {
          clearTimeout(timer)
          resolve()
        })
      } catch {
        clearTimeout(timer)
        resolve()
      }
    })
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // best effort
    }
  }

  return {
    dir,
    binDir,
    socketPath,
    askpassPath,
    sudoPath,
    writeValidationHelper,
    close,
  }
}
