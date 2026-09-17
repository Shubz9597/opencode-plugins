# opencode-plugins

Custom plugins for [opencode](https://opencode.ai).

> New machine? Follow [`SETUP.md`](./SETUP.md) — it's written so an agent can
> replicate the whole setup from a single prompt: *"Set up opencode plugins by
> following SETUP.md in this repo."*

| Plugin                                                     | Description                                                                 |
| ---------------------------------------------------------- | --------------------------------------------------------------------------- |
| [`session-cost`](./session-cost)                            | Token in/out + cost tracking per response and per session, toast at end of each chat turn |
| [`remote-ui`](./remote-ui)                                  | Tailscale-reachable web UI to drive opencode remotely: multi-project sessions, markdown rendering, file attachments, SSE live updates, permission approval |

## Usage

See each plugin's README. Both plugins are already registered in the global
config (`~/.config/opencode/opencode.jsonc`) via absolute paths, so they load
in every project. The remote UI starts on demand — type `/remote` in the TUI
(or ask the model to start the remote UI).

Restart opencode after any config change — plugins load at startup only.
