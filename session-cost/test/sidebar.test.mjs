import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadMessages, summarize } from '../src/sidebar-data.ts'

test('all pages count once and corrected messages replace previous counters', async () => {
  const msg = id => ({ id, role: 'assistant', cost: 0.1, tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 4, write: 3 } } })
  const rows = Array.from({ length: 205 }, (_, i) => msg(String(i)))
  let calls = 0
  const messages = await loadMessages(async cursor => {
    calls++
    const start = Number(cursor ?? 0)
    return { messages: rows.slice(start, start + 100), next: start + 100 < rows.length ? String(start + 100) : null }
  })
  assert.equal(calls, 3)
  assert.equal(summarize(messages.values(), new Map()).input, 2050)
  messages.set('0', { ...msg('0'), tokens: { input: 30 } })
  const usage = summarize(messages.values(), new Map())
  assert.equal(usage.messages, 205)
  assert.equal(usage.input, 2070)
  assert.equal(usage.output, 408)
  assert.equal(usage.cacheRead, 816)
})

test('zero cost, unknown cost, overrides and overlapping reasoning remain distinct', () => {
  const msg = { id: 'a', role: 'assistant', providerID: 'p', modelID: 'm', tokens: { input: 100, output: 20, reasoning: 10, cache: { read: 50, write: 5 } } }
  assert.equal(summarize([msg], new Map()).unknown, 1)
  assert.equal(summarize([{ ...msg, cost: 0 }], new Map()).unknown, 0)
  const usage = summarize([msg, msg], new Map(), { 'p/m': { input: 1, output: 2, cache_read: 0.1, cache_write: 1 } })
  assert.equal(usage.messages, 1)
  assert.equal(usage.cost, 0.00015)
  assert.equal(usage.estimated, true)
})
