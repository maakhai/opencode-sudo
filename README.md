# opencode-sudo

[OpenCode](https://opencode.ai) (v2) plugin that asks for the `sudo` password
in a TUI window, showing **exactly which command will run**. The password goes
straight to `sudo`: it never enters the chat, the model context, or the plugin
logs.

```text
╭─ Sudo authentication ───────────────────────────────────────╮
│                                                             │
│  OpenCode wants to run as root:                             │
│                                                             │
│  sudo systemctl restart docker.service                      │
│                                                             │
│  Directory: ~/projects/my-project                           │
│  Session: my-session · user@host                            │
│                                                             │
│  Password: ••••••••••                                       │
│                                                             │
│  enter authorize   esc cancel                               │
╰─────────────────────────────────────────────────────────────╯
```

## Why it exists

OpenCode's shell tool runs without a TTY. When the agent calls `sudo`, sudo has
nowhere to ask for the password and fails with
`a terminal is required to authenticate`. This plugin creates a local
`SUDO_ASKPASS` and shows a TUI modal so you can authorize the command without
pasting the password into the conversation.

## Features

- Shows the **real** command read from `/proc/<sudo-pid>/cmdline` and the
  directory from `/proc/<pid>/cwd`. Works even when `sudo` is inside a script
  (`make install` → the window shows the inner `sudo apt install ...`).
- Masked password field (`•`); `enter` authorizes, `esc` cancels.
- Validates the password with `sudo -k -A -v` before releasing it. A wrong
  password shows the error in the window itself and lets you try again.
- 15-minute in-memory cache; the window appears when sudo would actually prompt
  for a password, as on the desktop.
- `on` / `ask` / `off` policy and manual lock via `/sudo`.
- Without a TUI (`opencode run`), sudo is denied with a clear message; there is
  no password-file fallback.
- Redacts the password if it accidentally appears in tool output or in the user
  prompt.

## Requirements

- OpenCode v2 (tested with 2.2.x).
- Linux with `sudo` (tested with `sudo-rs`).
- Python 3 on the host — the askpass is a dependency-free Python script.
- The OpenCode TUI. `opencode run` cannot show the window.

## Installation

Clone the repository into any directory (replace `<your-user>` with the
repository owner):

```sh
git clone https://github.com/<your-user>/opencode-sudo.git ~/projects/opencode-sudo
```

Add the plugin to the global `~/.config/opencode/opencode.jsonc`. Adjust the
path to where you cloned it:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/path/to/opencode-sudo",
      "options": {
        "policy": "on",
        "timeout": 120,
        "ttl": 900,
        "validate": true,
        "notify": true,
        "audit": false
      }
    }
  ],
}
```

Verify that the plugin loaded:

```sh
opencode plugin list
```

The output should include `opencode-sudo`. If the command does not appear in
the TUI, run `/reload` or restart the service with
`opencode service restart`.

There is no build step: OpenCode transpiles `src/index.ts` and `src/tui.tsx` at
load time. `@opencode/plugin` is resolved by the OpenCode runtime.

## Usage

The agent uses `sudo` normally. On the first command that needs a password, the
window appears. To test safely:

> Ask the agent to run `sudo -k true`.

The window shows the command; type the password and the command runs as root.
The result goes back to the agent, but the password does not.

### TUI commands

| Command | Effect |
| --- | --- |
| `/sudo` or `/sudo status` | shows policy, TUI, cache, pending requests, and instance |
| `/sudo on` | window when sudo asks for a password (default) |
| `/sudo ask` | window for **every** sudo command (the shim adds `-k`) |
| `/sudo off` | denies any command containing sudo before it runs |
| `/sudo lock` | clears the cache and runs `sudo -K` to reset the timestamp |

`/sudo` does not send the typed text to the conversation. Even so, **never type
your password after `/sudo `** — use the window field.

### Without a TUI

`opencode run` (or any server without a TUI) cannot use sudo. The command fails
in about 1s with:

```text
sudo requires interactive authentication in the OpenCode TUI. Run OpenCode in
a terminal (not `opencode run`), or configure NOPASSWD for specific commands.
```

If you need headless automation, the alternative is a short `NOPASSWD` list in
sudoers — outside the plugin's scope.

## Configuration

| Option | Default | Description |
| --- | --- | --- |
| `policy` | `on` | `on` (when sudo asks), `ask` (every command), `off` (deny) |
| `timeout` | `120` | seconds the window waits for an answer |
| `ttl` | `900` | seconds of the in-memory cache (15 min) |
| `validate` | `true` | validates with `sudo -k -A -v` before releasing |
| `notify` | `true` | notification/sound when the window opens unfocused |
| `audit` | `false` | writes JSONL to `~/.local/state/opencode-sudo/audit.jsonl` |

`audit` records the command, cwd, session, decision, and time; **never** the
password.

The policy can also be changed through the file
`~/.config/opencode/sudo-policy` (`on`, `ask`, or `off`). The
`OPENCODE_SUDO_POLICY` environment variable takes precedence over the file and
the option.

## How it works

```text
agent → shell tool → bin/sudo (shim) → /usr/bin/sudo -A
                                           │
                                     SUDO_ASKPASS
                                           │
                                    askpass.py → 0600 socket
                                           │
                                    plugin server
                                           │
                              reads /proc/<pid>/cmdline + cwd
                                           │
                                    TUI modal (RPC)
                                           │
                              validates with sudo -k -A -v
                                           │
                                    returns password to sudo
