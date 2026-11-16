import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'))
const server = read('../server.json')
const card = read('../discovery/server-card.json')
const catalog = read('../discovery/ai-catalog.json')

test('the server card says what server.json says', () => {
  assert.equal(card.$schema, 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json')
  for (const field of ['name', 'version', 'title', 'description', 'websiteUrl', 'repository', 'icons', 'remotes']) {
    assert.deepEqual(card[field], server[field], field)
  }
})

test('the AI catalog points at the server card next to the MCP endpoint', () => {
  assert.equal(catalog.specVersion, '1.0')
  assert.equal(catalog.entries.length, 1)
  const [entry] = catalog.entries
  assert.equal(entry.type, 'application/mcp-server-card+json')
  assert.equal(entry.identifier, 'urn:air:cheapcarent.com:mcp:search')
  assert.equal(entry.url, `${server.remotes[0].url}/server-card`)
})
