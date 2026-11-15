import assert from 'node:assert/strict'
import test from 'node:test'

import { createLimiter } from '../src/client-limit.mjs'
import { API_TIMEOUT_MS, PAGE_NOTICE, apiHeaders, searchCars, shapeSearchPayload } from '../src/search.mjs'

const today = '2026-11-14'
const query = {
  country: 'ES',
  city: 'barcelona',
  pickup_date: '2026-12-01',
  return_date: '2026-12-04',
}

function offer(index) {
  return {
    brand: 'Sample',
    model: `Car ${index}`,
    category: 'economy',
    transmission: 'manual',
    seats: 5,
    company: 'Sample Supplier',
    price: 10,
    currency: 'EUR',
    url: `https://cheapcarent.com/collection?open=Sample+Car+${index}`,
    offerToken: `offer-token-${index}`,
    email: 'driver@example.com',
    phone: '+15551212000',
    dateOfBirth: '1990-01-01',
    gclid: 'gclid-sentinel',
    stripe: 'stripe-sentinel',
    payment: 'payment-sentinel',
    supplierTotal: 80,
    marketplaceFee: 12,
    markupPercent: 17,
    deepLink: 'https://partner.example/book?token=offer-token',
  }
}

test('a long 429 becomes a tool error and does not retry', async () => {
  let calls = 0
  const result = await searchCars(query, {
    today,
    limiter: createLimiter(),
    fetch: async () => {
      calls += 1
      return {
        status: 429,
        ok: false,
        headers: { get: (name) => (name.toLowerCase() === 'retry-after' ? '17' : null) },
        json: async () => ({ error: 'Too many requests.', status: 429 }),
      }
    },
  })
  assert.equal(result.isError, true)
  assert.match(result.message, /rate limited/)
  assert.match(result.message, /17/)
  assert.equal(result.retryAfterSeconds, 17)
  assert.equal(calls, 1)
})

test('eight offers are returned without throwing', async () => {
  const rows = Array.from({ length: 8 }, (_, index) => offer(index + 1))
  let thrown = false
  let result
  try {
    result = await searchCars({ ...query, limit: 8 }, {
      today,
      limiter: createLimiter(),
      fetch: async () => ({
        status: 200,
        ok: true,
        headers: { get: () => null },
        json: async () => ({
          data: rows,
          meta: {
            count: 8,
            currency: 'EUR',
            disclaimer: 'The live price is on the CheapCarRent website. Cancellation depends on the specific offer.',
            pricesCheckedAt: '2026-11-14T08:00:00Z',
            location: { city: 'Barcelona', countryCode: 'ES', page: 'https://cheapcarent.com/car-rental/es/barcelona' },
          },
        }),
      }),
    })
  } catch {
    thrown = true
  }
  assert.equal(thrown, false)
  assert.equal(result.isError, false)
  assert.equal(result.body.data.length, 8)
  assert.equal(result.body.notice, PAGE_NOTICE)
  assert.equal(result.body.data[7].model, 'Car 8')
  assert.equal(result.body.data[0].url, 'https://cheapcarent.com/collection?open=Sample+Car+1')
  assert.equal(result.body.meta.pricesCheckedAt, '2026-11-14T08:00:00Z')
  const encoded = JSON.stringify(result.body)
  for (const secret of ['offer-token', 'driver@example.com', '+15551212000', '1990-01-01', 'gclid-sentinel', 'stripe-sentinel', 'payment-sentinel', 'supplierTotal', 'marketplaceFee', 'markupPercent']) {
    assert.equal(encoded.includes(secret), false, secret)
  }
})

test('the shaper drops booking tokens and keeps a page of eight', () => {
  const shaped = shapeSearchPayload({
    data: Array.from({ length: 8 }, (_, index) => offer(index + 1)),
    meta: { count: 8, disclaimer: 'The live price is on the CheapCarRent website. Cancellation depends on the specific offer.' },
  })
  assert.equal(shaped.data.length, 8)
  assert.equal(Object.hasOwn(shaped.data[0], 'offerToken'), false)
  assert.equal(shaped.notice, PAGE_NOTICE)
})

test('forty quick searches from one client: twenty pass, the rest get Retry-After without an API call', async () => {
  let calls = 0
  const fetch = async () => {
    calls += 1
    return { status: 200, ok: true, headers: { get: () => null }, json: async () => ({ data: [], meta: { count: 0 } }) }
  }
  const limiter = createLimiter()
  const results = await Promise.all(Array.from({ length: 40 }, () => searchCars(query, { today, fetch, limiter, clientIp: '203.0.113.7', now: () => 1_000_000 })))
  const refused = results.filter((r) => r.isError)
  assert.equal(calls, 20)
  assert.equal(refused.length, 20)
  assert.ok(refused.every((r) => r.retryAfterSeconds === 60))
})

