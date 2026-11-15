/** Read-only client for the live public search. It does not book.
 * Searches are limited here per client (see client-limit.mjs) and sent to the API with the
 * server's key and the client's address. A wait of up to 3 seconds is waited out, not returned. */
import { MAX_WAIT_MS, acquire, defaultLimiter, sleep } from './client-limit.mjs'
import { currentClientIp, setRetryAfter } from './request-context.mjs'


export const SEARCH_URL = 'https://api.cheapcarent.com/api/v1/public/search'
export const USER_AGENT = 'CheapCarRent-MCP/1.0'
export const OFFER_CAP = 8
export const PAGE_NOTICE = 'This is the returned page from the city preview, at most 8 offers, not the whole market.'
export const DISCLAIMER = 'The live price is on the CheapCarRent website. Cancellation depends on the specific offer.'

const OFFER_TEXT = ['category', 'brand', 'model', 'transmission', 'fuel', 'company', 'pickupLocation']
const OFFER_AMOUNTS = ['price', 'totalPrice', 'rentalPrice', 'delivery', 'priceEur']
const META_KEYS = ['count', 'returned', 'limit', 'offset', 'currency', 'pickupDate', 'returnDate', 'pickupTime', 'returnTime']

/** Request headers for the API: the key and client address only when the key is configured. */
export function apiHeaders(options = {}) {
  const headers = { accept: 'application/json', 'user-agent': USER_AGENT }
  const key = options.apiKey ?? process.env.CCR_MCP_SEARCH_KEY ?? ''
  if (key) {
    headers['x-ccr-mcp-key'] = key
    const client = options.clientIp ?? currentClientIp()
    if (client) headers['x-ccr-client-ip'] = client
  }
  return headers
}

function rateLimited(retry) {
  setRetryAfter(retry)
  const wait = retry ? ` Retry after ${retry} seconds.` : ''
  return toolError(`The search is rate limited.${wait}`, retry ?? undefined)
}

export function toolError(message, retryAfterSeconds) {
  return retryAfterSeconds ? { isError: true, message, retryAfterSeconds } : { isError: true, message }
}

export function shapeSearchPayload(payload) {
  const incoming = payload && typeof payload === 'object' ? payload : {}
  const rows = Array.isArray(incoming.data) ? incoming.data : []
  const metaIn = incoming.meta && typeof incoming.meta === 'object' ? incoming.meta : {}
  const location = shapeLocation(metaIn.location)
  const data = []
  let omittedOffers = 0
  for (const row of rows) {
    const offer = shapeOffer(row, location)
    if (!offer) {
      omittedOffers += 1
      continue
    }
    data.push(offer)
  }
  const meta = {}
  for (const key of META_KEYS) {
    if (metaIn[key] !== undefined && metaIn[key] !== null && !isSecret(key)) meta[key] = metaIn[key]
  }
  const currencies = Array.isArray(metaIn.currencies)
    ? metaIn.currencies.filter((code) => typeof code === 'string' && /^[A-Z]{3}$/.test(code))
    : []
  if (currencies.length) meta.currencies = currencies
  if (metaIn.priceEurCurrency === 'EUR') meta.priceEurCurrency = 'EUR'
  if (location) meta.location = location
  meta.disclaimer = typeof metaIn.disclaimer === 'string' && metaIn.disclaimer.trim()
    ? metaIn.disclaimer.trim()
    : DISCLAIMER
  if (typeof metaIn.pricesCheckedAt === 'string' && metaIn.pricesCheckedAt.trim()) {
    meta.pricesCheckedAt = metaIn.pricesCheckedAt.trim()
  }
  if (omittedOffers > 0) meta.omittedOffers = omittedOffers
  return { data, meta, notice: PAGE_NOTICE }
}

export async function searchCars(input, options = {}) {
  try {
    const today = options.today ?? new Date().toISOString().slice(0, 10)
    const parsed = validateInput(input, today)
    if (!parsed.ok) return toolError(parsed.message)

    const wait = options.sleep ?? sleep
    const client = options.clientIp ?? currentClientIp() ?? 'local'
    const permit = await acquire(options.limiter ?? defaultLimiter, client, { now: options.now, wait })
    if (!permit.ok) return rateLimited(permit.retryAfter)

    const url = `${SEARCH_URL}?${new URLSearchParams(parsed.query)}`
    const init = { method: 'GET', headers: apiHeaders({ ...options, clientIp: client }) }
    const fetchImpl = options.fetch ?? globalThis.fetch
    let response
    for (let attempt = 0; ; attempt += 1) {
      const started = Date.now()
      try {
        response = await fetchImpl(url, init)
      } catch {
        log(options, { status: 0, ms: Date.now() - started, place: parsed.place })
        return toolError('The search could not be reached. Try again later.')
      }
      log(options, { status: response.status, ms: Date.now() - started, place: parsed.place })
      if (response.status !== 429) break

      const retry = retryAfterSeconds(response.headers)
      // One short wait, then the refusal is passed on with its Retry-After.
      if (attempt > 0 || !retry || retry * 1000 > MAX_WAIT_MS) return rateLimited(retry)
      await wait(retry * 1000)
    }

    const body = await readJson(response)
    if (response.status === 404) {
      return toolError(publicError(body, 'Unknown location.'))
    }
    if (!response.ok) {
      return toolError(publicError(body, 'The search could not be completed.'))
    }
    return { isError: false, body: shapeSearchPayload(body) }
  } catch {
    return toolError('The search could not be completed.')
  }
}

