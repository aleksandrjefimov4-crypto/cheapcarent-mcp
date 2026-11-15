import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { listLocations } from './locations.mjs'
import { OFFER_CAP, searchCars } from './search.mjs'

export const TOOL_NAMES = ['search_cars', 'list_locations']

export const SERVER_INSTRUCTIONS = [
  'CheapCarRent exposes two read-only tools, list_locations and search_cars.',
  'Use list_locations to find the exact countryCode, cityParam or iata, then pass it to search_cars. Do not invent a city or airport that is not in the list.',
  'search_cars calls the public search and returns at most 8 offers from the city preview, not the whole market.',
  'Prices are not a guaranteed quote. The live price and the offer terms are on the offer URL at https://cheapcarent.com.',
  'The online booking fee is 17%. The rest of the rental is paid at pick-up.',
  'This server cannot book, pay, or look up a customer.',
].join(' ')

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
}

const locationsSchema = z.object({
  country: z.string().trim().length(2).optional(),
  query: z.string().trim().min(1).max(80).optional(),
  airports_only: z.boolean().optional(),
}).strict()

function toToolResult(result) {
  if (result.isError) {
    const error = { isError: true, content: [{ type: 'text', text: result.message }] }
    // Machine-readable wait for a client that cannot read the HTTP Retry-After header.
    if (result.retryAfterSeconds) error.structuredContent = { error: 'rate_limited', retryAfterSeconds: result.retryAfterSeconds }
    return error
  }
  return { content: [{ type: 'text', text: JSON.stringify(result.body) }] }
}

const inputSchema = z.object({
  pickup: z.string().trim().min(1).max(120).optional(),
  country: z.string().trim().length(2).optional(),
  city: z.string().trim().min(1).max(80).optional(),
  iata: z.string().trim().length(3).optional(),
  pickup_date: z.string(),
  return_date: z.string(),
  pickup_time: z.literal('12:00').optional(),
  return_time: z.literal('12:00').optional(),
  driver_age: z.number().int().min(18).max(99).optional(),
  currency: z.literal('EUR').optional(),
  limit: z.number().int().min(1).max(OFFER_CAP).optional(),
  offset: z.number().int().min(0).max(1000).optional(),
}).strict()

export function createMcpServer() {
  const server = new McpServer({
    name: 'cheapcarent-search',
    version: '1.0.0',
  }, {
    instructions: SERVER_INSTRUCTIONS,
  })

  server.registerTool('search_cars', {
    title: 'Search cars',
    description: [
      'Search current CheapCarRent car rental offers for one place and dates.',
      'This is the same city preview as the website, with pick-up and return at 12:00.',
      'Each offer has its price in its own currency and priceEur, the same day price in EUR; offers are sorted by priceEur, cheapest first.',
      'A rental can run up to 30 days, and pick-up must be within 365 days.',
      'The result is one page of at most 8 offers, not the whole market. An empty page is a normal result, not a failure.',
      'Prices are not a guaranteed quote. Use each offer URL on https://cheapcarent.com for the live price and that offer\'s terms.',
      'The online booking fee is 17%. The rest of the rental is paid at pick-up.',
      'Pass one location only: pickup, or country plus city, or iata.',
    ].join(' '),
    inputSchema,
    annotations: READ_ONLY,
  }, async (args) => toToolResult(await searchCars(args)))

  server.registerTool('list_locations', {
    title: 'List cities and airports',
    description: [
      'List the cities and airports CheapCarRent search accepts, with the exact spelling.',
      'Each row has country, countryCode, city, cityParam, iata when there is an airport, hasAirport, alsoAccepted spellings and the city page URL.',
      'Filter with country (two-letter code), query (city, country, alias or airport code; accents ignored) and airports_only.',
      'Pass countryCode as country and cityParam as city to search_cars, or pass iata.',
      'An unknown country code returns an error with the covered country codes. An empty list for a query means the place is not covered; do not guess another spelling.',
    ].join(' '),
    inputSchema: locationsSchema,
    annotations: READ_ONLY,
  }, async (args) => toToolResult(await listLocations(args)))

  // The SDK advertises tools.listChanged when tools are registered. This server is stateless
  // (no SSE stream, GET answers 405) and its tool list never changes, so it must not promise that.
  server.server.registerCapabilities({ tools: { listChanged: false } })

  return server
}