test('another client keeps its own share', async () => {
  const fetch = async () => ({ status: 200, ok: true, headers: { get: () => null }, json: async () => ({ data: [], meta: { count: 0 } }) })
  const limiter = createLimiter()
  const now = () => 1_000_000
  await Promise.all(Array.from({ length: 20 }, () => searchCars(query, { today, fetch, limiter, clientIp: '203.0.113.7', now })))
  const other = await searchCars(query, { today, fetch, limiter, clientIp: '198.51.100.9', now })
  assert.equal(other.isError, false)
})

test('the ceiling for all clients together holds', () => {
  const limiter = createLimiter({ perClient: 20, total: 3 })
  assert.equal(limiter.take('a', 0).ok, true)
  assert.equal(limiter.take('b', 1).ok, true)
  assert.equal(limiter.take('c', 2).ok, true)
  const refused = limiter.take('d', 3)
  assert.equal(refused.ok, false)
  assert.equal(refused.waitMs, 60_000 - 3)
  assert.equal(limiter.take('d', 60_001).ok, true)
})

test('a slot that frees within 3 seconds is waited for, not refused', async () => {
  const limiter = createLimiter({ perClient: 1, total: 100 })
  let clock = 0
  const waited = []
  limiter.take('203.0.113.7', 0)
  clock = 58_500
  const fetch = async () => ({ status: 200, ok: true, headers: { get: () => null }, json: async () => ({ data: [], meta: { count: 0 } }) })
  const result = await searchCars(query, {
    today, fetch, limiter, clientIp: '203.0.113.7',
    now: () => clock,
    sleep: async (ms) => { waited.push(ms); clock += ms },
  })
  assert.equal(result.isError, false)
  assert.deepEqual(waited, [1_500])
})

test('a short API 429 is waited out once and retried', async () => {
  let calls = 0
  const waited = []
  const result = await searchCars(query, {
    today,
    limiter: createLimiter(),
    sleep: async (ms) => { waited.push(ms) },
    fetch: async () => {
      calls += 1
      if (calls === 1) return { status: 429, ok: false, headers: { get: () => '2' }, json: async () => ({}) }
      return { status: 200, ok: true, headers: { get: () => null }, json: async () => ({ data: [], meta: { count: 0 } }) }
    },
  })
  assert.equal(result.isError, false)
  assert.equal(calls, 2)
  assert.deepEqual(waited, [2_000])
})

test('the API key and client address are sent only when the key is configured', () => {
  const keyed = apiHeaders({ apiKey: 'k'.repeat(64), clientIp: '203.0.113.7' })
  assert.equal(keyed['x-ccr-mcp-key'], 'k'.repeat(64))
  assert.equal(keyed['x-ccr-client-ip'], '203.0.113.7')
  const plain = apiHeaders({ apiKey: '', clientIp: '203.0.113.7' })
  assert.equal(Object.hasOwn(plain, 'x-ccr-mcp-key'), false)
  assert.equal(Object.hasOwn(plain, 'x-ccr-client-ip'), false)
})

test('mixed currencies reach the client with the EUR comparison field', () => {
  const shaped = shapeSearchPayload({
    data: [offer(1)],
    meta: { count: 1, currency: null, currencies: ['EUR', 'USD', 'bad'], priceEurCurrency: 'EUR' },
  })
  assert.deepEqual(shaped.meta.currencies, ['EUR', 'USD'])
  assert.equal(shaped.meta.priceEurCurrency, 'EUR')
  assert.equal(Object.hasOwn(shaped.meta, 'currency'), false)
})

/** A fetch that never answers on its own and rejects only when its signal aborts. */
function hangingFetch(seen) {
  return (url, init) => new Promise((resolve, reject) => {
    seen.signal = init.signal
    init.signal?.addEventListener('abort', () => reject(init.signal.reason))
  })
}

test('the API call gives up after 25 seconds by default', () => {
  assert.equal(API_TIMEOUT_MS, 25_000)
})

test('a search the API does not answer in time becomes a readable error, not a hang', async () => {
  const seen = {}
  const started = Date.now()
  const result = await searchCars(query, { today, limiter: createLimiter(), timeoutMs: 30, fetch: hangingFetch(seen) })
  assert.ok(seen.signal, 'the fetch gets an abort signal')
  assert.ok(Date.now() - started < 2_000)
  assert.equal(result.isError, true)
  assert.match(result.message, /did not answer within/)
  assert.match(result.message, /again/)
  assert.equal(result.retryAfterSeconds, undefined)
})
