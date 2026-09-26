/**
 * Shared, pure accounting helpers: token normalization, pricing, aggregation,
 * and formatting. No runtime startup, event registration, or I/O lives here —
 * the server plugin, a TUI plugin, and the remote server can all import this
 * module and get identical numbers from the same inputs.
 */

/** Rates per 1M tokens, as published by providers / models.dev. */
export type Rates = {
  input: number
  output: number
  cache_read: number
  cache_write: number
}

/**
 * One normalized usage record. Raw token counters are kept separate: never
 * add `reasoning` into `output` or cache fields into `input` automatically —
 * whether a provider's `output` already includes reasoning and whether
 * `input` includes cache reads must be decided explicitly by the caller.
 */
export type Usage = {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  /** Cost recomputed from tokens with our rate table (an estimate). */
  cost: number
  /** Cost recorded by opencode/provider at message time. */
  reportedCost: number
  messages: number
  durationMs: number
}

export const emptyUsage = (): Usage => ({
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

export function addUsage(target: Usage, delta: Usage): void {
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

export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString("en-US")
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return fmtInt(n)
}

export function fmtCost(cost: number): string {
  if (cost >= 1) return `$${cost.toFixed(2)}`
  if (cost >= 0.01) return `$${cost.toFixed(3)}`
  return `$${cost.toFixed(4)}`
}

export function fmtMs(ms: number): string {
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
export const KNOWN_RATES: Record<string, Rates> = {
  // Z.AI official pricing (https://docs.z.ai/guides/overview/pricing, verified 2026-09-17).
  // models.dev currently lists these at half price.
  "zai/glm-5.3-flash": { input: 0.15, output: 0.5, cache_read: 0.03, cache_write: 0 },
}

export type PriceTable = Map<string, Rates>

export function parsePriceTable(json: unknown): PriceTable {
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

/**
 * Normalize a raw stored assistant message into a Usage record.
 * `input`/`output` are taken verbatim; `reasoning` and cache counters stay in
 * their own fields so overlapping provider semantics never double-count.
 */
export function usageFromMessage(
  msg: {
    tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
    cost?: number
    time?: { created?: number; completed?: number }
  },
  cost: number,
): Usage {
  const created = msg.time?.created ?? 0
  const completed = msg.time?.completed ?? 0
  return {
    input: msg.tokens?.input ?? 0,
    output: msg.tokens?.output ?? 0,
    reasoning: msg.tokens?.reasoning ?? 0,
    cacheRead: msg.tokens?.cache?.read ?? 0,
    cacheWrite: msg.tokens?.cache?.write ?? 0,
    cost,
    reportedCost: msg.cost ?? 0,
    messages: 1,
    durationMs: created > 0 && completed > 0 ? Math.max(0, completed - created) : 0,
  }
}

/**
 * Cost from tokens at the given rates. This is an estimate whenever the
 * provider's recorded `cost` is available — label it as such at the surface.
 */
export function computeCost(
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
