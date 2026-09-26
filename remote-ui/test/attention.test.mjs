import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createOpencodeClient } from '@opencode-ai/sdk'
import { attentionClient } from '../src/attention-client.ts'

test('modern adapter retains injected transport and sends both reply protocols correctly', async () => {
  const requests = []
  const client = attentionClient(createOpencodeClient({ baseUrl: 'http://fixture', headers: { authorization: 'fixture-secret' }, fetch: async request => {
    requests.push({ url: request.url, auth: request.headers.get('authorization'), body: await request.text() })
    return Response.json(true)
  } }))
  await client.permission.reply({ requestID: 'p', directory: 'Z:/owner', reply: 'once' }, { throwOnError: true })
  await client.question.reply({ requestID: 'q', directory: 'Z:/owner', answers: [['A', 'B'], ['C']] }, { throwOnError: true })
  await client.v2.session.permission.reply({ sessionID: 's', requestID: 'p2', reply: 'reject' }, { throwOnError: true })
  await client.v2.session.question.reply({ sessionID: 's', requestID: 'q2', questionV2Reply: { answers: [['D']] } }, { throwOnError: true })
  assert(requests.every(r => r.auth === 'fixture-secret'))
  assert.match(requests[0].url, /permission\/p\/reply/)
  assert.match(requests[0].url, /directory=/)
  assert.deepEqual(JSON.parse(requests[1].body), { answers: [['A', 'B'], ['C']] })
  assert.match(requests[2].url, /api\/session\/s\/permission\/p2\/reply/)
  assert.deepEqual(JSON.parse(requests[3].body), { answers: [['D']] })
})

test('failed replies throw instead of reporting success', async () => {
  const client = attentionClient(createOpencodeClient({ baseUrl: 'http://fixture', fetch: async () => Response.json({ error: 'failed' }, { status: 500 }) }))
  await assert.rejects(client.permission.reply({ requestID: 'p', reply: 'once' }, { throwOnError: true }))
})
