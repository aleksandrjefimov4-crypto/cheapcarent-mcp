/**
 * search_cars limits, counted here because the API sees every MCP request from this server's
 * own address: a share per client (the address nginx saw) and one ceiling for all clients,
 * which protects the suppliers behind the city preview.
 */
export const CLIENT_PER_MINUTE = 20
export const TOTAL_PER_MINUTE = 120
export const WINDOW_MS = 60_000
/** A wait this short is cheaper than an error that many AI clients never retry. */
export const MAX_WAIT_MS = 3_000
const MAX_CLIENTS = 10_000

export function createLimiter({ perClient = CLIENT_PER_MINUTE, total = TOTAL_PER_MINUTE, windowMs = WINDOW_MS } = {}) {
  let clients = new Map()
  let all = []
  const recent = (stamps, now) => stamps.filter((stamp) => stamp > now - windowMs)

  function prune(now) {
    clients = new Map([...clients].map(([key, stamps]) => [key, recent(stamps, now)]).filter(([, stamps]) => stamps.length))
  }

  return {
    /** Counts the request and returns { ok: true }, or { ok: false, waitMs } without counting it. */
    take(client, now) {
      all = recent(all, now)
      const mine = recent(clients.get(client) ?? [], now)
      const waits = []
      if (mine.length >= perClient) waits.push(mine[0] + windowMs - now)
      if (all.length >= total) waits.push(all[0] + windowMs - now)
      if (waits.length) return { ok: false, waitMs: Math.max(1, ...waits) }
      if (!clients.has(client) && clients.size >= MAX_CLIENTS) prune(now)
      clients.set(client, [...mine, now])
      all = [...all, now]
      return { ok: true }
    },
  }
}

export const defaultLimiter = createLimiter()

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Waits once when the slot frees within MAX_WAIT_MS; otherwise says how long to wait. */
export async function acquire(limiter, client, { now = Date.now, wait = sleep } = {}) {
  let result = limiter.take(client, now())
  if (!result.ok && result.waitMs <= MAX_WAIT_MS) {
    await wait(result.waitMs)
    result = limiter.take(client, now())
  }
  return result.ok ? { ok: true } : { ok: false, retryAfter: Math.ceil(result.waitMs / 1000) }
}
