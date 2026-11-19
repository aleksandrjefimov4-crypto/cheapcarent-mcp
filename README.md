# CheapCarRent MCP

[![mcptry](https://mcptry.com/badge/com.cheapcarent/search)](https://mcptry.com/servers/com.cheapcarent/search)
[![Listed in awesome-remote-mcp-servers](https://img.shields.io/badge/awesome-remote%20MCP%20servers-fc60a8?logo=awesomelists&logoColor=white)](https://github.com/punkpeye/awesome-remote-mcp-servers)

Read-only MCP server for CheapCarRent search. It does not book, take payment, or accept personal data.

CheapCarRent covers 15,000 pickup points in 46 countries, with the site available in 19 languages. Source: [cheapcarent.com](https://cheapcarent.com).

Two tools:

- `list_locations` returns the cities and airports the search accepts, with the exact spelling. It reads `GET https://cheapcarent.com/api/v1/public/locations` once and keeps the list in memory for an hour. Optional filters: `country` (two-letter code), `query` (city, country, alias or airport code, accents ignored; exact matches come first) and `airports_only`. Each row has `country`, `countryCode`, `city`, `cityParam`, `iata` when there is an airport, `hasAirport`, `alsoAccepted` and the city `page`.
- `search_cars` calls the live search, `GET https://cheapcarent.com/api/v1/public/search`. Pass `countryCode` + `cityParam` from `list_locations` as `country` + `city`, or pass `iata`.

The server never invents a place: an unknown `country` code is an error that lists the covered codes, and an empty result for a `query` means the place is not covered. The server does not advertise `tools.listChanged`: it is stateless, keeps no SSE stream (GET answers 405) and its tool list never changes.

A result is one page of at most 8 offers from the city preview, not the whole market. Prices are not a guaranteed quote. The live price and the offer terms are on the offer URL at https://cheapcarent.com. The online booking fee is 17%. The rest of the rental is paid at pick-up.

Live at `https://cheapcarent.com/mcp` (Streamable HTTP, stateless: POST only, GET answers 405, bodies over 64 KB get 413).

## Run locally

```bash
git clone https://github.com/aleksandrjefimov4-crypto/cheapcarent-mcp
cd cheapcarent-mcp
npm install
npm test
npm start
```

`npm start` listens on `127.0.0.1:8787` and serves `/mcp`. That local port is only for review. Client examples below use the public URL.

Stdio, for a desktop client that runs the package itself:

```bash
node src/stdio.mjs
```

MCP Inspector, after the local server is running:

```bash
npx @modelcontextprotocol/inspector
```

Point it at `http://127.0.0.1:8787/mcp` (Streamable HTTP). For stdio:

```bash
npx @modelcontextprotocol/inspector -- node src/stdio.mjs
```

## 429, Retry-After and the 8-offer page

`search_cars` is limited here, per client: 20 searches a minute for each client address (`X-Real-IP` set by nginx, else the last `X-Forwarded-For` entry), and 120 a minute for all clients together, which protects the suppliers behind the city preview. When a slot frees within 3 seconds the server waits and runs the search instead of refusing it. Otherwise the tool returns an error the agent can read ("Retry after N seconds"), `structuredContent: {"error": "rate_limited", "retryAfterSeconds": N}`, and the HTTP response of `/mcp` carries a standard `Retry-After: N` header.

The server calls `https://api.cheapcarent.com/api/v1/public/*` with `X-CCR-MCP-Key` (env `CCR_MCP_SEARCH_KEY`; the key is configured on the production server only and is not part of this repository) and `X-CCR-Client-IP`. With that key the API skips its own per-IP limit (60 a minute, 12 in 10 seconds), which would otherwise see every MCP user as the server's one IP, and logs the client address. Without the key (local runs) the API limit applies as for anyone; a 429 of up to 3 seconds is waited out once, a longer one is passed on.

Each API call is aborted after 25 seconds. A search for a place and dates nobody asked for recently makes the API ask every supplier live; when that runs over, the tool returns a readable error asking to try again in a few seconds (the API finishes the work in the background and caches it). No `Retry-After` is set for a timeout, it is not a rate limit.

nginx keeps its own 10 requests a second per IP on `/mcp` in front of all this.

Answers are plain JSON (`enableJsonResponse`), not an SSE stream, so headers are written after the tool has run.

The API returns offers already filtered and sorted: cars only, a believable day price in EUR, no duplicates, cheapest `priceEur` first, then cut to the page. A page has at most 8 offers and the server does not walk `offset` to collect more. An empty `data` array with HTTP 200 is a normal result.

## Discovery: server card and AI catalog

Per [SEP-2127](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2127-mcp-server-cards.md) the server publishes a Server Card at `https://cheapcarent.com/mcp/server-card` (`application/mcp-server-card+json`) and the domain lists it in an AI Catalog at `https://cheapcarent.com/.well-known/ai-catalog.json` (`application/ai-catalog+json`). Both are static files from `discovery/`, served with CORS, `Cache-Control: public, max-age=3600` and an ETag. `test/discovery.test.mjs` fails when the card stops matching `server.json`; after a version bump, upload the new card as well.

## CORS

`/mcp` answers `GET`, `POST`, `DELETE`, and `OPTIONS`.

- `Access-Control-Allow-Origin: *`
- `Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS`
- `Access-Control-Allow-Headers: Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID`
- `Access-Control-Expose-Headers: Mcp-Session-Id, Retry-After`

No cookies and no API key.

## Client examples

These samples use the public URL. They contain no secrets and no prices.

Cursor `mcp.json`:

```json
{
  "mcpServers": {
    "cheapcarent": {
      "url": "https://cheapcarent.com/mcp"
    }
  }
}
```

Claude Desktop, remote:

```json
{
  "mcpServers": {
    "cheapcarent": {
      "url": "https://cheapcarent.com/mcp"
    }
  }
}
```

Claude Desktop, stdio, from a local clone:

```json
{
  "mcpServers": {
    "cheapcarent": {
      "command": "node",
      "args": ["/path/to/cheapcarent-mcp/src/stdio.mjs"]
    }
  }
}
```

ChatGPT custom connector: add an MCP server with URL `https://cheapcarent.com/mcp`. No OAuth. The server is anonymous and read-only.

## Registry

Published to the official MCP Registry on 2026-11-14 as `com.cheapcarent/search` 1.0.0 (remote `https://cheapcarent.com/mcp`): https://registry.modelcontextprotocol.io/v0.1/servers?search=cheapcarent

Domain auth is HTTP: `https://cheapcarent.com/.well-known/mcp-registry-auth` serves the Ed25519 public record. The private signing key is not in this repository. To publish a new version, bump `version` in `server.json` and publish with `mcp-publisher`.
