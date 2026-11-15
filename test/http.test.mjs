import assert from 'node:assert/strict'
import test from 'node:test'

import { MAX_BODY_BYTES, createHttpServer } from '../src/http.mjs'

async function withServer(run) {
  const server = createHttpServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    await run(base)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }

const day = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)

/** A JSON body, or the data line of an SSE body. */
function parseRpc(text) {
  const line = text.split('\n').find((l) => l.startsWith('data: '))
  return JSON.parse(line ? line.slice(6) : text)
}

test('OPTIONS answers CORS preflight', async () => withServer(async (base) => {
  const res = await fetch(`${base}/mcp`, { method: 'OPTIONS' })
  assert.equal(res.status, 204)
  assert.equal(res.headers.get('access-control-allow-origin'), '*')
}))

test('GET is refused with 405 because the server keeps no SSE stream', async () => withServer(async (base) => {
  const res = await fetch(`${base}/mcp`, { headers: { accept: 'text/event-stream' } })
  assert.equal(res.status, 405)
  assert.match(res.headers.get('allow'), /POST/)
}))

test('a body over the cap gets 413', async () => withServer(async (base) => {
  const res = await fetch(`${base}/mcp`, { method: 'POST', headers, body: 'x'.repeat(MAX_BODY_BYTES + 1) })
  assert.equal(res.status, 413)
}))

test('other paths are 404', async () => withServer(async (base) => {
  assert.equal((await fetch(`${base}/`)).status, 404)
}))

test('initialize and tools/list work over Streamable HTTP', async () => withServer(async (base) => {
  const init = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }),
  })
  assert.equal(init.status, 200)
  const initText = await init.text()
  assert.match(initText, /cheapcarent-search/)
  const initResult = parseRpc(initText).result
  assert.notEqual(initResult.capabilities.tools?.listChanged, true, 'stateless server must not promise list_changed')
  const list = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { ...headers, 'mcp-protocol-version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
  })
  const text = await list.text()
  assert.match(text, /search_cars/)
  assert.match(text, /list_locations/)
}))

test('a rate-limited search answers with a standard Retry-After header', async () => withServer(async (base) => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.cheapcarent.com/')) {
      return new Response(JSON.stringify({ error: 'Too many requests.', status: 429 }), { status: 429, headers: { 'retry-after': '7' } })
    }
    return realFetch(url, init)
  }
  try {
    const res = await realFetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...headers, 'mcp-protocol-version': '2025-06-18' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_cars', arguments: { iata: 'RAK', pickup_date: day(30), return_date: day(32) } } }),
    })
    assert.equal(res.headers.get('retry-after'), '7')
    const result = parseRpc(await res.text()).result
    assert.equal(result.isError, true)
    assert.equal(result.structuredContent.retryAfterSeconds, 7)
  } finally {
    globalThis.fetch = realFetch
  }
}))

test('the client address is the one nginx saw, not what the client wrote first', async () => {
  const { clientAddress } = await import('../src/request-context.mjs')
  assert.equal(clientAddress({ headers: { 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '1.2.3.4, 203.0.113.7' } }), '203.0.113.7')
  assert.equal(clientAddress({ headers: { 'x-forwarded-for': '1.2.3.4, 203.0.113.7' } }), '203.0.113.7')
  assert.equal(clientAddress({ headers: { 'x-real-ip': 'nonsense' }, socket: { remoteAddress: '127.0.0.1' } }), '127.0.0.1')
})

test('JSON that is not JSON-RPC is -32600, bad JSON stays -32700, an unknown tool is -32602', async () => withServer(async (base) => {
  const post = (body) => fetch(`${base}/mcp`, { method: 'POST', headers: { ...headers, 'mcp-protocol-version': '2025-06-18' }, body })
  const notRpc = await post('{"hello":1}')
  assert.equal(notRpc.status, 400)
  assert.equal((await notRpc.json()).error.code, -32600)
  const noMethod = await post('{"jsonrpc":"2.0","id":8}')
  const noMethodBody = await noMethod.json()
  assert.equal(noMethodBody.error.code, -32600)
  assert.equal(noMethodBody.id, 8)
  const badJson = await post('{oops')
  assert.equal((await badJson.json()).error.code, -32700)
  const unknownTool = await post('{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"nope","arguments":{}}}')
  const unknownBody = await unknownTool.json()
  assert.equal(unknownBody.error.code, -32602)
  assert.equal(unknownBody.id, 6)
}))