```

- **Server** (`src/index.ts`): singleton shared across locations of the same
  process; creates the runtime in
  `$XDG_RUNTIME_DIR/opencode-sudo/<pid>-<random>/` (0700), with `bin/sudo`,
  `askpass.py`, and `agent.sock` (0600). Registers the shell, permission, tool,
  and prompt hooks, and keeps the cache in memory.
- **RPC** (`src/rpc.ts`): `hello`, `pending`, `unlock`, `cancel`, `lock`,
  `status`, `setPolicy`; `need` event.
- **TUI** (`src/tui.tsx`): 2s heartbeat, 1s `pending` polling, custom modal
  (OpenCode 2.2.5's `dialog.prompt` has no masking), queue, notification, and
  the `/sudo` command.
- **Validation**: the server generates a temporary askpass helper with a nonce,
  runs `sudo -k -A -v`, and only releases the password if the exit code is 0.
  The temporary helper is removed afterwards.
- **Redaction**: the cached password is replaced with `[REDACTED]` in tool
  results and prompts. It is an accident safeguard; the password is never
  written to disk.

## Security

- The password stays in memory in the TUI and the server process, and travels
  over the local socket (0600) to the askpass. It is not written to disk, the
  session, or the model history.
- The plugin is a **UX and accidental-leak gate**, not a privilege boundary. The
  agent runs as your user; if that user is in groups such as `docker` or `lxd`,
  it can already obtain effective root through other paths. A real boundary
  would require a sandbox or removing those groups.
- The command shown comes from `/proc`, not from the model's text. Even so, the
  agent controls the command; read the window before authorizing.
- The TUI↔server RPC is HTTP on `127.0.0.1`. Do not use TUI unlock connected to
  a remote server without TLS.
- The 15-minute cache means that, within that window, new `sudo` commands may
  run without a new window. Use `/sudo ask` to require confirmation for every
  command or `/sudo lock` to end the window.
- The plugin applies to OpenCode's shell tool. MCP servers, external terminals,
  and the TUI's `!` shell mode do not inherit the shim.

## Development

```sh
node --test test/*.test.js
```

Current tests: command-position sudo scanner, `/proc/<pid>/cmdline` parse/quote,
policy precedence, state file, and redaction.

Full manual test:

1. `opencode plugin list` shows `opencode-sudo`.
2. Ask the agent to run `sudo -k true`; the window opens with the command and
   the `•••` field.
3. Type the password; the command runs and the agent receives the result.
4. Wrong password: the window shows “incorrect password” and lets you try again.
5. `esc`: the command fails with “cancelled by user”.
6. `/sudo lock`: the cache clears; the next sudo prompts again.
7. `/sudo off`: the command is denied before it runs.
8. `opencode run "run sudo -n true"`: fails fast with the no-TUI message.

## Layout

```text
opencode-sudo/
  package.json
  README.md
  src/
    index.ts      server plugin (singleton, hooks, RPC handlers)
    tui.tsx       masked modal, polling, and /sudo
    rpc.ts        RPC contract
    runtime.ts    runtime dir, shim, askpass, and Unix socket
    command.js    /proc parse/format
    policy.js     on/ask/off and state file
    scanner.js    command-position sudo detection
    redact.js     password redaction
  test/
    scanner.test.js
    command.test.js
    policy.test.js
    redact.test.js
```

## License

MIT. `src/scanner.js` is adapted from
[fitzypopper/opencode-sudo-plugin](https://github.com/fitzypopper/opencode-sudo-plugin)
(MIT); the rest is MIT.
