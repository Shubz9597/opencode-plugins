import { tool, type Plugin } from "@opencode-ai/plugin"
import {
  addUsage,
  computeCost,
  emptyUsage,
  fmtCost,
  fmtMs,
  fmtTokens,
  KNOWN_RATES,
  parsePriceTable,
  usageFromMessage,
  type PriceTable,
  type Rates,
  type Usage,
} from "./accounting"

export type SessionCostOptions = {
  /** Toast duration in ms (default 8000) */
  toastDuration?: number
  /** Show per-turn wall-clock time (default true) */
  showTime?: boolean
  /** Show a second line with cumulative session totals (default true) */
  showSessionTotals?: boolean
  /** Show the per-turn toast at the end of each response (default true) */
  toast?: boolean
  /** Where to fetch per-model pricing from (default models.dev) */
  pricingUrl?: string
  /** How often to re-fetch pricing, in ms (default 6 hours) */
  pricingRefreshMs?: number
  /**
   * Rate overrides, keyed by "providerID/modelID" (or just "modelID" to match
   * any provider). USD per 1M tokens. Takes priority over built-in corrections
   * and fetched pricing.
   */
  rates?: Record<string, Rates>
  /** Prefer opencode's own reported cost over recomputed cost (default false) */
  useReportedCost?: boolean
}

