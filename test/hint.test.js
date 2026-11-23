import assert from "node:assert/strict"
import test from "node:test"
import { sudoHint } from "../src/hint.js"

const base = { mode: "once", policy: "on", tui: true, seen: false }

test("returns nothing when disabled", () => {
  assert.equal(sudoHint({ ...base, mode: "off" }), undefined)
})

test("uses the compact TUI hint for on and ask", () => {
  assert.equal(sudoHint(base), "sudo: plain sudo prompts in TUI; avoid -n.")
  assert.equal(sudoHint({ ...base, policy: "ask" }), "sudo: plain sudo prompts in TUI; avoid -n.")
})

test("reports a disconnected TUI", () => {
  assert.equal(sudoHint({ ...base, tui: false }), "sudo: unavailable without TUI.")
})

test("reports a disabled policy", () => {
  assert.equal(sudoHint({ ...base, policy: "off" }), "sudo: disabled.")
})

test("once stops after the first sudo", () => {
  assert.equal(sudoHint({ ...base, seen: true }), undefined)
})

test("always ignores seen", () => {
  assert.equal(
    sudoHint({ ...base, mode: "always", seen: true }),
    "sudo: plain sudo prompts in TUI; avoid -n.",
  )
})
