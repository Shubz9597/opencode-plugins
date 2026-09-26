# Remote UI review and fix plan

Reviewed: 19 September 2026. Scope: `src/index.ts`, `src/ui.html`, package metadata, README, setup guide, and existing design notes. This is a review; application code has not been changed.

## Main conclusion

The missing permission prompts are primarily a state and event integration problem. The browser already has an approval banner, but it can only display requests that reached one plugin instance's in-memory cache. Several legitimate blocking requests never reach that cache. Polling every 1.5 seconds does not repair this because `/api/state` reads the same cache rather than OpenCode's pending-request API.

The two strongest explanations for the reported symptom are:

1. **Other projects:** the UI controls multiple directories, but the plugin event hook receives events only for its own directory. Messages can update through polling while permission prompts remain invisible.
2. **V2 permission requests:** the installed OpenCode package is 1.18.31, whose published schema includes `permission.v2.asked`. This plugin handles only `permission.asked` and `permission.updated`. A V2 request is silently discarded.

Question prompts are also entirely unsupported, and child-session permissions can be detected but remain impossible to open. These produce the same apparent “agent stuck” experience.

**Confidence boundary:** these are verified code paths, not a capture of the user's stalled session. No live OpenCode server or physical phone session was exercised. The exact triggering path still needs one live event trace. A legacy permission raised in the plugin's own directory, after its event hook is registered, should enter the cache; simply adding `permission.asked` again would not fix that case because it is already handled.

## Evidence and method

- Inspected both application files in full. No applicable `AGENTS.md` was found in the workspace or checked parent directories.
- Checked the lockfile and installed CLI package metadata: OpenCode 1.18.31. The running process version, if a separate installation is used, remains to be verified.
- Checked upstream source at the matching `v1.18.31` tag, rather than assuming current documentation describes this installation.
- Executed extracted UI functions in Node with a minimal DOM/network stub. Reproduced: earlier segments erased by Markdown, equal-length updates skipped, forced scroll-follow after four seconds, queued requests using the wrong project URL, and stale session responses rendering after navigation.
- Executed the extracted event handler with legacy and V2 permission fixtures: the legacy request entered the cache; the V2 request did not.
- Calculated `--faint` text contrast on black: **2.35:1**.
- These checks validate control flow, not browser layout or a real OpenCode approval round trip. No screenshot-based or physical-device assessment is claimed. Repository dependencies are not installed, so a full typecheck was not run.
- The Impeccable context loader and detector were attempted but could not run because their engine was unavailable and required installation/cache access. UI findings below come from direct code inspection and the targeted checks, not detector output.

## Priorities

P0 means a workflow is blocked in the stated scenario; P1 means a major correctness or usability failure; P2 means a secondary reliability or usability gap.

| Priority | Findings | Fix order |
| --- | --- | --- |
| P0 | 4 | Request discovery, protocol compatibility, questions, child-session routing |
| P1 | 8 | Approval feedback, errors, navigation/queue isolation, rendering, attachments, accessibility, project scope |
| P2 | 6 | Scroll behavior, mobile layout, context clarity, performance, lifecycle, uploads |

### Technical UI audit

These are provisional implementation scores, not a WCAG certification or device benchmark.

| Dimension | Score / 4 | Main evidence |
| --- | --- | --- |
| Accessibility | 1 | Click-only picker rows, low-contrast labels, unannounced request/status changes |
| Performance | 2 | Full-history polling plus SSE refreshes; serial project discovery |
| Responsive design | 2 | Flexible layout and `100dvh`, but small controls and missing safe-area handling |
| Theming | 3 | Useful tokens and a consistent dark palette; late overrides and literal colors remain |
| Implementation integrity | 1 | UI state depends on globals, lossy rendering, and incomplete blocking-request support |
| **Total** | **9 / 20** | **Poor: fix workflow reliability before visual polish** |

**Implementation integrity verdict: fail for remote operation reliability.** The visual identity is coherent, but the interface does not reliably expose the actions needed to complete remote work.

