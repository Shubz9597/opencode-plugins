# Cost sidebar, shared sessions and phone scrolling

## What changed

- `session-cost/src/tui.tsx` adds **Session usage** to the existing TUI sidebar: input, output, reasoning, cached read, cache write and total session cost. Token categories remain separate. Recomputed prices are labelled `est.`; missing prices are not treated as free usage.
- Totals load the complete paginated session history and update by message ID. Repeated events and late accounting corrections do not add a message twice. Navigation cancels old loads, and polling recovers missed events.
- `remote-ui/src/ui.html` preserves message DOM elements during updates. Adding a message no longer clears and rebuilds the transcript. Reading position is anchored while earlier messages change, and following remains enabled only when appropriate. Polls for one view are serialized to prevent older responses overwriting newer content.
- Permission/question requests use the current SDK with the original authenticated transport. Both protocol families are reconciled from runtime lists. Replies use their owning session/project; failed replies retain the prompt. Multi-question/multiple-choice answers use the correct answer matrix. A failed answer never silently rejects a question.

## Installed here

OpenCode **1.18.31** is installed. The TUI sidebar was enabled in:

`C:/Users/PC/.config/opencode/tui.json`

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["Z:/Projects/opencode-plugins/session-cost/src/tui.tsx"]
}
```

The server plugin and TUI plugin have separate entrypoints. Keep the existing server plugins in `opencode.json`; the new sidebar belongs in `tui.json`. No new application folder or OpenCode source fork is needed for this sidebar. See the [OpenCode TUI plugin reference](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/opencode/specs/tui-plugins.md).

## Start one backend and attach the terminal

Restart the existing server after updating its plugins. In terminal 1, inside the project you want to work on:

```powershell
cd Z:\Projects\opencode-plugins
opencode serve --hostname 127.0.0.1 --port 4096
```

In terminal 2:

```powershell
opencode attach http://127.0.0.1:4096 --dir "Z:\Projects\opencode-plugins" --continue
```

For a specific session, replace `--continue` with `--session <session-id>`. Replace the directory in both commands when working on another project. `opencode --continue` alone does not explicitly connect to the server started in terminal 1.

Start the existing `/remote` command/tool in that attached session, or use the remote plugin's existing `autoStart` setting. Open the URL it returns on your phone and select the same project and session ID. The phone uses the remote bridge's URL (normally Tailscale port 4409); terminal attach uses the OpenCode backend on 4096. Reload the phone page after restarting the server so it loads the new JavaScript. Open the TUI sidebar if it is hidden.

Backend execution is shared; TUI and browser layouts remain separate. Phone prompts are submitted to the backend and the attached TUI should receive its session events.

## Verification completed

- Both packages pass `tsc --noEmit`.
- Accounting fixtures cover 205 messages across pages, duplicate IDs, late corrections, unknown versus zero cost, rate overrides and separate reasoning/cache counters.
- SDK tests verify transport/auth preservation, both reply protocols, answer bodies and failure propagation.
- An HTTP bridge fixture verifies missed request recovery, failed reply retention, answer routing, no answer-to-reject fallback and cleanup after another client resolves a prompt.
- Browser fixtures at 390 × 844 and 1440 × 1000 preserve message node identity, keep reading position within one pixel after earlier content grows and new messages arrive, keep follow mode at the bottom and preserve question drafts. Screenshots were inspected.

No live OpenCode server was reachable at port 4096 during verification. Actual phone ↔ TUI event delivery and the sidebar's rendering in a running TUI still need a restart and live check. No provider/model calls were made by these tests.

## Live acceptance check

1. Attach both surfaces to the same session, send a short message from the phone, and confirm the terminal shows that message and response without reopening the session.
2. Trigger a command your configuration requires approval for. Confirm the phone displays the permission and its session ID. Allow once; confirm the run resumes and the card disappears on both surfaces. Repeat with a question prompt.
3. Scroll up on the phone while the agent works. New output should leave your reading position stable. Press **Jump to latest** to resume following.
4. Open a long existing session and confirm the TUI's Session usage totals appear. If you use custom `rates` or `useReportedCost` settings, give the TUI plugin the same options as the server/remote plugins.

Exact cost/time footers below every TUI message remain separate host work: this version exposes a sidebar slot but no arbitrary message-footer slot. The browser already has its own cost/time footer.