function validateInput(input, today) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, message: 'Search input must be an object.' }
  }
  const allowed = new Set([
    'pickup', 'country', 'city', 'iata', 'pickup_date', 'return_date',
    'pickup_time', 'return_time', 'driver_age', 'currency', 'limit', 'offset',
  ])
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) return { ok: false, message: 'Unexpected search field.' }
  }

  const hasPickup = hasText(input.pickup)
  const hasCountry = hasText(input.country)
  const hasCity = hasText(input.city)
  const hasIata = hasText(input.iata)
  const modes = [hasPickup, hasCountry || hasCity, hasIata].filter(Boolean).length
  if (hasCountry !== hasCity) return { ok: false, message: 'Pass both country and city.' }
  if (modes !== 1) return { ok: false, message: 'Pass one location: pickup, or country and city, or an airport code.' }

  const query = {}
  let place = 'pickup'
  if (hasPickup) {
    const pickup = cleanPlace(input.pickup)
    if (!pickup) return { ok: false, message: 'Pickup must be a place name.' }
    query.pickup = pickup
  } else if (hasCountry) {
    if (!/^[A-Za-z]{2}$/.test(input.country) || !/^[A-Za-z0-9-]+$/.test(input.city)) {
      return { ok: false, message: 'Country must be a two-letter code and city must be a slug.' }
    }
    query.country = input.country.toUpperCase()
    query.city = input.city.toLowerCase()
    place = `${query.country}/${query.city}`
  } else {
    if (!/^[A-Za-z]{3}$/.test(input.iata)) return { ok: false, message: 'Airport code must be three letters.' }
    query.iata = input.iata.toUpperCase()
    place = query.iata
  }

  const pickupDate = dateValue(input.pickup_date)
  const returnDate = dateValue(input.return_date)
  if (!pickupDate || !returnDate) return { ok: false, message: 'Pickup and return dates must be YYYY-MM-DD.' }
  const todayDate = dateValue(today)
  if (!todayDate || pickupDate < todayDate) return { ok: false, message: 'Pickup must be today or later.' }
  const span = daysBetween(pickupDate, returnDate)
  if (span < 1 || span > 30) return { ok: false, message: 'Return must be after pickup, and the rental can run up to 30 days.' }
  if (daysBetween(todayDate, pickupDate) > 365) return { ok: false, message: 'Pickup must be within 365 days.' }
  query.pickup_date = input.pickup_date
  query.return_date = input.return_date

  if (!optionalTime(input.pickup_time) || !optionalTime(input.return_time)) {
    return { ok: false, message: 'Pickup and return time must be 12:00.' }
  }
  if (hasText(input.pickup_time)) query.pickup_time = '12:00'
  if (hasText(input.return_time)) query.return_time = '12:00'

  if (input.driver_age !== undefined && input.driver_age !== null && input.driver_age !== '') {
    const age = input.driver_age
    if (!Number.isInteger(age) || age < 18 || age > 99) {
      return { ok: false, message: 'Driver age must be a whole number from 18 to 99.' }
    }
    query.driver_age = String(age)
  }
  if (hasText(input.currency)) {
    if (String(input.currency).toUpperCase() !== 'EUR') {
      return { ok: false, message: 'Currency must be EUR.' }
    }
    query.currency = 'EUR'
  }
  if (input.limit !== undefined && input.limit !== null && input.limit !== '') {
    if (!Number.isInteger(input.limit) || input.limit < 1) return { ok: false, message: 'Limit must be a positive whole number.' }
    query.limit = String(Math.min(input.limit, OFFER_CAP))
  }
  if (input.offset !== undefined && input.offset !== null && input.offset !== '') {
    if (!Number.isInteger(input.offset) || input.offset < 0 || input.offset > 1000) {
      return { ok: false, message: 'Offset must be a whole number from 0 to 1000.' }
    }
    query.offset = String(input.offset)
  }
  return { ok: true, query, place }
}

