# Instructions: cost sidebar, reply footers, and synchronized remote sessions

Date: 19 September 2026. Prepared for implementation in this repository. This document specifies the work; it does not install plugins or change application behavior.

## What is possible

| Requested change | Supported approach |
| --- | --- |
| TUI right sidebar: session input/output/cached tokens and total cost | Add a TUI plugin using the existing `sidebar_content` slot. No OpenCode fork required for this part. |
| Browser/phone: session totals and cost/time below each assistant message | Update this repository's remote server serializer and HTML renderer. |
| Built-in TUI transcript: custom cost/time footer under every assistant message | No public per-message footer slot exists in the checked 1.18.31 API. Add a small host rendering change or a new host slot; a sidebar plugin alone cannot place content there. |
| Messages sent from the phone appear in the TUI | Both clients must use the same live backend, project/workspace, and session. Fix routing/subscription problems if they do not. |
| Browser CSS/layout changes also restyle the TUI | No. These are separate renderers and need separate presentation changes. |

The installed CLI package metadata checked in this environment reports 1.18.31. Recheck the executable actually used before implementation. The statement “plugins cannot customize the sidebar” is incorrect for the checked version. It is reasonable for an older server-only plugin to lack that capability; use the separate TUI plugin API.

Evidence: the versioned [TUI host slot types](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/plugin/src/tui.ts#L431-L462) include sidebar slots but no message-footer slot. The [sidebar renderer](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/tui/src/routes/session/sidebar.tsx#L82) actually mounts `sidebar_content`.

## Product requirements

Use the following presentation. Values are illustrative.

```text
SESSION USAGE
Input          128,400
Output           8,920
Cached read     94,300
Cache write      2,100
Session cost   $0.0842
```

“Cached” primarily means cached reads. Show cache writes separately when supplied, rather than combining two differently priced quantities invisibly. Keep the section scoped to the selected session. Show descendant/subagent usage separately if included; do not silently mix scopes or count it twice.

Under each completed assistant message in the browser:

```text
$0.0031 · 4.2s
```

User messages need no cost footer. Tool-only assistant messages still contribute usage; place their metadata with their activity group. If several assistant messages are collapsed into one visible response, show the summed cost and clearly defined elapsed time for that group, rather than only the final model call's cost.

While running, show “Running…” and a clearly provisional elapsed timer. On failure or cancellation, retain available usage and mark the outcome. Show unknown cost/time as unavailable, not as a fabricated zero. A genuine recorded zero is valid.

On desktop web, put session usage in a right-hand panel. On phones, use a compact “Session usage” disclosure or sheet so totals do not consume conversation space. Retain the existing dark theme.

## 1. Build one accounting implementation

Start from [session-cost/src/index.ts](Z:/Projects/opencode-plugins/session-cost/src/index.ts), especially the pricing helpers, message event handler, and `cost` tool.

1. Extract pure normalization, aggregation, pricing, and formatting helpers into a shared module that can be used by the server plugin, TUI plugin, and remote server. Keep runtime startup/event registration out of this module.
2. Normalize each record with backend identity, project/workspace, session ID, message ID, token fields, recorded cost, calculated estimate, pricing source, creation/completion timestamps, and completion/error state.
3. Load authoritative stored message usage when a session is opened. Page through all history or use a verified complete aggregate endpoint. The TUI's visible message cache is not the accounting ledger: the checked implementation evicts older entries after a threshold. See [TUI message synchronization](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/tui/src/context/sync.tsx#L303-L340).
4. Reconcile updates by message ID: replace the old record and apply its difference. Replayed events, reconnects, and late token/cost updates must not duplicate or freeze accounting. Do not clear a deduplication set and then recount history.
5. Rehydrate after restarting. The existing in-memory `session` map does not provide lifetime session totals.
6. Use the same pricing policy everywhere. Currently the toast path can recompute rates, but the `cost` tool and remote renderer use stored `info.cost`. Those surfaces can disagree today.
7. Preserve recorded cost separately from any recalculation. Label a recalculated value as an estimate and retain the rate version/source if historical consistency is required. Do not promise an exact provider invoice from token counts alone.
8. Verify the installed SDK/provider token semantics before summing. In particular, determine whether output already contains reasoning and whether input includes cache counts; do not automatically add overlapping fields. Maintain separate raw counters and test the normalization with fixtures.
9. Distinguish session totals from current context-window usage. Summed input tokens across many calls are not the size of the current model context.
10. Define deletion, revert, and compaction behavior. Recommended spend semantics: already incurred cost does not decrease just because visible conversation content is reverted. If deleted historical usage cannot be recovered, expose that limitation instead of claiming complete lifetime spend.

Do not try to share an in-memory `Map` between server and TUI processes. Share pure calculations, and obtain records/configuration through a supported API or a deliberate accounting service. Ensure any shared files/modules are included in both plugin packaging and remote deployment.

### Timing contract

- **One assistant message:** `completed - created`, clamped to a valid nonnegative value, when both persisted timestamps exist. This measures message lifetime, not necessarily pure model inference time.
- **One user-visible response/turn:** elapsed time from its user submission to its final completion, associated by parent/turn identity. Do not sum overlapping message/subagent durations.
- **Running:** client timer from a known server start timestamp, replaced by persisted final timing on completion.
- **Historical unknown:** show unavailable, not current time minus an old start.

The built-in TUI already derives duration for final responses from the parent user message. It does not currently render a custom cost footer in that component. See [AssistantMessage rendering and duration](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/tui/src/routes/session/index.tsx#L1417-L1511). Preserve the distinction between that turn duration and individual message duration.

## 2. Add the TUI sidebar plugin

1. Create a separate `session-cost/src/tui.tsx` entry using types from `@opencode-ai/plugin/tui` and the host-compatible Solid/OpenTUI runtime.
2. Export the required default object with a stable nonempty `id` and `tui` function. Keep it separate from the existing server entry; one module must not export both runtime targets.
3. Register a component in `api.slots.register({ slots: { sidebar_content: ... } })`. Use the slot's `session_id` to select usage. Verify the callback's exact typed props against the installed SDK; do not cast away type errors.
4. Use host theme colors, right-aligned tabular values, and a compact vertical layout. Avoid replacing unrelated sidebar content or requiring a wider terminal than OpenCode already needs.
5. Use the TUI session state for selection/live context and a complete accounting snapshot for totals. Subscribe to relevant updates with cleanup and refresh on reconnect/navigation. The API exposes session message access and event subscriptions; see [TUI API types](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/plugin/src/tui.ts).
6. Register the TUI entry in `tui.json`. Keep server-plugin registration in `opencode.json`/`opencode.jsonc`. If packaging for npm, expose separate server and TUI entries and include the built files. See the [versioned plugin authoring/configuration reference](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/opencode/specs/tui-plugins.md).
7. Pin compatible SDK/plugin/runtime versions for development. The current cost package uses `latest`; do not let an unreviewed API upgrade decide compatibility.
8. Keep toasts optional. The persistent sidebar becomes the primary summary; `/cost-now` should use the same calculation policy.

Example configuration shape, after the file exists and builds:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["Z:/Projects/opencode-plugins/session-cost/src/tui.tsx"]
}
```

Merge this into the existing configuration; do not overwrite other plugins or settings. If the deployment requires a built bundle, point at that bundle instead. Verify the sidebar is open during testing: an installed component cannot be seen in a hidden sidebar.

## 3. Handle the TUI per-message footer honestly

There is no supported `message_footer` slot in the checked host. Registering an invented slot name does not make it appear in the built-in transcript.

For the exact requested placement, prepare a small OpenCode host change against the verified version:

1. Extend the `AssistantMessage` metadata area in `packages/tui/src/routes/session/index.tsx` to display the chosen cost value and the agreed duration for each rendered message/group.
2. Prefer adding a typed host message-footer slot with message/session identity and a default rendering path if extensibility is desired. Add it to the host slot types and mount it in the actual renderer; the cost plugin can then provide its UI.
3. Preserve streaming behavior, errors, grouping, built-in metadata, and themes. Decide whether the footer is per model-call message or per grouped response and keep totals consistent.
4. Test/build this in an explicit OpenCode source checkout. A change confined to this plugins repository will not alter an installed OpenCode executable. Document the custom build and upgrade path.

A plugin-only alternative is a recent-message cost/time list in the sidebar or a custom usage view. That is useful but is **not** completion of the exact “beneath every TUI message” requirement. Report that limitation instead of silently substituting the layout. Do not append accounting text to actual assistant messages: it would alter conversation content and may enter future model context.

## 4. Update remote UI presentation and data

Work in [remote-ui/src/index.ts](Z:/Projects/opencode-plugins/remote-ui/src/index.ts) and [remote-ui/src/ui.html](Z:/Projects/opencode-plugins/remote-ui/src/ui.html). Use [remote-ui/REVIEW.md](Z:/Projects/opencode-plugins/remote-ui/REVIEW.md) for the complete defect list.

1. Extend serialized assistant metadata with completion state, persisted message timing, cache-write counts, and the shared accounting result. Existing `durationMs` on reasoning segments is reasoning time and must not be reused as total response time.
2. Include an authoritative session-usage summary in the state API, independent of the currently loaded transcript page. Return numeric data; let the UI format it.
3. Add the desktop usage panel/mobile disclosure and one quiet `$cost · duration` footer per message/group. Remove redundant cost/token rows that make the same information appear several times.
4. First fix segment rendering: render each text segment into its own container rather than overwriting the entire bubble. Use stable part IDs/revisions and preserve opened details/focus.
5. Show project + session clearly. Keep the model indicator truthful about current versus default model, and initialize the effective agent correctly when continuing a session.
6. Put permissions/questions in an actionable attention area near the composer on phones. Include child-session requests, complete request details, pending/replied/error states, and the right protocol adapter.
7. Fix stale-response races and project-scoped queues. Stop must pause queued work. Preserve failed drafts and show connection state.
8. Keep scroll-follow disabled while the user reads history; provide “Jump to latest.” Apply mobile hit areas, safe-area insets, input labels, contrast, and keyboard behavior from the review.

Treat request discovery and session identity as prerequisites to polish. A beautiful page that cannot answer a blocking question still fails the remote workflow.

## 5. Make phone and TUI observe the same session

The execution model is:

```text
Phone/browser -> remote-ui HTTP bridge -> OpenCode backend/session
Terminal TUI --------------------------> same OpenCode backend/session
```

The backend runs the agent. The terminal and browser display it and send actions. Phone prompts do not need to be typed into the TUI composer to run normally.

The TUI updates its store from backend `message.updated` and part events; there is no general rule that API-originated messages cannot appear. See [TUI synchronization](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/tui/src/context/sync.tsx#L303-L377). The comment above `notifyTUI()` in this repository currently asserts that transcripts do not mirror API prompts; replace that blanket statement once routing is verified. A toast is only a notification, not a transcript-sync mechanism.

### Diagnostic and implementation steps

1. Record the actual backend endpoint/instance used by the TUI and by the remote plugin. The remote UI port (normally 4409 or a fallback) is a bridge, not the OpenCode backend port.
2. Compare canonical directory/workspace and exact `sessionID`. The browser currently auto-selects a recent session and can create a new one; the TUI may be displaying another session.
3. Check whether a standalone TUI and a separate `opencode serve` process are running. Shared on-disk history does not imply a shared live event stream. Attach the terminal to the same server that hosts the remote plugin.
4. Verify the SDK request goes to the intended instance, including directory headers/query and workspace routing. Do not blindly add or remove `directory` everywhere.
5. Capture one remote submission: acceptance/error, persisted user message ID, assistant message events, TUI event receipt, and selected session. Redact tokens and prompt contents from diagnostics.
6. If the message is absent from backend history, fix dispatch and error reporting. If it is present but the TUI receives no event, fix instance/subscription routing. If the event arrives but the view does not update, inspect the TUI store/selection/render path.
7. Preserve one submission. Do not submit again through TUI controls as a “sync fix”; that can run the agent twice and double the cost.
8. Add an explicit “Open this session in terminal”/follow action where the verified TUI API supports navigation. Automatic remote-to-terminal session following should be opt-in so it does not interrupt unrelated terminal work.
9. Replying to a permission/question from either client must reconcile the other; this needs the pending-request fixes in the review.

For a deliberately shared-server setup, the documented CLI pattern is:

```powershell
# Start once, with remote-ui loaded by this backend's configuration.
opencode serve --hostname 127.0.0.1 --port 4096

# In another terminal, attach to that same backend and exact session.
opencode attach http://127.0.0.1:4096 --dir "Z:/Projects/opencode-plugins" --session <session-id>
```

These are illustrative commands, not commands executed by this review. Substitute the backend's actual port/project/session; do not start a second server if one already owns the desired run. Keep the custom phone bridge bound to Tailscale as intended. `attach` targets the backend, not port 4409. See [OpenCode CLI attach](https://opencode.ai/docs/cli/#attach).

### What a change affects

| Change | Effect |
| --- | --- |
| Edit `remote-ui/src/ui.html` | Browser/phone rendering only; current server reads it on page requests, so refresh to apply. |
| Edit `remote-ui/src/index.ts` | Remote bridge behavior; restart/reload the owning plugin runtime to apply. |
| Edit shared accounting/backend session logic | Both views can show consistent data when they consume that contract; their layouts remain separate. |
| Add/configure the cost TUI entry | Terminal sidebar; reload/restart the TUI as required. |
| Change OpenCode's built-in transcript renderer | Requires the corresponding rebuilt OpenCode host. |
| Agent edits a project file after a phone prompt | Changes the actual project/worktree used by that backend, visible to other tools reading the same files. |

## Acceptance checklist

- Sidebar shows complete selected-session totals after restart and for histories longer than the TUI's visible cache.
- Duplicate/reordered message events do not inflate totals; late usage corrections are reflected.
- Input/output/reasoning/cache fixtures prove there is no overlap double-counting.
- Toast, `/cost-now`, sidebar, and remote panel agree under the same pricing policy and scope.
- Each completed browser assistant message/group has the agreed cost and timing; unknown and zero are distinct.
- Exact TUI message-footer placement is tested in a built host, or explicitly reported as outstanding; a sidebar substitute is not mislabeled as completion.
- A phone prompt appears in the already-selected terminal session on the same backend, and a terminal prompt appears on the phone, with one execution each.
- Permission/question replies from either client unblock the run and clear pending state in the other.
- Switching projects during a slow request cannot overwrite another session or dispatch its queue in the wrong project.
- Test desktop, a narrow phone viewport with keyboard open, and a real background/reconnect cycle.

## Prompt to give OpenCode

> Read `UI_IMPLEMENTATION_PLAN.md` and `remote-ui/REVIEW.md`. Implement the supported cost sidebar and remote UI work, using the installed OpenCode version's real TUI plugin API. Share accounting logic and complete session usage across the sidebar, cost tool, and remote interface. Show total input/output/cache tokens and session cost; show cost and elapsed time under each browser assistant response. Fix remote/TUI backend-session identity and synchronization, and the permission/question gaps. Do not claim that server plugins and TUI plugins have the same capabilities. For exact per-message TUI footers, verify whether the installed host exposes a slot; if it does not, identify and prepare the necessary OpenCode host change separately, clearly reporting the custom-build requirement. Do not fabricate a slot or inject cost text into conversation content. Validate the acceptance checklist and report precisely what works and what remains.
