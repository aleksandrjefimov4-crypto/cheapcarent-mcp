/** Read-only client for the public list of cities and airports the search accepts. */
import { setRetryAfter } from './request-context.mjs'
import { apiHeaders, fetchWithTimeout, isTimeout, retryAfterSeconds, timeoutMessage, toolError } from './search.mjs'

export const LOCATIONS_URL = 'https://api.cheapcarent.com/api/v1/public/locations'
export const LOCATIONS_USAGE = 'Pass countryCode as country and cityParam as city to search_cars, or pass iata for an airport.'
const CACHE_MS = 60 * 60 * 1000
const ALLOWED_INPUT = new Set(['country', 'query', 'airports_only'])

let cache = { rows: null, at: 0 }

export function resetLocationCache() {
  cache = { rows: null, at: 0 }
}

export async function listLocations(input = {}, options = {}) {
  try {
    const parsed = validateInput(input)
    if (!parsed.ok) return toolError(parsed.message)

    const loaded = await loadRows(options)
    if (loaded.isError) return loaded

    if (parsed.country && !loaded.rows.some((row) => row.countryCode === parsed.country)) {
      const covered = [...new Set(loaded.rows.map((row) => row.countryCode))].sort().join(', ')
      return toolError(`Country ${parsed.country} is not covered. Covered country codes: ${covered}.`)
    }

    const found = loaded.rows.filter((row) => matches(row, parsed))
    const rows = parsed.query
      ? [...found.filter((row) => isExact(row, parsed.query)), ...found.filter((row) => !isExact(row, parsed.query))]
      : found
    return {
      isError: false,
      body: {
        data: rows,
        meta: { total: rows.length, usage: LOCATIONS_USAGE },
      },
    }
  } catch {
    return toolError('The location list could not be loaded.')
  }
}

async function loadRows(options) {
  const now = options.now ?? Date.now()
  if (cache.rows && now - cache.at < CACHE_MS) return { isError: false, rows: cache.rows }

  let response
  try {
    response = await fetchWithTimeout(LOCATIONS_URL, { method: 'GET', headers: apiHeaders(options) }, options)
  } catch (error) {
    if (isTimeout(error)) return toolError(timeoutMessage('The location list', options))
    return toolError('The location list could not be reached. Try again later.')
  }
  if (response.status === 429) {
    const retry = retryAfterSeconds(response.headers)
    setRetryAfter(retry)
    return toolError(`The location list is rate limited.${retry ? ` Retry after ${retry} seconds.` : ''}`, retry ?? undefined)
  }
  if (!response.ok) return toolError('The location list could not be loaded.')

  let payload
  try {
    payload = await response.json()
  } catch {
    return toolError('The location list could not be read.')
  }
  const incoming = Array.isArray(payload?.data) ? payload.data : []
  const rows = incoming.map(shapeRow).filter(Boolean)
  if (rows.length === 0) return toolError('The location list is empty right now. Try again later.')
  cache = { rows, at: now }
  return { isError: false, rows }
}

function validateInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, message: 'Input must be an object.' }
  }
  for (const key of Object.keys(input)) {
    if (!ALLOWED_INPUT.has(key)) return { ok: false, message: 'Unexpected field.' }
  }
  const parsed = { ok: true, country: null, query: null, airportsOnly: input.airports_only === true }
  if (input.country !== undefined && input.country !== null && input.country !== '') {
    if (typeof input.country !== 'string' || !/^[A-Za-z]{2}$/.test(input.country.trim())) {
      return { ok: false, message: 'Country must be a two-letter code, for example ES.' }
    }
    parsed.country = input.country.trim().toUpperCase()
  }
  if (input.query !== undefined && input.query !== null && input.query !== '') {
    if (typeof input.query !== 'string' || input.query.trim().length > 80) {
      return { ok: false, message: 'Query must be a short place name or airport code.' }
    }
    parsed.query = fold(input.query)
  }
  return parsed
}

function shapeRow(row) {
  if (!row || typeof row !== 'object') return null
  const country = plainText(row.country)
  const city = plainText(row.city)
  if (!country || !city) return null
  if (typeof row.countryCode !== 'string' || !/^[A-Za-z]{2}$/.test(row.countryCode)) return null
  if (typeof row.cityParam !== 'string' || !/^[a-z0-9-]{1,80}$/.test(row.cityParam)) return null
  if (typeof row.page !== 'string' || !row.page.startsWith('https://cheapcarent.com/car-rental/')) return null

  const shaped = { country, countryCode: row.countryCode.toUpperCase(), city, cityParam: row.cityParam }
  if (typeof row.iata === 'string' && /^[A-Za-z]{3}$/.test(row.iata)) shaped.iata = row.iata.toUpperCase()
  shaped.hasAirport = row.hasAirport === true
  if (Array.isArray(row.alsoAccepted)) {
    const aliases = row.alsoAccepted.map(plainText).filter(Boolean).slice(0, 10)
    if (aliases.length) shaped.alsoAccepted = aliases
  }
  shaped.page = row.page
  return shaped
}

function matches(row, parsed) {
  if (parsed.country && row.countryCode !== parsed.country) return false
  if (parsed.airportsOnly && !row.hasAirport) return false
  if (!parsed.query) return true
  const haystack = [row.city, row.cityParam, row.country, row.iata ?? '', ...(row.alsoAccepted ?? [])].map(fold)
  return haystack.some((text) => text.includes(parsed.query))
}

function isExact(row, query) {
  return [row.city, row.cityParam, row.iata ?? '', ...(row.alsoAccepted ?? [])].some((text) => fold(text) === query)
}

function plainText(value) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text || text.length > 120 || /[<>@]/.test(text)) return null
  return text
}

function fold(value) {
  return String(value).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
}
