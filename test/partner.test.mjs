import assert from 'node:assert/strict'
import test from 'node:test'

import { createLimiter } from '../src/client-limit.mjs'
import { VISIT_BASE, partnerError, partnerLink, withPartnerLinks } from '../src/partner.mjs'
import { searchCars } from '../src/search.mjs'

const today = '2026-11-25'
const query = { iata: 'HER', pickup_date: '2026-12-10', return_date: '2026-12-14' }
const offerUrl = 'https://cheapcarent.com/collection?type=1&location=Heraklion%2C+Greece&date=2026-12-10%2C2026-12-14&open=Toyota+Aygo'
const cityPage = 'https://cheapcarent.com/car-rental/gr/heraklion'

function visitParams(link) {
  assert.ok(link.startsWith(VISIT_BASE), link)
  const url = new URL(link)
  return { code: url.pathname.split('/').pop(), to: url.searchParams.get('to'), subId: url.searchParams.get('sub_id') }
}

function apiAnswer() {
  return {
    status: 200,
    ok: true,
    headers: { get: () => null },
    json: async () => ({
      data: [
        { brand: 'Toyota', model: 'Aygo', price: 2.54, currency: 'EUR', url: offerUrl },
        { brand: 'Fiat', model: 'Panda', price: 3.1, currency: 'EUR' },
      ],
      meta: { count: 2, location: { city: 'Heraklion', page: cityPage } },
    }),
  }
}

test('partnerLink sends the site path through the partner visit link', () => {
  const p = visitParams(partnerLink(offerUrl, 'viatico'))
  assert.equal(p.code, 'viatico')
  assert.equal(p.to, offerUrl.slice('https://cheapcarent.com'.length))
  assert.equal(p.subId, null)
})

test('partnerLink keeps a sub id and drops a fragment', () => {
  const p = visitParams(partnerLink(`${cityPage}#offers`, 'viatico', 'chat-gpt_1'))
  assert.equal(p.to, '/car-rental/gr/heraklion')
  assert.equal(p.subId, 'chat-gpt_1')
})

test('partnerLink falls back to the path when the query is too long for the visit link', () => {
  const long = `https://cheapcarent.com/collection?x=${'a'.repeat(600)}`
  assert.equal(visitParams(partnerLink(long, 'viatico')).to, '/collection')
})

test('partnerLink leaves a URL that is not on cheapcarent.com alone', () => {
  assert.equal(partnerLink('https://example.com/collection', 'viatico'), 'https://example.com/collection')
  assert.equal(partnerLink('https://cheapcarent.com.evil.example/x', 'viatico'), 'https://cheapcarent.com.evil.example/x')
})

test('withPartnerLinks returns a new body and does not change the input', () => {
  const body = { data: [{ url: offerUrl }], meta: { location: { page: cityPage } }, notice: 'n' }
  const copy = structuredClone(body)
  const out = withPartnerLinks(body, 'viatico')
  assert.deepEqual(body, copy)
  assert.equal(visitParams(out.data[0].url).to.startsWith('/collection?'), true)
  assert.equal(visitParams(out.meta.location.page).to, '/car-rental/gr/heraklion')
  assert.equal(out.meta.partner, 'viatico')
  assert.equal(withPartnerLinks(body, undefined), body)
})

test('partnerError accepts codes and sub ids in the formats the site accepts', () => {
  assert.equal(partnerError({}), null)
  assert.equal(partnerError({ partner: 'viatico' }), null)
  assert.equal(partnerError({ partner: 'a1b2c3d4e5f6g7h8i9j0', partner_sub_id: 'claude_desktop-2' }), null)
  for (const partner of ['VI', 'Viatico', 'via tico', 'via/tico', 'x'.repeat(41), 12]) {
    assert.match(partnerError({ partner }), /Partner code/)
  }
  assert.match(partnerError({ partner_sub_id: 'abc' }), /partner_sub_id needs partner/)
  assert.match(partnerError({ partner: 'viatico', partner_sub_id: 'a b' }), /partner_sub_id/)
  assert.match(partnerError({ partner: 'viatico', partner_sub_id: 'x'.repeat(81) }), /partner_sub_id/)
})

test('search_cars with a partner wraps every link and does not send the partner to the search API', async () => {
  let requested
  const result = await searchCars({ ...query, partner: 'viatico', partner_sub_id: 'claude' }, {
    today,
    limiter: createLimiter(),
    fetch: async (url) => { requested = url; return apiAnswer() },
  })
  assert.equal(result.isError, false)
  assert.doesNotMatch(requested, /partner|viatico/)
  const [first, second] = result.body.data
  assert.equal(visitParams(first.url).to, offerUrl.slice('https://cheapcarent.com'.length))
  assert.equal(visitParams(first.url).subId, 'claude')
  assert.equal(second.urlSource, 'city-page')
  assert.equal(visitParams(second.url).to, '/car-rental/gr/heraklion')
  assert.equal(result.body.meta.partner, 'viatico')
})

test('search_cars without a partner keeps the plain site links', async () => {
  const result = await searchCars(query, { today, limiter: createLimiter(), fetch: async () => apiAnswer() })
  assert.equal(result.body.data[0].url, offerUrl)
  assert.equal(result.body.meta.partner, undefined)
})

test('search_cars rejects a malformed partner code before searching', async () => {
  let calls = 0
  const result = await searchCars({ ...query, partner: 'Bad Code' }, {
    today,
    limiter: createLimiter(),
    fetch: async () => { calls += 1; return apiAnswer() },
  })
  assert.equal(result.isError, true)
  assert.match(result.message, /Partner code/)
  assert.equal(calls, 0)
})
