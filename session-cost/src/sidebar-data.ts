import { addUsage, computeCost, emptyUsage, KNOWN_RATES, usageFromMessage, type Rates } from "./accounting.ts"

export type CostMessage = Parameters<typeof usageFromMessage>[0] & {
  id: string; role: string; providerID?: string; modelID?: string
}

/** Each snapshot replaces a message by ID, including late usage corrections. */
export function summarize(messages: Iterable<CostMessage>, rates: Map<string, Rates>, overrides: Record<string, Rates> = {}, reported = false) {
  const total = emptyUsage()
  let unknown = 0
  let estimated = false
  const unique = new Map(Array.from(messages, m => [m.id, m]))
  for (const msg of unique.values()) {
    if (msg.role !== "assistant") continue
    const key = `${msg.providerID}/${msg.modelID}`
    const rate = overrides[key] ?? overrides[msg.modelID ?? ""] ?? KNOWN_RATES[key] ?? rates.get(key) ?? rates.get(msg.modelID ?? "")
    const usage = usageFromMessage(msg, 0)
    if (!reported && rate) {
      usage.cost = computeCost(usage, rate)
      estimated = true
    } else if (typeof msg.cost === "number") usage.cost = msg.cost
    else unknown++
    addUsage(total, usage)
  }
  return { ...total, unknown, estimated }
}

/** Follow the server cursor; the TUI's in-memory message window is incomplete. */
export async function loadMessages(fetchPage: (before?: string) => Promise<{ messages: CostMessage[]; next: string | null }>) {
  const messages = new Map<string, CostMessage>()
  const cursors = new Set<string>()
  let cursor: string | undefined
  do {
    const page = await fetchPage(cursor)
    for (const msg of page.messages) if (!messages.has(msg.id)) messages.set(msg.id, msg)
    if (!page.next) break
    if (cursors.has(page.next)) throw new Error("Repeated message cursor")
    cursors.add(page.next)
    cursor = page.next
  } while (true)
  return messages
}