## Detailed findings

### 1. [P0] Multi-project controls are backed by a single-directory permission cache

**Locations:** [plugin state](Z:/Projects/opencode-plugins/remote-ui/src/index.ts:181), [state endpoint](Z:/Projects/opencode-plugins/remote-ui/src/index.ts:401), [event hook](Z:/Projects/opencode-plugins/remote-ui/src/index.ts:668).

**Cause:** `pendingPermissions` is populated only by this instance's event hook. The matching OpenCode loader explicitly filters events to `event.location.directory === ctx.directory`. Opening project B through project A's UI does not make A's hook receive B's events. Separate plugin instances also have separate maps and potentially separate HTTP ports. This directory filtering is visible in the [OpenCode 1.18.31 plugin loader](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/opencode/src/plugin/index.ts#L236-L243).

**Impact:** B's transcript can update through directory-scoped API reads while its pending approval never appears. A missed request also cannot be recovered from this cache. Browser disconnection alone does not clear the server cache; the problem is requests the plugin never captured, or state lost while the underlying runtime still retains a request.

**Fix:** fetch authoritative pending requests per exposed project at initialization, project selection, reconnect, and reconciliation intervals. Use directory-aware event subscriptions for fast updates. Treat events as cache updates, not the only source of truth. Preserve project/session/request identity together.

**Acceptance:** a request in project B appears and can be answered from the UI served by project A; an already-pending request appears without needing to be raised again.

Category: implementation integrity. Suggested UI follow-through: `$impeccable harden`.

### 2. [P0] V2 permission events and reply contracts are unsupported

**Locations:** [event names](Z:/Projects/opencode-plugins/remote-ui/src/index.ts:682), [reply route](Z:/Projects/opencode-plugins/remote-ui/src/index.ts:548).

**Cause:** the code accepts two legacy event names and assumes `permission`/`patterns` fields. The matching published types also define `permission.v2.asked` and `permission.v2.replied`, with `action`/`resources` request fields. The extracted handler discarded a V2 fixture. See the [versioned event schema](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/sdk/js/src/v2/gen/types.gen.ts#L6489-L6513).

**Impact:** when the runtime uses the V2 permission system, no banner is created even in the host project. This condition was reproduced with a fixture; whether the user's stalled run uses V2 has not been captured.

**Fix:** add a typed compatibility adapter that normalizes supported request protocols and records the protocol on each request. Map replies through that same protocol. Do not only rename an event: request fields, pending-list responses, and reply semantics also differ. The generated V2 contract includes `/api/session/{sessionID}/permission/{requestID}/reply`; use its declared request body rather than assuming the legacy enum is interchangeable. See the [versioned reply contract](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/sdk/js/src/v2/gen/types.gen.ts#L12240-L12250).

**Acceptance:** capture and round-trip a real request for each supported protocol; unsupported versions produce a visible compatibility error.

Category: implementation integrity. Suggested command: `$impeccable harden`.

### 3. [P0] Question prompts have no remote response path

**Locations:** [forwarded events](Z:/Projects/opencode-plugins/remote-ui/src/index.ts:198), [state endpoint](Z:/Projects/opencode-plugins/remote-ui/src/index.ts:401), [permission-only banner](Z:/Projects/opencode-plugins/remote-ui/src/ui.html:520).

**Cause:** neither file handles question requests, their pending state, answers, or rejection. OpenCode exposes a separate question API; a chat message or permission reply does not answer it. The legacy-compatible list/reply/reject methods are documented by the [versioned generated SDK](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/sdk/js/src/v2/gen/sdk.gen.ts#L2897-L2994).

**Fix:** implement question discovery and lifecycle handling for the supported runtime contracts. Show question text, choices, multiple selection where supported, custom answers where supported, and a reject/cancel action. Keep question responses distinct from permission decisions.

**Acceptance:** a run waiting for a question can continue entirely from the phone, including after a refresh.

Category: implementation integrity. Suggested command: `$impeccable harden`.

### 4. [P1] Approval clicks can fail silently or target the wrong directory

**Locations:** [approval backend](Z:/Projects/opencode-plugins/remote-ui/src/index.ts:557), [approval buttons](Z:/Projects/opencode-plugins/remote-ui/src/ui.html:535).

**Cause:** the newer reply branch sends the plugin's captured `directory`, rather than the request's resolved `dir`. `sessionDir`/`dirForSession` exist but are not used to correct that route. The frontend never awaits or checks its approval request. The backend ignores SDK result errors and reports `{ ok: true }` when the promise resolves, even if the result represents failure. A `.catch()` fallback only handles rejected promises.

The injected plugin client is the root SDK client in the checked version; its generated surface exposes the legacy reply method. Therefore the newer branch is a compatibility-path bug, not proof it executes today. See the [plugin input type](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/plugin/src/index.ts#L52-L62) and [root SDK](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/sdk/js/src/gen/sdk.gen.ts).

**Fix:** resolve the request's authoritative owning session/project, use a typed SDK adapter, check explicit SDK errors or opt into throwing, and return meaningful HTTP failures. Reject invalid response values instead of silently turning them into `once`. Disable only that request's controls while replying, show success/failure inline, reconcile pending state, and handle “already answered elsewhere.” Preserve complete resource details; the current 160-character title truncation is inadequate for informed approval. Explain the scope of “Always allow.”

**Acceptance:** a rejected API call leaves the request visible with an actionable error; a successful approval clears it on both phone and desktop. Approvals for B never use A's directory.

Category: implementation integrity. Suggested command: `$impeccable harden`.

### 5. [P0] Child-session permissions can be impossible to reach

**Locations:** [session filtering](Z:/Projects/opencode-plugins/remote-ui/src/index.ts:392), [exact permission filtering](Z:/Projects/opencode-plugins/remote-ui/src/index.ts:409), [other-session notice](Z:/Projects/opencode-plugins/remote-ui/src/ui.html:522), [no-session early return](Z:/Projects/opencode-plugins/remote-ui/src/ui.html:734).

**Cause:** `/api/sessions` hides every session with a `parentID`. `/api/state` includes only the selected session's permissions. Other requests are reduced to a count, with instructions to select their session. A child is absent from that picker. When “New session” is selected, polling does not even retrieve pending requests.

**Fix:** expose a project-wide attention list with session names, parent-child relationships, and direct request actions. Surface descendant requests in the parent conversation while retaining the child request's real identity for replies. Allow attention access without selecting a conversation.

**Acceptance:** a subagent request is actionable from its parent session and from the global attention list.

Category: implementation integrity. Suggested command: `$impeccable harden`.

### 6. [P1] Network and runtime failures masquerade as success or inactivity

**Locations:** [status fallback](Z:/Projects/opencode-plugins/remote-ui/src/index.ts:405), [dispatch](Z:/Projects/opencode-plugins/remote-ui/src/index.ts:480), [prompt dispatch](Z:/Projects/opencode-plugins/remote-ui/src/index.ts:523), [abort](Z:/Projects/opencode-plugins/remote-ui/src/index.ts:536), [poll errors](Z:/Projects/opencode-plugins/remote-ui/src/ui.html:733), [SSE errors](Z:/Projects/opencode-plugins/remote-ui/src/ui.html:760), [composer clearing](Z:/Projects/opencode-plugins/remote-ui/src/ui.html:958).

**Cause:** sends return 202 before dispatch success is known; failures are swallowed. Abort returns success after caught errors. A failed status read defaults to `idle`. Session errors are not forwarded or serialized. The browser swallows poll failures and displays no disconnected/stale state. Text and files are cleared before a send succeeds and are not restored on failure.

**Fix:** distinguish accepted, running, waiting for input, failed, disconnected, and unknown state. Await the asynchronous-prompt acceptance response; track background command/shell failures separately without holding HTTP open for an entire run. Forward session errors and render tool/assistant error details. Preserve failed drafts and provide retry. Never interpret an unavailable status as idle or use it to drain the queue.

**Acceptance:** offline, authentication, provider, command, and abort failures remain visible and do not lose drafts or trigger queued work.

Category: implementation integrity. Suggested command: `$impeccable harden`.

### 7. [P1] Responses from an old session can overwrite the newly selected one

**Locations:** [poll](Z:/Projects/opencode-plugins/remote-ui/src/ui.html:733), [session selection](Z:/Projects/opencode-plugins/remote-ui/src/ui.html:763), [project selection](Z:/Projects/opencode-plugins/remote-ui/src/ui.html:812).

**Cause:** requests capture the old URL, but responses render against mutable global `current` and `activeProject`. There is no cancellation, request generation, or response-identity check. Project selection changes the project before the old session has been replaced, allowing a transient B-directory/A-session combination. Metadata and session-list requests have the same race.

**Impact:** stale transcripts, status, or permission banners can appear under another session's heading. Reproduced by resolving A's poll after changing `current` to B.

**Fix:** capture a project/session generation per request and ignore obsolete responses; cancel outstanding reads on navigation. Update project and session context atomically. Reset session-specific render, busy, stop, and scroll state together.

**Acceptance:** deliberately resolve A and B requests out of order; only B's state is displayed after selecting B.

Category: implementation integrity. Suggested command: `$impeccable harden`.

### 8. [P1] Queue state crosses projects and can restart work after Stop

**Locations:** [idle processing](Z:/Projects/opencode-plugins/remote-ui/src/ui.html:711), [SSE flush](Z:/Projects/opencode-plugins/remote-ui/src/ui.html:755), [queue/send](Z:/Projects/opencode-plugins/remote-ui/src/ui.html:916), [Stop](Z:/Projects/opencode-plugins/remote-ui/src/ui.html:1006).

**Cause:** `queue`, `busySeen`, and stop state are global. Queued payloads store `directory`, but `doSend()` routes through the currently selected `activeProject`, and the backend uses the query directory. Both idle rendering and an SSE timer can call `flushQueue()` without a shared in-flight lock. Stop neither pauses the queue nor cancels a pending flush. The Enter handler can invoke `send()` even while the Send button is disabled.

**Impact:** queued work can be submitted with mismatched context, dispatch concurrently, disappear after a failed send, or resume immediately after Stop. Wrong-project URL routing was reproduced; the resulting backend behavior depends on session lookup/scoping.

**Fix:** own each queue by immutable project/session identity; use that identity for dispatch. Serialize draining, guard all send entry points, and retain items until acceptance. Pause queued work on Stop and require an explicit Resume. Preserve drafts/queue state across refresh if the UI promises queued delivery, with a visible unsent state.

**Acceptance:** switching A to B cannot send A's queue under B; duplicate idle signals drain only one item; Stop prevents later queued execution.

Category: implementation integrity. Suggested command: `$impeccable harden`.

### 9. [P1] Transcript rendering loses content and misses updates

**Locations:** [Markdown rendering](Z:/Projects/opencode-plugins/remote-ui/src/ui.html:367), [segment loop](Z:/Projects/opencode-plugins/remote-ui/src/ui.html:420), [signature](Z:/Projects/opencode-plugins/remote-ui/src/ui.html:637), [last-message replacement](Z:/Projects/opencode-plugins/remote-ui/src/ui.html:665), [tool serialization](Z:/Projects/opencode-plugins/remote-ui/src/index.ts:123).

**Cause and impact:**

- `renderMd(bubble, text)` assigns the whole bubble's `innerHTML`. A later text segment erases earlier text, thinking panels, and tool panels. Reproduced with mixed segments.
- The change signature compares serialized segment **length**, so `AAAA` becoming `BBBB` is invisible. Reproduced. Token/model changes can also be skipped.
- When message IDs do not change, only the final message is replaced. Updates to an earlier message remain stale.
- Replacing the last message discards disclosure state, text selection, and DOM focus; streaming reasoning panels are reopened each time.
- Tool serialization retains only a short title, omitting status, output, and error information needed to diagnose remote failures.

**Fix:** append a dedicated container per segment; key messages and parts by stable IDs; compare actual revisions/content; update every changed part. Preserve disclosure/focus state. Serialize tool lifecycle and useful output/error details, with pagination or truncation controls for large output.

**Acceptance:** a reasoning/text/tool/text message shows all parts in order; equal-length and earlier-message updates render; opened details stay open while streaming.

Category: implementation integrity/performance. Suggested command: `$impeccable harden`.

### 10. [P2] Auto-scroll fights reading history

**Locations:** [scroll handler](Z:/Projects/opencode-plugins/remote-ui/src/ui.html:332), [follow reset](Z:/Projects/opencode-plugins/remote-ui/src/ui.html:647).

**Cause:** four seconds after the last upward scroll, the next changed state forces `stick = true`. Repeated programmatic pins suppress scroll handling for hundreds of milliseconds and can ignore an intentional gesture.

**Fix:** keep follow mode off until the user returns near the bottom or presses “Jump to latest.” Preserve the visible message anchor when content above it changes. Use one scroll update per render frame.

**Acceptance:** reading an earlier message for 30 seconds while output streams never jumps to the bottom.

Category: implementation integrity. Suggested command: `$impeccable harden`.

### 11. [P1] Attachments lose authentication and project context

**Locations:** [attachment URL construction](Z:/Projects/opencode-plugins/remote-ui/src/index.ts:117), [download route](Z:/Projects/opencode-plugins/remote-ui/src/index.ts:420), [browser attachment rendering](Z:/Projects/opencode-plugins/remote-ui/src/ui.html:479).

**Cause:** internal attachment URLs contain session/message/part IDs, but no token or directory. Images, videos, and anchors use those URLs directly, bypassing `jsonReq()`. With token authentication enabled, they receive 401. For other projects, lookup defaults to the host project. Non-HTTP file parts are all routed to this endpoint, but it supports only `file://`, so other representations such as data URLs are not handled correctly.

**Fix:** serve internal media through an authenticated, project-aware path, using scoped media authorization or a suitable session mechanism. Validate URL schemes and handle supported file representations explicitly. Never append the shared token to arbitrary external media URLs. Return safe download headers for non-preview files; arbitrary uploaded HTML should not execute inline on the application's origin.

**Acceptance:** protected images/files load from host and secondary projects, unauthorized requests fail, and uploaded active content downloads or is safely isolated.

Category: implementation integrity. Suggested command: `$impeccable harden`.

### 12. [P1] Important controls and labels are inaccessible

**Locations:** [faint token](Z:/Projects/opencode-plugins/remote-ui/src/ui.html:18), [input](Z:/Projects/opencode-plugins/remote-ui/src/ui.html:297), [banner](Z:/Projects/opencode-plugins/remote-ui/src/ui.html:520), [picker rows](Z:/Projects/opencode-plugins/remote-ui/src/ui.html:828), [agent rows](Z:/Projects/opencode-plugins/remote-ui/src/ui.html:859).

**Evidence:** `#464a4d` on black is 2.35:1 and is used for small labels, metadata, hints, and tool details. Session and agent choices are clickable `div`s without keyboard interaction. Dropdowns have no expanded state or focus management. The composer lacks a persistent accessible label; removal controls lack meaningful names. Status and permission changes lack live-region semantics.

**Fix:** use native buttons/select controls or implement the complete keyboard pattern; provide meaningful labels, expanded/selected states, Escape behavior, visible focus, and focus return. Raise essential small-text contrast to at least 4.5:1. Announce connection/waiting/error changes without reading the entire streaming transcript. Provide a reduced-motion alternative for continuous pulses and bouncing indicators.

Relevant standards: WCAG 1.4.3 contrast, 2.1.1 keyboard, 4.1.2 name/role/value, and 4.1.3 status messages. A full conformance audit still requires browser/assistive-technology testing.

**Acceptance:** complete project/session selection and request response by keyboard; verify meaningful screen-reader announcements and contrast.

Category: accessibility. Suggested commands: `$impeccable harden`, `$impeccable colorize`.

### 13. [P2] Phone layout and clipboard behavior need deliberate handling

**Locations:** [viewport](Z:/Projects/opencode-plugins/remote-ui/src/ui.html:5), [approval buttons](Z:/Projects/opencode-plugins/remote-ui/src/ui.html:89), [copy styles](Z:/Projects/opencode-plugins/remote-ui/src/ui.html:131), [footer/input](Z:/Projects/opencode-plugins/remote-ui/src/ui.html:189), [copy handler](Z:/Projects/opencode-plugins/remote-ui/src/ui.html:377), [Enter handler](Z:/Projects/opencode-plugins/remote-ui/src/ui.html:1016).

**Evidence:** several action styles yield small hit areas; none enforce a 44px touch target. `viewport-fit=cover` is set without safe-area padding. A three-row header, request banner, and composer compete for vertical room. The textarea is 15px, which needs iOS focus-zoom testing. Copy is hover-only and directly calls `navigator.clipboard`; the normal non-localhost HTTP Tailscale URL is not a secure context for that API. Enter always sends and does not check IME composition.

**Fix:** use at least 44px primary touch targets, safe-area insets, bounded panels, and keyboard-aware composer sizing. Make Copy visible for touch and keyboard focus, feature-detect clipboard support, and provide a working fallback or HTTPS path with failure feedback. Use 16px mobile input text, composition-aware sending, and an intentional mobile newline/send convention.

**Acceptance:** test 320/390px portrait, landscape, keyboard open, 200% zoom, and touch-only copy. Verify on the actual HTTP/HTTPS origin used by the phone.

Category: responsive/accessibility. Suggested command: `$impeccable adapt`.

### 14. [P2] The interface obscures context and repeats low-value detail

**Locations:** [header](Z:/Projects/opencode-plugins/remote-ui/src/ui.html:266), [per-message metadata](Z:/Projects/opencode-plugins/remote-ui/src/ui.html:398), [turn summaries](Z:/Projects/opencode-plugins/remote-ui/src/ui.html:558), [metadata defaults](Z:/Projects/opencode-plugins/remote-ui/src/index.ts:344), [agent selection](Z:/Projects/opencode-plugins/remote-ui/src/ui.html:884).

**Cause:** the selected project is hidden inside the Session dropdown. Model identity appears in the header and each assistant entry, with cost/token rows adding clutter. The header model can initially represent another recent session's model, and a new empty session can retain the previous display. Agent state is global rather than initialized from the selected session; the frontend also offers subagents as normal choices. The configured default agent is not given consistent precedence. Stop remains available when nothing is running. The session list is not refreshed by session create/update/delete events, so desktop-side activity leaves the picker stale.

**Fix:** show project + session together; distinguish current-session model from a default estimate; keep model management in OpenCode as the setup guide intends. Resolve the effective primary agent per session/project and exclude non-invocable choices. Show Stop only in an applicable run state. Group tool activity and put detailed cost/token information behind a compact disclosure. Refresh picker data on relevant events; add search if the list is long. Update the README's model-picker claim to match the intentional read-only model display.

**Acceptance:** the user can identify the target project, session, connection, run state, and required action without opening menus.

Category: implementation integrity/theming. Suggested commands: `$impeccable clarify`, `$impeccable layout`.

### 15. [P2] Repeated full-history reads and serial discovery will feel slow

**Locations:** [project discovery](Z:/Projects/opencode-plugins/remote-ui/src/index.ts:275), [metadata lookups](Z:/Projects/opencode-plugins/remote-ui/src/index.ts:348), [state reads](Z:/Projects/opencode-plugins/remote-ui/src/index.ts:405), [SSE-triggered polling](Z:/Projects/opencode-plugins/remote-ui/src/ui.html:742), [fixed poll interval](Z:/Projects/opencode-plugins/remote-ui/src/ui.html:1029).

**Cause:** project discovery scans up to 40 sibling folders and reads their sessions serially. Every state refresh fetches and serializes full history. SSE can trigger polls every 250ms while the 1.5-second interval still runs, with no in-flight coalescing. Startup waits for project discovery before loading a session. CDN scripts block parsing; offline fallback only becomes useful after failed loads settle.

**Fix:** expose the host/configured projects immediately; discover optional projects in the background with bounded concurrency and caching. Coalesce state reads, back off when idle/hidden/disconnected, and reconcile immediately on visibility/reconnect. Page history and patch message parts where practical. Bundle or locally serve essential rendering dependencies. Correct SSE identity extraction by event schema rather than a single `props.info.id` fallback; do not forward raw heartbeat text as a JSON data message.

**Acceptance:** benchmark a long conversation and many projects on a throttled connection; no overlapping refresh storm and no full discovery delay before the selected session becomes usable.

Category: performance. Suggested command: `$impeccable optimize`.

### 16. [P1] Configured projects do not define the actual exposed scope

**Locations:** [directory resolution](Z:/Projects/opencode-plugins/remote-ui/src/index.ts:240), [sibling discovery](Z:/Projects/opencode-plugins/remote-ui/src/index.ts:275).

**Cause:** `dirFor()` accepts an arbitrary supplied directory after checking known entries. `/api/projects` also discovers siblings automatically. Thus the documented `projects` option is not an allowlist for remote access. Any already-authorized UI client can request an additional directory, subject to the OpenCode process's filesystem access.

**Fix:** define the intended exposure policy explicitly. If `projects` means allowed projects, enforce it for reads, sends, replies, and attachments; make broader discovery opt-in. Validate the session/request's owning project instead of trusting the URL alone. Keep this consistent with the multi-project fix in finding 1.

**Acceptance:** requests outside the configured scope fail clearly; adding an allowed project makes it available deliberately.

Category: implementation integrity. Suggested command: `$impeccable harden`.

### 17. [P2] Server start/restart and disposal handling are fragile

**Locations:** [start promise](Z:/Projects/opencode-plugins/remote-ui/src/index.ts:594), [bind failures](Z:/Projects/opencode-plugins/remote-ui/src/index.ts:609), [auto-start](Z:/Projects/opencode-plugins/remote-ui/src/index.ts:648), [cleanup](Z:/Projects/opencode-plugins/remote-ui/src/index.ts:712).

**Cause:** a failed `startPromise` remains cached, so retrying `remote` reuses the rejection. All bind errors are labeled “port in use.” Auto-start does not handle rejection. Cleanup depends on a disposal event, while the matching plugin contract has an explicit `dispose` hook. Successful cached startup is also not reset after closing.

**Fix:** implement idempotent disposal, close SSE clients and heartbeat/server resources, reset startup state on failure/closure, and preserve the real bind error. Only retry another port for address-in-use errors. Verify that project discovery does not unintentionally proliferate UI servers when auto-start is enabled globally.

**Acceptance:** bind failure, retry, disposal, and restart leave no orphan listeners or permanently rejected startup state.

Category: implementation integrity. Suggested command: `$impeccable harden`.

### 18. [P2] Attachment uploads lack limits, progress, and reliable identity

**Locations:** [body reader](Z:/Projects/opencode-plugins/remote-ui/src/index.ts:154), [temporary file names](Z:/Projects/opencode-plugins/remote-ui/src/index.ts:511), [file reader](Z:/Projects/opencode-plugins/remote-ui/src/ui.html:965).

**Cause:** files are fully read into base64 in the browser, copied into JSON, then buffered and decoded on the server. The server's 64MiB limit applies to encoded JSON, not raw file sizes; there is no matching client validation or upload/read failure state. `Date.now()` plus sanitized filename can collide for concurrent uploads. Age cleanup runs only at plugin initialization, and deleting backing files can break later history downloads.

**Fix:** validate per-file and total sizes before reading, display progress/read errors, use collision-resistant IDs and exclusive creation, and define attachment retention. Prefer streaming/multipart transfer for larger files. Return explicit 413/validation errors rather than a dropped connection or generic 500.

**Acceptance:** oversized/failed uploads preserve the draft; concurrent same-name files remain distinct; old attachments show an intentional expired state or remain available per the retention policy.

Category: performance/implementation integrity. Suggested command: `$impeccable harden`.

## Recommended implementation sequence

1. **Request protocol and reconciliation:** introduce typed adapters, authoritative pending lists, project/session/request ownership, V2 compatibility, question handling, and child-session attention. Capture a real stalled-session event before choosing the active protocol path.
2. **Reliable actions and state:** validate replies, surface failures, guard navigation races, isolate queues/drafts by session, and make Stop pause queued work.
3. **Transcript and attachments:** correct segment rendering and update identity; preserve disclosure state; restore tool status/error details; fix protected, project-scoped media delivery.
4. **Phone operation:** compact the header, make the current project visible, place request actions near the composer, enlarge controls, fix accessibility, and make scroll-follow explicit. Preserve the existing dark identity.
5. **Performance and lifecycle:** coalesce requests, page history, cache discovery, handle reconnect/disposal, and verify long-session behavior.

Do not spend the first pass changing colors or migrating frameworks. The plain HTML/TypeScript structure can support these fixes once state ownership and protocol boundaries are explicit. Suggested module boundaries are request adapters, session state/queue, message rendering, request UI, and server lifecycle; a framework rewrite is not required.

### Concrete acceptance matrix

| Scenario | Required result |
| --- | --- |
| Host-project legacy approval | Allow once, persistent allow, and deny have visible, correct outcomes |
| Host-project V2 approval | Correct event normalization and matching reply contract |
| Secondary-project approval | Visible from the original UI port; reply uses the owning project |
| Pending request before UI opens | Retrieved from runtime state, not dependent on a new event |
| Child-session request | Visible/actionable from parent and attention list |
| Question prompt | Options/custom answers as supported; submit/reject unblocks run |
| Desktop answers while phone is open | Phone reconciles; no permanent stale banner |
| Lost connection and phone background/resume | Clear stale state, preserved draft, immediate resync |
| Slow A request resolves after selecting B | A cannot overwrite B's messages, status, or actions |
| Queue + project switch + duplicate idle + Stop | Correct ownership, one drain at a time, no unwanted restart |
| Mixed segments and equal-length updates | Complete ordered transcript and correct updates |
| Token-protected secondary-project attachments | Images/files work with authorization and correct scope |
| Keyboard/screen reader/touch | All primary actions accessible; request changes announced |
| Narrow screen + keyboard + long approval text | Composer and decisions usable without clipped controls |
| Long history + many projects | Bounded requests and responsive interaction |

## What to keep

- Tailscale-specific default binding and optional shared-token authorization.
- Sanitized Markdown with a plain-text fallback.
- Lazy loading for attachment images and bounded tool/reasoning content areas.
- Existing dark-theme tokens, sensible content width, and native `details` elements.
- SSE plus reconciliation as a direction; the reconciliation must include runtime pending requests and connection health.

The recurring gaps are mutable global context, fire-and-forget actions without feedback, and event-only state. Addressing those will improve the perceived clunkiness more than a cosmetic redesign alone.

## Optional Impeccable follow-through

After the protocol/backend fixes, use `$impeccable harden` for UI state and recovery, `$impeccable adapt` for phone behavior, `$impeccable clarify` and `$impeccable layout` for context/hierarchy, and `$impeccable optimize` for refresh/render performance. Re-run `$impeccable audit` after fixes; finish with `$impeccable polish`.

These follow-through passes can be run individually, together, or in the preferred order. They are recommendations; this review did not apply them to the app.

