/**
 * Helpers for turning the sudo process argv (read from /proc) into the command
 * shown in the TUI. The dialog must show what will actually run, not just the
 * outer shell command the model wrote.
 */

const SAFE_ARG = /^[A-Za-z0-9_@%+=:,./-]+$/

/**
 * @param {string} value
 */
export function shellQuote(value) {
  if (value === "") return "''"
  if (SAFE_ARG.test(value)) return value
  return "'" + value.replaceAll("'", "'\\''") + "'"
}

/**
 * @param {Buffer | string} raw
 * @returns {string[]}
 */
export function parseArgv(raw) {
  const text = typeof raw === "string" ? raw : raw.toString("utf8")
  return text.split("\0").filter((part) => part.length > 0)
}

/**
 * True when the sudo command itself carries -k/--reset-timestamp before the
 * command word. The plugin uses this to bypass its own in-memory cache, so
 * `sudo -k ...` still prompts like the system sudo would.
 *
 * @param {string[]} argv
 * @returns {boolean}
 */
export function hasResetFlag(argv) {
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === "--") break
    if (!arg.startsWith("-")) break
    if (arg === "-k" || arg === "--reset-timestamp") return true
  }
  return false
}

/**
 * Remove the flags the shim adds for its own plumbing. Keep everything else,
 * including `-u`, `-g`, `-i`, `--`, env assignments, and `--preserve-env`.
 *
 * @param {string[]} argv
 * @returns {string[]}
 */
export function stripSudoFlags(argv) {
  const args = [...argv]
  let index = 1
  while (index < args.length) {
    const arg = args[index]
    if (arg === "-A" || arg === "--askpass" || arg === "-k" || arg === "--reset-timestamp") {
      args.splice(index, 1)
      continue
    }
    break
  }
  return args
}

/**
 * @param {string} text
 * @param {number} max
 */
export function truncate(text, max) {
  if (text.length <= max) return text
  return text.slice(0, Math.max(0, max - 1)) + "…"
}

/**
 * Prefer the full shell command that triggered sudo, falling back to the sudo
 * argv when no context is available. The dialog shows only one command block.
 *
 * @param {string} command
 * @param {string} context
 * @returns {string}
 */
export function displayCommand(command, context) {
  const value = typeof context === "string" ? context.trim() : ""
  return value || command
}

/**
 * @param {string[]} argv
 * @param {string} [fallback]
 * @returns {string}
 */
export function formatCommand(argv, fallback = "sudo") {
  if (!Array.isArray(argv) || argv.length === 0) return fallback
  const args = stripSudoFlags(argv)
  if (args.length === 0) return "sudo"
  const first = args[0]
  if (first === "sudo" || first.endsWith("/sudo")) args[0] = "sudo"
  return args
    .map((arg, index) => (index === 0 ? arg : shellQuote(arg)))
    .join(" ")
}
