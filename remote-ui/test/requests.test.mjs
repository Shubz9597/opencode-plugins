import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import ts from 'typescript'
import { createOpencodeClient } from '@opencode-ai/sdk'

test('HTTP bridge recovers missed requests, routes ownership and preserves failed replies', async () => {
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText
    .replace('"./attention-client"', '"../src/attention-client.ts"')
    .replace('"../../session-cost/src/accounting"', '"../../session-cost/src/accounting.ts"')
  await mkdir(new URL('../.cache/', import.meta.url), { recursive: true })
  await writeFile(new URL('../.cache/fixture.mjs', import.meta.url), output)
  const nativeFetch = globalThis.fetch
  // No model calls or network pricing during this fixture.
  globalThis.fetch = async (...args) => String(args[0]).includes('models.dev') ? Response.json({}) : nativeFetch(...args)
  const { RemoteUIPlugin } = await import('../.cache/fixture.mjs')
  let permission = [{ id: 'perm', sessionID: 'child', permission: 'bash', patterns: ['echo fixture'] }]
  let question = [{ id: 'question', sessionID: 'child', questions: [{ question: 'Choose', header: 'Choice', options: [{ label: 'A', description: 'A' }] }] }]
  const replies = []
  let fail = true
  const client = createOpencodeClient({ baseUrl: 'http://runtime', fetch: async request => {
    const url = new URL(request.url)
    if (url.pathname === '/permission') return Response.json(permission)
    if (url.pathname === '/question') return Response.json(question)
    if (url.pathname === '/api/permission/request' || url.pathname === '/api/question/request') return Response.json({ location: { directory: 'Z:/owner' }, data: [] })
    if (/\/(reply|reject)$/.test(url.pathname)) {
      replies.push({ url: url.href, body: JSON.parse(await request.text()) })
      if (fail) return Response.json({ error: 'failure' }, { status: 500 })
      if (url.pathname.includes('permission')) permission = []
      else question = []
      return Response.json(true)
    }
    return Response.json(true)
  } })
  const plugin = await RemoteUIPlugin({ client, directory: 'Z:/owner' }, { port: 0, host: 'localhost', discoverProjects: false })
  try {
    const started = await plugin.tool.remote.execute({}, {})
    const base = started.match(/http:\/\/127\.0\.0\.1:\d+/)[0]
    const root = await nativeFetch(base + '/')
    assert.equal(root.headers.get('referrer-policy'), 'no-referrer')
    assert.equal(root.headers.get('x-frame-options'), 'DENY')
    await root.text()
    const outside = await nativeFetch(base + '/api/state?sessionID=fixture&directory=Z%3A%2Foutside')
    assert.equal(outside.status, 403, 'unknown directories must stay outside the exposed project scope')
    let attention = await nativeFetch(base + '/api/attention').then(r => r.json())
    assert.equal(attention.length, 2, 'missed events recovered from lists')
    assert.equal(attention.find(p => p.kind === 'question').questions.length, 1)
    const post = (path, body) => nativeFetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    let response = await post('/api/permissions', { sessionID: 'child', permissionID: 'perm', response: 'once' })
    assert.equal(response.status, 502)
    attention = await nativeFetch(base + '/api/attention').then(r => r.json())
    assert(attention.some(p => p.id === 'perm'))
    response = await post('/api/questions', { sessionID: 'child', questionID: 'question', answers: [['A']] })
    assert.equal(response.status, 502)
    assert(!replies.some(r => r.url.endsWith('/reject')), 'answer failure must never reject')
    fail = false
    response = await post('/api/questions', { sessionID: 'child', questionID: 'question', answers: [['A']] })
    assert.equal(response.status, 200)
    assert.deepEqual(replies.at(-1).body, { answers: [['A']] })
    assert.equal(new URL(replies.at(-1).url).searchParams.get('directory'), 'Z:/owner')
    permission = [] // answered from another client, no event delivered
    attention = await nativeFetch(base + '/api/attention').then(r => r.json())
    assert.equal(attention.length, 0, 'reconciliation removes already-resolved cards')
  } finally {
    await plugin.event({ event: { type: 'server.instance.disposed', properties: {} } })
    globalThis.fetch = nativeFetch
  }
})
