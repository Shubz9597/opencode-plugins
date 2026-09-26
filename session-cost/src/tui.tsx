/** @jsxImportSource @opentui/solid */
import type { TuiPlugin } from "@opencode-ai/plugin/tui"
import { createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { fmtCost, fmtInt, parsePriceTable, type Rates } from "./accounting.ts"
import { loadMessages, summarize, type CostMessage } from "./sidebar-data.ts"

const tui: TuiPlugin = async (api, options) => {
  const [prices, setPrices] = createSignal(new Map<string, Rates>())
  const refreshPrices = async () => {
    try {
      const response = await fetch(String(options?.pricingUrl ?? "https://models.dev/api.json"), { signal: AbortSignal.any([api.lifecycle.signal, AbortSignal.timeout(10000)]) })
      if (response.ok) setPrices(parsePriceTable(await response.json()))
    } catch { /* Recorded cost remains available when pricing is offline. */ }
  }
  void refreshPrices()
  const priceTimer = setInterval(refreshPrices, 6 * 60 * 60 * 1000)
  api.lifecycle.onDispose(() => clearInterval(priceTimer))

  function Sidebar(props: { session_id: string }) {
    const [messages, setMessages] = createSignal(new Map<string, CostMessage>())
    const [state, setState] = createSignal("Loading…")
    const totals = createMemo(() => summarize(messages().values(), prices(), options?.rates as Record<string, Rates> | undefined, options?.useReportedCost === true))
    createEffect(() => {
      const sessionID = props.session_id
      const controller = new AbortController()
      const signal = AbortSignal.any([controller.signal, api.lifecycle.signal])
      let running = false
      let dirty = false
      const edits = new Map<string, CostMessage | null>()
      let timer: ReturnType<typeof setTimeout> | undefined
      setMessages(new Map())
      setState("Loading…")
      const refresh = async () => {
        if (running) { dirty = true; return }
        running = true
        edits.clear()
        try {
          const loaded = await loadMessages(async before => {
            const result = await api.client.session.messages({ sessionID, directory: api.state.path.directory, limit: 100, before }, { throwOnError: true, signal })
            return { messages: result.data.map(row => row.info), next: result.response.headers.get("x-next-cursor") }
          })
          if (!signal.aborted) {
            // Events arriving during pagination are newer than that snapshot.
            for (const [id, message] of edits) {
              if (message) loaded.set(id, message)
              else loaded.delete(id)
            }
            setMessages(loaded)
            setState("")
          }
        } catch {
          if (!signal.aborted) setState("Usage unavailable · retrying")
        } finally {
          running = false
          if (dirty && !signal.aborted) { dirty = false; void refresh() }
        }
      }
      const schedule = () => {
        clearTimeout(timer)
        timer = setTimeout(refresh, 300)
      }
      const offUpdate = api.event.on("message.updated", event => {
        const info = event.properties.info
        if (info.sessionID !== sessionID) return
        edits.set(info.id, info)
        setMessages(old => new Map(old).set(info.id, info))
        schedule()
      })
      const offRemove = api.event.on("message.removed", event => {
        if (event.properties.sessionID !== sessionID) return
        edits.set(event.properties.messageID, null)
        setMessages(old => { const next = new Map(old); next.delete(event.properties.messageID); return next })
        schedule()
      })
      const retry = setInterval(refresh, 15000)
      void refresh()
      onCleanup(() => { controller.abort(); clearTimeout(timer); clearInterval(retry); offUpdate(); offRemove() })
    })
    const theme = api.theme.current
    return <box flexDirection="column" paddingTop={1}>
      <text fg={theme.text}><b>Session usage</b></text>
      <text fg={theme.textMuted}>{state()}</text>
      <text fg={theme.text}>Input       {fmtInt(totals().input)}</text>
      <text fg={theme.text}>Output      {fmtInt(totals().output)}</text>
      <text fg={theme.textMuted}>Reasoning   {fmtInt(totals().reasoning)}</text>
      <text fg={theme.text}>Cached read {fmtInt(totals().cacheRead)}</text>
      <text fg={theme.text}>Cache write {fmtInt(totals().cacheWrite)}</text>
      <text fg={theme.primary}>Session cost {totals().unknown ? "— (incomplete)" : fmtCost(totals().cost)}{totals().estimated ? " est." : ""}</text>
    </box>
  }
  api.slots.register({ slots: { sidebar_content: (_context, props) => <Sidebar session_id={props.session_id} /> } })
}

export default { id: "session-cost", tui }