function shapeOffer(row, location) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null
  const offer = {}
  for (const key of OFFER_TEXT) {
    const text = publicText(row[key])
    if (text) offer[key] = text
  }
  if (Number.isInteger(row.seats) && row.seats >= 1 && row.seats <= 20) offer.seats = row.seats
  for (const key of OFFER_AMOUNTS) {
    if (typeof row[key] === 'number' && Number.isFinite(row[key]) && row[key] >= 0) offer[key] = row[key]
  }
  if (typeof row.currency === 'string' && /^[A-Za-z]{3}$/.test(row.currency)) offer.currency = row.currency.toUpperCase()
  const deposit = publicDeposit(row.deposit)
  if (deposit) offer.deposit = deposit
  if (typeof row.fuelPolicy === 'string' && ['full_to_full', 'same_to_same', 'full_to_empty'].includes(row.fuelPolicy)) {
    offer.fuelPolicy = row.fuelPolicy
  }
  const mileage = publicMileage(row.mileage)
  if (mileage) offer.mileage = mileage
  if (typeof row.photo === 'string' && safeSiteOrHttps(row.photo)) offer.photo = row.photo

  const ownUrl = typeof row.url === 'string' && safeCheapCarRentUrl(row.url) ? row.url : null
  if (ownUrl) {
    offer.url = ownUrl
  } else if (location?.page) {
    offer.url = location.page
    offer.urlSource = 'city-page'
  } else {
    return null
  }
  return offer
}

function shapeLocation(value) {
  if (!value || typeof value !== 'object') return null
  const location = {}
  for (const key of ['city', 'country']) {
    const text = publicText(value[key])
    if (text) location[key] = text
  }
  if (typeof value.countryCode === 'string' && /^[A-Za-z]{2}$/.test(value.countryCode)) {
    location.countryCode = value.countryCode.toUpperCase()
  }
  if (typeof value.iata === 'string' && /^[A-Za-z]{3}$/.test(value.iata)) location.iata = value.iata.toUpperCase()
  if (typeof value.page === 'string' && safeCheapCarRentUrl(value.page)) location.page = value.page
  return Object.keys(location).length ? location : null
}

function publicDeposit(value) {
  if (!value || typeof value !== 'object') return null
  if (typeof value.amount !== 'number' || !Number.isFinite(value.amount) || value.amount < 0) return null
  if (typeof value.currency !== 'string' || !/^[A-Za-z]{3}$/.test(value.currency)) return null
  return { amount: value.amount, currency: value.currency.toUpperCase() }
}

function publicMileage(value) {
  if (!value || typeof value !== 'object') return null
  if (value.unlimited === true) return { unlimited: true }
  const mileage = {}
  if (typeof value.unit === 'string' && ['km', 'mi'].includes(value.unit)) mileage.unit = value.unit
  for (const key of ['perDay', 'maximum']) {
    if (typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] > 0) mileage[key] = value[key]
  }
  if (typeof value.text === 'string' && /^\d+(?:\.\d+)?\s*km(?:\s*\(\+\d+(?:\.\d+)?\/km\))?$/i.test(value.text)) {
    mileage.text = value.text
  }
  return Object.keys(mileage).length ? mileage : null
}

function publicText(value) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text || text.length > 200 || isSecret(text) || text.includes('@')) return null
  return text
}

function safeCheapCarRentUrl(value) {
  if (!safeSiteOrHttps(value) || !value.startsWith('https://cheapcarent.com/')) return false
  return !/[?&](?:offer_token|token|gclid|email)=/i.test(value)
}

function safeSiteOrHttps(value) {
  return typeof value === 'string' && value.startsWith('https://') && !isSecret(value)
}

function isSecret(value) {
  return /email|phone|dateofbirth|date_of_birth|gclid|stripe|payment|suppliertotal|marketplacefee|markuppercent|offertoken|token|cookie|secret|authorization|flight|bookingid/i.test(String(value))
}

function publicError(body, fallback) {
  if (body && typeof body.error === 'string') {
    const text = body.error.trim()
    if (text && text.length <= 240 && !isSecret(text) && !text.includes('@') && !/stack|exception/i.test(text)) return text
  }
  return fallback
}

async function readJson(response) {
  try {
    return await response.json()
  } catch {
    return null
  }
}

export function retryAfterSeconds(headers) {
  const raw = headers?.get?.('retry-after') ?? headers?.get?.('Retry-After')
  if (raw == null || raw === '') return null
  if (!/^\d+$/.test(String(raw))) return null
  return Number(raw)
}

function hasText(value) {
  return typeof value === 'string' && value.trim() !== ''
}

function cleanPlace(value) {
  const text = String(value).trim()
  if (!text || text.length > 120 || text.includes('@') || /\d{12,}/.test(text)) return null
  return text
}

function optionalTime(value) {
  if (value === undefined || value === null || value === '') return true
  return value === '12:00'
}

function dateValue(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null
  return date
}

function daysBetween(start, end) {
  return Math.round((end.getTime() - start.getTime()) / 86_400_000)
}

function log(options, fields) {
  const write = options.log ?? (() => {})
  write({ tool: 'search_cars', ...fields })
}
