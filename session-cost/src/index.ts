import { tool, type Plugin } from "@opencode-ai/plugin"

/** Rates per 1M tokens, as published by providers / models.dev. */
type Rates = {
  input: number
  output: number
  cache_read: number
  cache_write: number
}

type Usage = {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  cost: number
  reportedCost: number
  messages: number
  durationMs: number
}

const emptyUsage = (): Usage => ({
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  reportedCost: 0,
  messages: 0,
  durationMs: 0,
})

function addUsage(target: Usage, delta: Usage): void {
  target.input += delta.input
  target.output += delta.output
  target.reasoning += delta.reasoning
  target.cacheRead += delta.cacheRead
  target.cacheWrite += delta.cacheWrite
  target.cost += delta.cost
  target.reportedCost += delta.reportedCost
  target.messages += delta.messages
  target.durationMs += delta.durationMs
}

function fmtInt(n: number): string {
  return Math.round(n).toLocaleString("en-US")
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return fmtInt(n)
}

function fmtCost(cost: number): string {
  if (cost >= 1) return `$${cost.toFixed(2)}`
  if (cost >= 0.01) return `$${cost.toFixed(3)}`
  return `$${cost.toFixed(4)}`
}

function fmtMs(ms: number): string {
  if (ms >= 60_000) {
    const minutes = Math.floor(ms / 60_000)
    const seconds = Math.round((ms % 60_000) / 1000)
    return `${minutes}m${seconds > 0 ? ` ${seconds}s` : ""}`
  }
  return `${(ms / 1000).toFixed(1)}s`
}

/**
 * Corrected rates for models where models.dev is known to be stale or wrong.
 * Keyed by "providerID/modelID", values are USD per 1M tokens.
 * Sources: official provider pricing pages.
 */
const KNOWN_RATES: Record<string, Rates> = {
  // Z.AI official pricing (https://docs.z.ai/guides/overview/pricing, verified 2026-09-17).
  // models.dev currently lists these at half price.
  "zai/glm-5.3-flash": { input: 0.15, output: 0.5, cache_read: 0.03, cache_write: 0 },
}

export type SessionCostOptions = {
  /** Toast duration in ms (default 8000) */
  toastDuration?: number
  /** Show per-turn wall-clock time (default true) */
  showTime?: boolean
  /** Show a second line with cumulative session totals (default true) */
  showSessionTotals?: boolean
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

type PriceTable = Map<string, Rates>

function parsePriceTable(json: unknown): PriceTable {
  const table: PriceTable = new Map()
  const providers = (json as Record<string, any>) ?? {}
  for (const [providerID, provider] of Object.entries(providers)) {
    const models = (provider as any)?.models as Record<string, any> | undefined
    if (!models) continue
    for (const [modelID, model] of Object.entries(models)) {
      const cost = model?.cost
      if (typeof cost?.input !== "number" || typeof cost?.output !== "number") continue
      const rates: Rates = {
        input: cost.input,
        output: cost.output,
        cache_read: typeof cost.cache_read === "number" ? cost.cache_read : 0,
        cache_write: typeof cost.cache_write === "number" ? cost.cache_write : 0,
      }
      table.set(`${providerID}/${modelID}`, rates)
      // Also index by modelID alone as a fallback for providers that rename models.
      if (!table.has(modelID)) table.set(modelID, rates)
    }
  }
  return table
}

export const SessionCostPlugin: Plugin = async ({ client }, options?: SessionCostOptions) => {
  const toastDuration = options?.toastDuration ?? 8000
  const showTime = options?.showTime ?? true
  const showSessionTotals = options?.showSessionTotals ?? true
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

  function computeCost(
    tokens: { input: number; output: number; cacheRead: number; cacheWrite: number },
    rates: Rates,
  ): number {
    return (
      (tokens.input * rates.input +
        tokens.output * rates.output +
        tokens.cacheRead * rates.cache_read +
        tokens.cacheWrite * rates.cache_write) /
      1_000_000
    )
  }

  // Per-turn and per-session cumulative usage, keyed by sessionID.
  const turn = new Map<string, Usage>()
  const session = new Map<string, Usage>()
  // When the current turn started (first user message of the turn).
  const turnStart = new Map<string, number>()
  // Assistant messages already counted, so repeated `message.updated` events don't double-count.
  const counted = new Set<string>()
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
          if (msg.role === "user") {
            if (!turnStart.has(msg.sessionID)) turnStart.set(msg.sessionID, msg.time.created)
            break
          }
          if (msg.role !== "assistant") break
          if (!msg.time?.completed) break
          if (counted.has(msg.id)) break
          counted.add(msg.id)
          if (counted.size > 5000) counted.clear()

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

          const usage: Usage = {
            input,
            output: output + reasoning,
            reasoning,
            cacheRead,
            cacheWrite,
            cost,
            reportedCost: reported,
            messages: 1,
            durationMs: Math.max(0, (msg.time.completed ?? 0) - (msg.time.created ?? 0)),
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
          await showToast(title, lines.join("\n"))
          break
        }

        case "session.deleted": {
          const sessionID = event.properties.info.id
          turn.delete(sessionID)
          session.delete(sessionID)
          turnStart.delete(sessionID)
          childSessions.delete(sessionID)
          break
        }
      }
    },
    tool: {
      cost: tool({
        description:
          "Get a token and cost report for the current opencode session: input/output/cache tokens, " +
          "per-turn and cumulative cost, computed with corrected provider rates. " +
          "Use whenever the user asks about cost, spend, tokens, or usage.",
        args: {},
        async execute(_args, context) {
          const sessionID = (context as { sessionID?: string } | undefined)?.sessionID
          const lines: string[] = []

          const report = (label: string, u: Usage): void => {
            lines.push(`${label}:`)
            lines.push(`  Responses: ${u.messages}`)
            lines.push(
              `  Tokens: ↑ ${fmtInt(u.input)} in (+${fmtInt(u.cacheRead)} cache read, +${fmtInt(u.cacheWrite)} cache write)  ↓ ${fmtInt(u.output)} out (${fmtInt(u.reasoning)} reasoning)`,
            )
            lines.push(`  Cost: ${fmtCost(u.cost)}`)
            if (Math.abs(u.cost - u.reportedCost) > Math.max(0.02 * u.reportedCost, 0.0001)) {
              lines.push(`  (opencode internally reports ${fmtCost(u.reportedCost)})`)
            }
          }

          const tracked = [...session.entries()]
          if (sessionID && session.has(sessionID)) {
            report("This session", session.get(sessionID)!)
          } else if (sessionID) {
            lines.push(`No usage tracked yet for session ${sessionID}.`)
          }

          const grand = emptyUsage()
          for (const [, u] of tracked) addUsage(grand, u)
          if (tracked.length > 1) {
            lines.push("")
            report(`All sessions since start (${tracked.length})`, grand)
          }
          if (lines.length === 0) return "No token usage tracked yet this run."
          return lines.join("\n")
        },
      }),
    },
  }
}