import assert from 'node:assert/strict'
import test from 'node:test'

import { listLocations, resetLocationCache } from '../src/locations.mjs'

const rows = [
  { country: 'Albania', countryCode: 'AL', city: 'Tirana', cityParam: 'tirana', iata: 'TIA', hasAirport: true, alsoAccepted: ['tirane'], page: 'https://cheapcarent.com/car-rental/al/tirana', internalId: 414, supplierToken: 'secret-token' },
  { country: 'Albania', countryCode: 'AL', city: 'Saranda', cityParam: 'saranda', hasAirport: false, page: 'https://cheapcarent.com/car-rental/al/saranda' },
  { country: 'Spain', countryCode: 'ES', city: 'Málaga', cityParam: 'malaga', iata: 'AGP', hasAirport: true, page: 'https://cheapcarent.com/car-rental/es/malaga' },
  { country: 'Spain', countryCode: 'ES', city: 'Bad <script>', cityParam: 'bad slug!', page: 'https://evil.example/x' },
]

function okFetch(counter) {
  return async (url) => {
    counter.calls += 1
    counter.url = url
    return { status: 200, ok: true, headers: { get: () => null }, json: async () => ({ data: rows, meta: { count: 4 } }) }
  }
}

test('returns whitelisted fields only and drops malformed rows', async () => {
  resetLocationCache()
  const counter = { calls: 0 }
  const result = await listLocations({}, { fetch: okFetch(counter) })
  assert.equal(result.isError, false)
  assert.equal(result.body.data.length, 3)
  assert.equal(result.body.meta.total, 3)
  const tirana = result.body.data.find((row) => row.cityParam === 'tirana')
  assert.deepEqual(Object.keys(tirana).sort(), ['alsoAccepted', 'city', 'cityParam', 'country', 'countryCode', 'hasAirport', 'iata', 'page'])
  const encoded = JSON.stringify(result.body)
  assert.equal(encoded.includes('secret-token'), false)
  assert.equal(encoded.includes('evil.example'), false)
  assert.match(counter.url, /\/api\/v1\/public\/locations$/)
})

test('filters by country, airports only and a text query (accent-insensitive, aliases, IATA)', async () => {
  resetLocationCache()
  const opts = { fetch: okFetch({ calls: 0 }) }
  assert.deepEqual((await listLocations({ country: 'al' }, opts)).body.data.map((r) => r.cityParam), ['tirana', 'saranda'])
  assert.deepEqual((await listLocations({ country: 'AL', airports_only: true }, opts)).body.data.map((r) => r.cityParam), ['tirana'])
  assert.deepEqual((await listLocations({ query: 'malaga' }, opts)).body.data.map((r) => r.cityParam), ['malaga'])
  assert.deepEqual((await listLocations({ query: 'tirane' }, opts)).body.data.map((r) => r.cityParam), ['tirana'])
  assert.deepEqual((await listLocations({ query: 'agp' }, opts)).body.data.map((r) => r.cityParam), ['malaga'])
  const none = await listLocations({ query: 'atlantis' }, opts)
  assert.equal(none.isError, false)
  assert.equal(none.body.data.length, 0)
})

test('the list is fetched once and then served from memory', async () => {
  resetLocationCache()
  const counter = { calls: 0 }
  const opts = { fetch: okFetch(counter) }
  await listLocations({}, opts)
  await listLocations({ country: 'ES' }, opts)
  assert.equal(counter.calls, 1)
})

test('a 429 becomes a tool error and does not retry', async () => {
  resetLocationCache()
  let calls = 0
  const result = await listLocations({}, {
    fetch: async () => {
      calls += 1
      return { status: 429, ok: false, headers: { get: (n) => (n.toLowerCase() === 'retry-after' ? '9' : null) }, json: async () => ({}) }
    },
  })
  assert.equal(result.isError, true)
  assert.match(result.message, /9 seconds/)
  assert.equal(result.retryAfterSeconds, 9)
  assert.equal(calls, 1)
})

test('bad input is rejected before any request', async () => {
  resetLocationCache()
  const counter = { calls: 0 }
  const opts = { fetch: okFetch(counter) }
  assert.equal((await listLocations({ country: 'Spain' }, opts)).isError, true)
  assert.equal((await listLocations({ extra: 1 }, opts)).isError, true)
  assert.equal(counter.calls, 0)
})

test('an exact airport code or city name is listed before partial matches', async () => {
  resetLocationCache()
  const extra = [
    { country: 'Greece', countryCode: 'GR', city: 'Heraklion', cityParam: 'heraklion', iata: 'HER', hasAirport: true, page: 'https://cheapcarent.com/car-rental/gr/heraklion' },
    { country: 'Morocco', countryCode: 'MA', city: 'Marrakesh', cityParam: 'marrakesh', iata: 'RAK', hasAirport: true, page: 'https://cheapcarent.com/car-rental/ma/marrakesh' },
  ]
  const fetch = async () => ({ status: 200, ok: true, headers: { get: () => null }, json: async () => ({ data: extra }) })
  const result = await listLocations({ query: 'rak' }, { fetch })
  assert.deepEqual(result.body.data.map((r) => r.iata), ['RAK', 'HER'])
})

test('an unknown country code is an error that names the covered countries', async () => {
  resetLocationCache()
  const result = await listLocations({ country: 'ZZ' }, { fetch: okFetch({ calls: 0 }) })
  assert.equal(result.isError, true)
  assert.match(result.message, /ZZ/)
  assert.match(result.message, /AL/)
  assert.match(result.message, /ES/)
})

test('a known country with a query that matches nothing is still an empty list', async () => {
  resetLocationCache()
  const result = await listLocations({ country: 'ES', query: 'atlantis' }, { fetch: okFetch({ calls: 0 }) })
  assert.equal(result.isError, false)
  assert.equal(result.body.data.length, 0)
})

test('a location list the API does not send in time becomes a readable error', async () => {
  resetLocationCache()
  let signal
  const result = await listLocations({}, {
    timeoutMs: 30,
    fetch: (url, init) => new Promise((resolve, reject) => {
      signal = init.signal
      init.signal?.addEventListener('abort', () => reject(init.signal.reason))
    }),
  })
  assert.ok(signal, 'the fetch gets an abort signal')
  assert.equal(result.isError, true)
  assert.match(result.message, /did not answer within/)
})
