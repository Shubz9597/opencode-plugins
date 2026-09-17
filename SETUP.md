# Setup Guide (agent-friendly)

This document is written so an AI agent (or a human) can replicate the full
setup on a **new computer** by following it top to bottom.

## What this repo contains

| Path | What it is |
| --- | --- |
| `session-cost/` | opencode plugin: token & cost tracking, per-turn toast, `/cost-now` data tool |
| `remote-ui/` | opencode plugin: web UI (Tailscale-reachable) to drive opencode remotely, multi-project, SSE live updates |
| `commands/remote.md` | custom command: starts the remote UI from the TUI |
| `commands/cost-now.md` | custom command: prints a compact token/cost table |

## Agent setup checklist

Run through these steps in order. Adjust the repo clone path to the target
machine — below, `REPO` = the cloned location of this repository.

### 1. Prerequisites

- Node.js 22+ (`node --version`)
- opencode installed (`opencode --version`)
- Tailscale installed and logged in (`tailscale ip -4` prints a 100.x.x.x IP)
  - only needed for phone access; the UI falls back to localhost otherwise

### 2. Clone the repo

```
git clone https://github.com/Shubz9597/opencode-plugins.git
```

### 3. Global opencode config

Edit `~/.config/opencode/opencode.jsonc` (create it if missing) so it contains:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "lsp": true,
  "plugin": [
    "REPO/session-cost/src/index.ts",
    [
      "REPO/remote-ui/src/index.ts",
      {
        "autoStart": true,
        "projects": ["C:/path/to/project-a", "C:/path/to/project-b"]
      }
    ]
  ],
  "provider": {
    "zai": {
      "models": {
        "glm-5.3-flash": {
          "cost": { "input": 0.15, "output": 0.5, "cache_read": 0.03, "cache_write": 0 }
        }
      }
    }
  }
}
```

Notes for the agent:
- Replace every `REPO` with the absolute clone path (forward slashes).
- `projects` = absolute paths of the folders the user wants to manage from the
  phone. Ask the user which ones; the plugin's own directory is always included.
- The `provider.zai` block corrects stale GLM-5.3-Flash rates (models.dev lists
  half of Z.AI's official price). Keep it if the user uses Z.AI; otherwise drop it.
- `autoStart: true` makes the web UI bind as soon as opencode/`opencode serve`
  starts. Set it to `false` if the user prefers starting it via `/remote`.

### 4. Custom commands

Copy both files from `commands/` into the global command directory
(create it if missing):

- `commands/remote.md` → `~/.config/opencode/command/remote.md`
- `commands/cost-now.md` → `~/.config/opencode/command/cost-now.md`

(`~` on Windows is `C:\Users\<user>`.)

### 5. Restart & verify

1. Fully quit any running opencode, then start `opencode serve` in any folder
   (or open the TUI normally and type `/remote`).
2. With `autoStart`, the console log shows the URL, e.g.
   `http://100.x.y.z:4410`. Port auto-falls-forward (4410, 4411, …) if 4409 is
   busy — every instance gets its own UI.
3. Open the URL from a device on the same Tailscale network.
4. Verify:
   - Session accordion lists the configured projects as chips
   - Sending a message creates/continues a session in that project
   - After the first reply, a cost toast appears (TUI) and `/cost-now` prints
     a token/cost table

## Daily usage

- **Headless orchestrator** (phone-first, no opencode window): run
  `opencode serve` in any folder, keep the console open, use the phone UI for
  everything. Sessions across all `projects` run in parallel there.
- **Desktop mode**: open the opencode TUI in a project as usual; type
  `/remote` to expose it; type `/cost-now` for the spend table.
- Sessions are stored on disk per project — both modes see the same history.
  Don't drive the *same session* from the TUI and the web UI simultaneously.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Clipboard (📋 paste button) blocked | Browser restriction: clipboard read needs HTTPS; use Ctrl+V in the message box or 📎 instead |
| Model pill shows a different model than expected | It mirrors the session's actual model; change models in the TUI/config, not the UI (locked on purpose) |
| UI looks stale after editing `remote-ui/src/ui.html` | Browser refresh — the HTML is served fresh per request; but any `src/index.ts` change needs an opencode restart |
| `opencode serve` + UI unreachable from phone | Confirm Tailscale is up on both devices and the URL uses the 100.x IP, not localhost |
| Cost numbers differ from Z.AI dashboard | Non-token charges (e.g. web search $0.01/use) aren't token-based; also dashboard lag |
