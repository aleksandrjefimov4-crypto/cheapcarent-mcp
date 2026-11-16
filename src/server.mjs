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
  country: z.string().trim().length(2).optional()
    .describe('Two-letter country code, e.g. ES or GR. Only places in this country are listed.'),
  query: z.string().trim().min(1).max(80).optional()
    .describe('City, country, alternative spelling or airport code to look for, e.g. Malaga or AGP. Accents are ignored; exact matches come first.'),
  airports_only: z.boolean().optional()
    .describe('true to list only places with an airport (rows that have an iata code).'),
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
  pickup: z.string().trim().min(1).max(120).optional()
    .describe('Free-text place name, e.g. Barcelona. Use only when list_locations gave no exact match; prefer country + city or iata.'),
  country: z.string().trim().length(2).optional()
    .describe('countryCode from list_locations, e.g. ES. Pass together with city.'),
  city: z.string().trim().min(1).max(80).optional()
    .describe('cityParam from list_locations, e.g. barcelona. Pass together with country.'),
  iata: z.string().trim().length(3).optional()
    .describe('Three-letter airport code from list_locations, e.g. BCN. Use instead of country + city.'),
  pickup_date: z.string()
    .describe('Pick-up date, YYYY-MM-DD. Today or later, within 365 days.'),
  return_date: z.string()
    .describe('Return date, YYYY-MM-DD. 1 to 30 days after pickup_date.'),
  pickup_time: z.literal('12:00').optional()
    .describe('Pick-up time. Only 12:00 is supported; may be left out.'),
  return_time: z.literal('12:00').optional()
    .describe('Return time. Only 12:00 is supported; may be left out.'),
  driver_age: z.number().int().min(18).max(99).optional()
    .describe("Driver's age in years, 18 to 99. Accepted but not used for prices: the preview is priced for a standard adult driver; age terms are on each offer's page."),
  currency: z.literal('EUR').optional()
    .describe('Only EUR is accepted. Offers keep their own currency in price; priceEur is always in EUR.'),
  limit: z.number().int().min(1).max(OFFER_CAP).optional()
    .describe(`How many offers to return, 1 to ${OFFER_CAP}. Default ${OFFER_CAP}.`),
  offset: z.number().int().min(0).max(1000).optional()
    .describe('How many of the cheapest offers to skip, for the next page. Default 0.'),
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
