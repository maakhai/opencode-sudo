# opencode-sudo

**Version 0.2.0** · [Changelog](CHANGELOG.md)

OpenCode v2 plugin that asks for the `sudo` password in a TUI window, showing
exactly which command will run. The password goes straight to sudo — it never
enters the chat, the model context, or the plugin logs.

```text
╭─────────────────────────────────────────────────────────────╮
│                                                             │
│  OpenCode wants to run as root.                             │
│                                                             │
│  COMMAND                                                    │
│  ▌ sudo systemctl restart docker.service                    │
│                                                             │
│  Directory  ~/projects/my-project                           │
│  Session    my-session · user@host                          │
│                                                             │
│  [sudo] password for user: ••••••••••▏                      │
│                                                             │
│  [enter] Authorize    [esc] Cancel                          │
│                                                             │
╰─────────────────────────────────────────────────────────────╯
```

## Requirements

- OpenCode v2 (tested with 2.2.x).
- Linux with `sudo` (tested with `sudo-rs`).
- Python 3 — the askpass is a dependency-free Python script.
- The OpenCode TUI; `opencode run` cannot show the window.

## Installation

1. Clone the plugin next to your global OpenCode config:

```sh
git clone https://github.com/maakhai/opencode-sudo.git ~/.config/opencode/opencode-sudo
```

2. Add it to `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["./opencode-sudo"]
}
```

The relative path resolves from the config file; there is no build step, as
OpenCode transpiles the TypeScript sources when loading the plugin.

3. Confirm it loaded:

```sh
opencode plugin list
```

The output should list `opencode-sudo` with source
`/home/<you>/.config/opencode/opencode-sudo`. If it is missing, run `/reload`
in the TUI; if it still does not appear, run `opencode service restart`.

To set options, use the object form described in [Configuration](#configuration).

## Usage

Use `sudo` normally. On the first command that needs a password, the framed
window opens with the exact command. Authorize with `enter` or by clicking
**Authorize**; cancel with `esc` or **Cancel**. To test safely:

> Ask the agent to run `sudo -k true`.

When sudo runs inside a script, the window also shows the outer command (for
example `via make install`) below the real sudo command.

### TUI commands

| Command | Effect |
| --- | --- |
| `/sudo` or `/sudo status` | policy, TUI, cache, pending requests, instance |
| `/sudo on` | window when sudo asks for a password (default) |
| `/sudo ask` | window for **every** sudo command (shim adds `-k`) |
| `/sudo off` | deny any sudo command before it runs |
| `/sudo lock` | clear the cache and run `sudo -K` |

Never type your password after `/sudo ` — use the window field.

### Without a TUI

`opencode run` and other headless servers cannot use sudo. The command fails in
about 1s with:

```text
sudo requires interactive authentication in the OpenCode TUI. Run OpenCode in
a terminal (not `opencode run`), or configure NOPASSWD for specific commands.
```

For headless automation, use a short `NOPASSWD` list in sudoers.

## Configuration

| Option | Default | Description |
| --- | --- | --- |
| `policy` | `on` | `on` (when sudo asks), `ask` (every command), `off` (deny) |
| `timeout` | `120` | seconds the window waits for an answer |
| `ttl` | `900` | seconds of the in-memory cache (15 min) |
| `validate` | `true` | validate with `sudo -k -A -v` before releasing |
| `notify` | `true` | notification/sound when the window opens unfocused |
| `audit` | `false` | write JSONL to `~/.local/state/opencode-sudo/audit.jsonl` |

To set options, replace the string entry with
`{ "package": "./opencode-sudo", "options": { "policy": "ask" } }`.

`audit` records the command, cwd, session, decision, and time; **never** the
password. The policy can also come from `~/.config/opencode/sudo-policy` (`on`,
`ask`, or `off`); `OPENCODE_SUDO_POLICY` overrides both the file and the option.

## How it works

- **Shim**: a private `bin/sudo` sets `SUDO_ASKPASS` and calls the real sudo.
  The server reads the exact command and cwd from `/proc/<pid>/`.
- **TUI**: a masked modal receives the password, validates it with
  `sudo -k -A -v`, and returns it over a 0600 Unix socket.
- **Safety**: the password stays in memory, is redacted from tool output, and
  is cached for 15 minutes.

## Security

- The password lives in memory in the TUI and server processes and travels over
  a local 0600 socket. It is never written to disk, the session, or model
  history. TUI↔server RPC is local HTTP; do not unlock a remote server without
  TLS.
- This is a UX and accidental-leak gate, not a privilege boundary. A user in
  the `docker` or `lxd` group already has effective root by other paths.
- The displayed command comes from `/proc`, not the model's text, but the agent
  still controls it. Read the window before authorizing.
- The 15-minute cache allows new sudo commands without a prompt; use
  `/sudo ask` or `/sudo lock` to tighten it. The shim only covers OpenCode's
  shell tool, not MCP servers, external terminals, or the `!` shell mode.

## Development

```sh
node --test test/*.test.js
```

Tests cover command-position sudo detection, `/proc/<pid>/cmdline` parsing,
policy precedence, the state file, and redaction.

Manual check:

1. `opencode plugin list` shows `opencode-sudo`.
2. Ask the agent to run `sudo -k true`; the framed window shows the command and
   a masked field. Authorize with `enter` or the **Authorize** button.
3. A wrong password shows “incorrect password”; typing clears it. The right
   password runs the command.
4. `esc` or **Cancel** fails the command with “cancelled by user”.
   `/sudo lock` forces a new prompt; `/sudo off` denies the next command;
   `opencode run "sudo -n true"` fails fast without a TUI.

## Layout

| Path | Role |
| --- | --- |
| `src/index.ts` | Server: singleton, hooks, RPC handlers |
| `src/tui.tsx` | Framed masked modal, clickable actions, polling, `/sudo` |
| `src/rpc.ts` | RPC contract |
| `src/runtime.ts`, `src/*.js` | Shim, askpass, socket, scanner, policy, redaction |
| `test/` | Unit tests |
| `CHANGELOG.md` | Release history |

## License

MIT. `src/scanner.js` is adapted from
[fitzypopper/opencode-sudo-plugin](https://github.com/fitzypopper/opencode-sudo-plugin)
(MIT); the rest is MIT.
