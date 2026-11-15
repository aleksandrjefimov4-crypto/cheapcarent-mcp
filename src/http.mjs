import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types.js'

import { clientAddress, requestContext } from './request-context.mjs'
import { TOOL_NAMES, createMcpServer } from './server.mjs'

export const MCP_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id, Retry-After',
  'Cache-Control': 'no-store',
}

export async function handleMcpNodeRequest(req, res, rawBody) {
  for (const [name, value] of Object.entries(MCP_CORS)) {
    if (!res.headersSent) res.setHeader(name, value)
  }
  if (req.method === 'OPTIONS') {
    res.statusCode = 204
    res.end()
    return
  }
  if (req.method !== 'POST' && req.method !== 'DELETE') {
    // Stateless server: no standalone SSE stream, so GET is not offered.
    res.statusCode = 405
    res.setHeader('Allow', 'POST, DELETE, OPTIONS')
    res.end()
    return
  }

  let raw = rawBody
  if (raw === undefined) {
    try {
      raw = await readBody(req)
    } catch (error) {
      res.statusCode = error?.code === 'BODY_TOO_LARGE' ? 413 : 400
      res.setHeader('Connection', 'close')
      res.end()
      return
    }
  }
  let parsed
  if (raw) {
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = undefined
    }
  }

  const refusal = protocolRefusal(parsed)
  if (refusal) {
    res.statusCode = refusal.status
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ jsonrpc: '2.0', error: refusal.error, id: refusal.id }))
    return
  }

  const server = createMcpServer()
  // JSON answers (not SSE): headers go out after the tool ran, so Retry-After can be set.
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  try {
    await server.connect(transport)
    await requestContext.run({ res, clientIp: clientAddress(req) }, () => transport.handleRequest(req, res, parsed))
  } catch {
    if (!res.headersSent) {
      res.statusCode = 500
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ error: 'The MCP server could not handle this request.' }))
    }
  } finally {
    await transport.close().catch(() => {})
    await server.close().catch(() => {})
  }
}

/**
 * Errors the SDK reports with the wrong JSON-RPC code: well-formed JSON that is not a JSON-RPC
 * message is -32600 Invalid Request, not -32700 Parse error; a call to a tool that does not
 * exist is -32602 Invalid params, not a tool result. Unparseable bodies stay with the SDK (-32700).
 */
export function protocolRefusal(parsed) {
  if (parsed === undefined) return null
  const messages = Array.isArray(parsed) ? parsed : [parsed]
  if (messages.length === 0 || !messages.every((message) => JSONRPCMessageSchema.safeParse(message).success)) {
    const id = !Array.isArray(parsed) && (typeof parsed?.id === 'string' || Number.isInteger(parsed?.id)) ? parsed.id : null
    return { status: 400, id, error: { code: -32600, message: 'Invalid Request: not a JSON-RPC 2.0 message.' } }
  }
  if (!Array.isArray(parsed) && parsed.method === 'tools/call' && !TOOL_NAMES.includes(parsed.params?.name)) {
    return { status: 200, id: parsed.id ?? null, error: { code: -32602, message: `Unknown tool. Available tools: ${TOOL_NAMES.join(', ')}.` } }
  }
  return null
}

export const MAX_BODY_BYTES = 64 * 1024

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        const error = new Error('body too large')
        error.code = 'BODY_TOO_LARGE'
        req.removeAllListeners('data')
        req.resume()
        reject(error)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export function createHttpServer() {
  return createServer((req, res) => {
    const path = (req.url || '/').split('?')[0]
    if (path !== '/mcp') {
      res.statusCode = 404
      res.end()
      return
    }
    handleMcpNodeRequest(req, res).catch(() => {
      if (!res.headersSent) {
        res.statusCode = 500
        res.end()
      }
    })
  })
}

function listen() {
  const port = Number(process.env.PORT || 8787)
  createHttpServer().listen(port, process.env.HOST || '127.0.0.1')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) listen()
