import assert from "node:assert/strict"
import test from "node:test"
import {
  displayCommand,
  formatCommand,
  hasResetFlag,
  parseArgv,
  shellQuote,
  stripSudoFlags,
  truncate,
} from "../src/command.js"

test("parseArgv splits NUL-separated /proc cmdline", () => {
  const raw = Buffer.from("/usr/bin/sudo\0-A\0systemctl\0restart\0docker.service\0")
  assert.deepEqual(parseArgv(raw), [
    "/usr/bin/sudo",
    "-A",
    "systemctl",
    "restart",
    "docker.service",
  ])
})

test("hasResetFlag only looks at sudo options", () => {
  assert.equal(hasResetFlag(["/usr/bin/sudo", "-A", "-k", "true"]), true)
  assert.equal(hasResetFlag(["/usr/bin/sudo", "--reset-timestamp", "true"]), true)
  assert.equal(hasResetFlag(["/usr/bin/sudo", "-A", "true", "-k"]), false)
  assert.equal(hasResetFlag(["/usr/bin/sudo", "-A", "-u", "root", "true"]), false)
  assert.equal(hasResetFlag(["/usr/bin/sudo", "-A", "true"]), false)
})

test("stripSudoFlags removes only the shim's leading flags", () => {
  assert.deepEqual(
    stripSudoFlags(["/usr/bin/sudo", "-A", "-k", "-u", "root", "id"]),
    ["/usr/bin/sudo", "-u", "root", "id"],
  )
  assert.deepEqual(stripSudoFlags(["/usr/bin/sudo", "-u", "root", "id"]), [
    "/usr/bin/sudo",
    "-u",
    "root",
    "id",
  ])
})

test("formatCommand shows a readable sudo command", () => {
  assert.equal(
    formatCommand(["/usr/bin/sudo", "-A", "systemctl", "restart", "docker.service"]),
    "sudo systemctl restart docker.service",
  )
  assert.equal(
    formatCommand(["/usr/bin/sudo", "-k", "-A", "-u", "root", "id"]),
    "sudo -u root id",
  )
  assert.equal(formatCommand(["/usr/bin/sudo", "-A"]), "sudo")
  assert.equal(formatCommand([], "sudo id"), "sudo id")
})

test("formatCommand quotes arguments with spaces", () => {
  assert.equal(
    formatCommand(["/usr/bin/sudo", "-A", "sh", "-c", "echo hi"]),
    "sudo sh -c 'echo hi'",
  )
})

test("displayCommand prefers the full shell command", () => {
  assert.equal(displayCommand("sudo -v", "sudo -v && sudo lsblk"), "sudo -v && sudo lsblk")
  assert.equal(displayCommand("sudo apt install x", "make install"), "make install")
  assert.equal(displayCommand("sudo true", "sudo -k true"), "sudo -k true")
  assert.equal(displayCommand("sudo true", "  "), "sudo true")
  assert.equal(displayCommand("sudo true", ""), "sudo true")
})

test("shellQuote handles empty and quoted strings", () => {
  assert.equal(shellQuote(""), "''")
  assert.equal(shellQuote("abc"), "abc")
  assert.equal(shellQuote("a b"), "'a b'")
  assert.equal(shellQuote("a'b"), "'a'\\''b'")
})

test("truncate keeps short text and adds an ellipsis", () => {
  assert.equal(truncate("abc", 10), "abc")
  assert.equal(truncate("abcdef", 4), "abc…")
})
