# opencode-remote-ui

A mobile-friendly web UI for [opencode](https://opencode.ai), served from your
own machine and designed to be reached over **Tailscale** — so you can send
messages to your opencode sessions from your phone or any other device on your
tailnet.

The plugin auto-detects your Tailscale IPv4 (`tailscale ip -4`) and binds only
to that interface, so the UI is reachable inside your tailnet but not from the
public internet.

## Features

- Session picker + new sessions
- **Markdown rendering** for replies (marked + DOMPurify, with a plain-text
  fallback when offline) — code blocks, tables, links, lists
- **File attachments** — 📎 button, images preview inline in chat and in
  history; other files are sent to opencode and shown as chips
- **Model & agent pickers** — populated live from your config
- **Slash commands** — type `/command args` to run an opencode command
- **Shell mode** — type `!cmd` to run a shell command in the session
- **Permission approval** — when a remote run needs a permission, an
  Allow-once / Always / Deny banner appears so it never gets stuck
- Busy indicator, Stop button to abort a running turn
- Per-message cost + model shown under assistant replies
- Optional shared-token auth

## Install

Add to your `opencode.json` and restart opencode:

```json
{
  "plugin": ["D:/Projects/opencode-plugins/remote-ui/src/index.ts"]
}
```

The plugin loads with opencode but **does not open a port until you ask**.

## Usage

### `/remote` command (recommended)

Create `~/.config/opencode/command/remote.md`:

```markdown
---
description: Start the opencode remote UI so you can send messages from your phone or another device
---

Call the `remote` tool to start the opencode remote UI web server. Do not ask
me any questions — just call the tool, then reply with:

1. The URL to open (shown in the tool result).
2. One line telling me to open it from any device on the same Tailscale network.
```

Then type `/remote` in the TUI. You can also just ask the model to
"start the remote UI" — it has access to the same `remote` tool.

### Auto-start

Prefer the old always-on behavior? Set `autoStart: true`:

```json
{
  "plugin": [
    ["D:/Projects/opencode-plugins/remote-ui/src/index.ts", { "autoStart": true }]
  ]
}
```

Either way, once started you get a toast with the URL, e.g.
`http://100.101.102.103:4409` — open it from any device on your tailnet.

| Option  | Default     | Description                                                                 |
| ------- | ----------- | --------------------------------------------------------------------------- |
| `port`  | `4409`      | HTTP port                                                                    |
| `host`  | `"tailscale"` | `"tailscale"` (auto-detected 100.x IP), `"localhost"`, or an explicit host |
| `token` | —           | Shared secret required via `?token=` or `x-opencode-token` header           |
| `agent` | `"build"`   | Agent used for prompts sent from the UI                                     |
| `autoStart` | `false` | Start the server when opencode loads instead of on `/remote`                 |

## Security notes

- Default binding is the Tailscale interface only — devices outside your
  tailnet cannot reach it.
- If you change `host` to `0.0.0.0` or a LAN IP, **set a `token`** — the UI can
  read sessions and run arbitrary prompts in your project.
- There is currently no TLS; traffic rides inside WireGuard when accessed over
  Tailscale, which is already encrypted in transit.

## Requirements

- `tailscale` CLI on PATH for auto-detection (otherwise it falls back to
  `127.0.0.1`, or set `host` explicitly).
- The opencode TUI/server must be running for the UI to be up.
