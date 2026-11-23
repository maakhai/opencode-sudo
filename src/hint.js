/**
 * Compact sudo availability note injected into the model context.
 *
 * @typedef {"once" | "always" | "off"} HintMode
 * @typedef {"on" | "ask" | "off"} Policy
 */

/**
 * @param {object} options
 * @param {HintMode} options.mode
 * @param {Policy} options.policy
 * @param {boolean} options.tui
 * @param {boolean} [options.seen]
 * @returns {string | undefined}
 */
export function sudoHint({ mode, policy, tui, seen = false }) {
  if (mode === "off") return undefined
  if (mode !== "always" && seen) return undefined
  if (policy === "off") return "sudo: disabled."
  if (!tui) return "sudo: unavailable without TUI."
  return "sudo: plain sudo prompts in TUI; avoid -n."
}