export const SessionCostPlugin: Plugin = async ({ client, directory }, options?: SessionCostOptions) => {
  const toastDuration = options?.toastDuration ?? 8000
  const showTime = options?.showTime ?? true
  const showSessionTotals = options?.showSessionTotals ?? true
  const toastEnabled = options?.toast ?? true
  const pricingUrl = options?.pricingUrl ?? "https://models.dev/api.json"
  const pricingRefreshMs = options?.pricingRefreshMs ?? 6 * 60 * 60 * 1000
  const useReportedCost = options?.useReportedCost ?? false

  let priceTable: PriceTable = new Map()
  let priceFetchedAt = 0

  const fetchPricing = async (): Promise<void> => {
    try {
      const res = await fetch(pricingUrl, { signal: AbortSignal.timeout(10_000) })
      if (!res.ok) return
      priceTable = parsePriceTable(await res.json())
      priceFetchedAt = Date.now()
    } catch {
      // Offline or rate-limited — keep whatever table we have; costs fall back
      // to opencode's reported numbers.
    }
  }

  const maybeRefreshPricing = (): void => {
    if (Date.now() - priceFetchedAt < pricingRefreshMs) return
    priceFetchedAt = Date.now() // avoid stampeding refreshes on every event
    void fetchPricing()
  }

  const lookupRates = (providerID: string, modelID: string): Rates | undefined => {
    const user = options?.rates
    if (user) {
      const exact = user[`${providerID}/${modelID}`]
      if (exact) return exact
      const modelOnly = user[modelID]
      if (modelOnly) return modelOnly
    }
    const known = KNOWN_RATES[`${providerID}/${modelID}`] ?? KNOWN_RATES[modelID]
    if (known) return known
    return priceTable.get(`${providerID}/${modelID}`) ?? priceTable.get(modelID)
  }

  // Per-turn and per-session cumulative usage, keyed by sessionID.
  const turn = new Map<string, Usage>()
  const session = new Map<string, Usage>()
  // When the current turn started (first user message of the turn).
  const turnStart = new Map<string, number>()
  // Assistant messages already counted, so repeated `message.updated` events
  // don't double-count. This set is intentionally never cleared: clearing it
  // and recounting history would inflate session totals. IDs are small;
  // tens of thousands cost only a few MB.
  const counted = new Set<string>()
  // Latest usage per message ID, so a late/corrected `message.updated` can
  // replace the old record and apply its difference instead of double-counting.
  const perMessage = new Map<string, { sessionID: string; usage: Usage }>()
  // Child (subagent/task) sessions — we don't toast for those to avoid noise.
  const childSessions = new Set<string>()

  const bump = (map: Map<string, Usage>, sessionID: string, delta: Usage): void => {
    const total = map.get(sessionID) ?? emptyUsage()
    addUsage(total, delta)
    map.set(sessionID, total)
  }

  const showToast = async (title: string, message: string): Promise<void> => {
    try {
      await client.tui.showToast({
        body: { title, message, variant: "info", duration: toastDuration },
      })
    } catch {
      // Not running inside the TUI (or toast unavailable) — silently ignore.
    }
  }

  void fetchPricing()

  return {
    event: async ({ event }) => {
      switch (event.type) {
        case "session.created":
        case "session.updated": {
          const info = event.properties.info
          if (info.parentID) childSessions.add(info.id)
          else childSessions.delete(info.id)
          break
        }

        case "message.updated": {
          const msg = event.properties.info
          if (!msg?.id) break
          if (msg.role === "user") {
            if (!turnStart.has(msg.sessionID)) turnStart.set(msg.sessionID, msg.time.created)
            break
          }
          if (msg.role !== "assistant") break
          if (!msg.time?.completed) break

          const input = msg.tokens?.input ?? 0
          const output = msg.tokens?.output ?? 0
          const reasoning = msg.tokens?.reasoning ?? 0
          const cacheRead = msg.tokens?.cache?.read ?? 0
          const cacheWrite = msg.tokens?.cache?.write ?? 0
          const reported = msg.cost ?? 0

          const rates = lookupRates(msg.providerID, msg.modelID)
          const cost = useReportedCost
            ? reported
            : rates
              ? computeCost({ input, output, cacheRead, cacheWrite }, rates)
              : reported

          const usage = usageFromMessage(msg, cost)

          if (counted.has(msg.id)) {
            // Reconciliation: replace the old record and apply its difference.
            const prev = perMessage.get(msg.id)
            if (prev) {
              const inverse = emptyUsage()
              addUsage(inverse, prev.usage)
              for (const key of Object.keys(inverse) as Array<keyof Usage>) {
                inverse[key] = -inverse[key]
              }
              bump(turn, prev.sessionID, inverse)
              bump(session, prev.sessionID, inverse)
            }
          } else {
            counted.add(msg.id)
          }
          perMessage.set(msg.id, { sessionID: msg.sessionID, usage })
          if (perMessage.size > 10_000) {
            // Memory bound only — drop the oldest per-message records; session
            // totals already include them and `counted` still guards replays.
            const oldest = perMessage.keys().next().value
            if (oldest !== undefined) perMessage.delete(oldest)
          }
          bump(turn, msg.sessionID, usage)
          bump(session, msg.sessionID, usage)
          break
        }

        case "session.idle": {
          const sessionID = event.properties.sessionID
          if (childSessions.has(sessionID)) break
          maybeRefreshPricing()

          const turnUsage = turn.get(sessionID)
          const started = turnStart.get(sessionID)
          turnStart.delete(sessionID)
          if (!turnUsage || turnUsage.messages === 0) break
          turn.delete(sessionID)

          const wallMs = started && started > 0 ? Math.max(0, Date.now() - started) : turnUsage.durationMs

          const cachePart = turnUsage.cacheRead > 0 ? ` (+${fmtTokens(turnUsage.cacheRead)} cache)` : ""
          const lines: string[] = []
          if (showTime) lines.push(`Time: ${fmtMs(wallMs)}`)
          lines.push(
            `Tokens: ↑ ${fmtTokens(turnUsage.input)}${cachePart}  ↓ ${fmtTokens(turnUsage.output)}` +
              (turnUsage.reasoning > 0 ? `  (reasoning ${fmtTokens(turnUsage.reasoning)})` : ""),
          )
          lines.push(`Cost: ${fmtCost(turnUsage.cost)}`)
          if (Math.abs(turnUsage.cost - turnUsage.reportedCost) > Math.max(0.02 * turnUsage.reportedCost, 0.0001)) {
            lines.push(`(opencode reported ${fmtCost(turnUsage.reportedCost)})`)
          }

          if (showSessionTotals) {
            const total = session.get(sessionID) ?? emptyUsage()
            lines.push(
              `Session: ↑ ${fmtTokens(total.input)}  ↓ ${fmtTokens(total.output)}  ${fmtCost(total.cost)}`,
            )
          }

          const title = `Response ${fmtCost(turnUsage.cost)} · ${turnUsage.messages} message${turnUsage.messages > 1 ? "s" : ""}`
          if (toastEnabled) await showToast(title, lines.join("\n"))
          break
        }

        case "session.deleted": {
          const sessionID = event.properties.info.id
          turn.delete(sessionID)
          session.delete(sessionID)
          turnStart.delete(sessionID)
          childSessions.delete(sessionID)
          for (const [msgID, rec] of perMessage) {
            if (rec.sessionID === sessionID) perMessage.delete(msgID)
          }
          break
        }
      }
    },
    tool: {
      cost: tool({
        description:
          "Get a compact token and cost report for ALL opencode sessions in this project, one line per " +
          "session: input/output/cache tokens and total cost, summed from stored messages at the provider's " +
          "rates (matches what the provider actually deducts). " +
          "Use whenever the user asks about cost, spend, tokens, or usage. " +
          "Reply with ONLY the text this tool returns, nothing else.",
        args: {},
        async execute() {
          const sessionsRes = await client.session
            .list({ query: { directory } })
            .catch(() => ({ data: [] as Array<any> }))
          const rows: Array<{
            title: string
            id: string
            input: number
            output: number
            cacheRead: number
            cost: number
          }> = []

          for (const s of sessionsRes.data ?? []) {
            if (s.parentID) continue
            const msgs = await client.session
              .messages({ path: { id: s.id }, query: { directory } })
              .catch(() => ({ data: [] as Array<any> }))
            let input = 0
            let output = 0
            let cacheRead = 0
            let cacheWrite = 0
            let cost = 0
            let count = 0
            for (const { info } of msgs.data ?? []) {
              if (info.role !== "assistant") continue
              const tIn = info.tokens?.input ?? 0
              const tOut = info.tokens?.output ?? 0
              const tCacheRead = info.tokens?.cache?.read ?? 0
              const tCacheWrite = info.tokens?.cache?.write ?? 0
              const reported = info.cost ?? 0
              // Same policy as the toast: recompute from tokens when we have
              // rates, so this surface cannot disagree with the sidebar/toast.
              const c =
                useReportedCost || !info.providerID
                  ? reported
                  : (() => {
                      const rates = lookupRates(info.providerID, info.modelID)
                      return rates
                        ? computeCost({ input: tIn, output: tOut, cacheRead: tCacheRead, cacheWrite: tCacheWrite }, rates)
                        : reported
                    })()
              input += tIn
              output += tOut
              cacheRead += tCacheRead
              cacheWrite += tCacheWrite
              cost += c
              count++
            }
            if (count === 0) continue
            rows.push({ title: s.title || s.id, id: s.id, input, output, cacheRead, cost })
          }

          if (rows.length === 0) return "No token usage recorded in any session yet."

          rows.sort((a, b) => b.cost - a.cost)
          const maxRows = 15
          const shown = rows.slice(0, maxRows)
          const titleWidth = Math.min(38, Math.max(...shown.map((r) => r.title.length)))

          const lines: string[] = []
          lines.push(
            "SESSION".padEnd(titleWidth) +
              "  " +
              "INPUT(+CACHE)".padStart(18) +
              "  " +
              "OUTPUT".padStart(10) +
              "  " +
              "COST",
          )
          for (const r of shown) {
            const title = r.title.length > titleWidth ? r.title.slice(0, titleWidth - 1) + "…" : r.title
            lines.push(
              title.padEnd(titleWidth) +
                "  " +
                `${fmtTokens(r.input)}(+${fmtTokens(r.cacheRead)})`.padStart(18) +
                "  " +
                fmtTokens(r.output).padStart(10) +
                "  " +
                fmtCost(r.cost),
            )
          }

          const total = rows.reduce(
            (acc, r) => {
              acc.input += r.input
              acc.output += r.output
              acc.cacheRead += r.cacheRead
              acc.cost += r.cost
              return acc
            },
            { input: 0, output: 0, cacheRead: 0, cost: 0 },
          )

          lines.push("-".repeat(titleWidth + 55))
          if (rows.length > maxRows) {
            const rest = rows.slice(maxRows).reduce((acc, r) => acc + r.cost, 0)
            lines.push(`(+${rows.length - maxRows} more sessions: ${fmtCost(rest)})`)
          }
          lines.push(
            `TOTAL (${rows.length} sessions)`.padEnd(titleWidth) +
              "  " +
              `${fmtTokens(total.input)}(+${fmtTokens(total.cacheRead)})`.padStart(18) +
              "  " +
              fmtTokens(total.output).padStart(10) +
              "  " +
              fmtCost(total.cost),
          )

          // Tab-separated copy for Excel / Sheets — raw numbers, one row per session.
          lines.push("")
          lines.push("TSV (select this block and copy straight into Excel):")
          lines.push(["session", "input_tokens", "cache_read_tokens", "output_tokens", "cost_usd"].join("\t"))
          for (const r of rows) {
            lines.push(
              [r.title.replace(/\t/g, " "), r.input, r.cacheRead, r.output, r.cost.toFixed(4)].join("\t"),
            )
          }
          lines.push(
            ["TOTAL", total.input, total.cacheRead, total.output, total.cost.toFixed(4)].join("\t"),
          )
          lines.push("")
          lines.push(
            "Cost = tokens x provider rates (overrides + models.dev; corrected rates take priority), " +
              "an estimate that should track provider invoices (minus non-token charges).",
          )
          return lines.join("\n")
        },
      }),
    },
  }
}