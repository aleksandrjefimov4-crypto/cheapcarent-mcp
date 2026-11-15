import { AsyncLocalStorage } from 'node:async_hooks'
import { isIP } from 'node:net'

/** The HTTP request being handled: its response (for headers) and the client's address. */
export const requestContext = new AsyncLocalStorage()

/** Standard Retry-After on the HTTP answer when a search was refused. No-op over stdio. */
export function setRetryAfter(seconds) {
  const res = requestContext.getStore()?.res
  if (res && !res.headersSent && Number.isInteger(seconds) && seconds > 0) {
    res.setHeader('Retry-After', String(seconds))
  }
}

/** The client address of the current request, or null over stdio. */
export function currentClientIp() {
  return requestContext.getStore()?.clientIp ?? null
}

/**
 * The address nginx saw. The server listens on 127.0.0.1 behind nginx, which sets X-Real-IP
 * and appends the address to X-Forwarded-For; the entries before it are whatever the client sent.
 */
export function clientAddress(req) {
  const real = String(req.headers?.['x-real-ip'] ?? '').trim()
  if (isIP(real)) return real
  const forwarded = String(req.headers?.['x-forwarded-for'] ?? '').split(',').map((part) => part.trim()).filter(Boolean)
  const last = forwarded.at(-1) ?? ''
  if (isIP(last)) return last
  return req.socket?.remoteAddress ?? 'unknown'
}
