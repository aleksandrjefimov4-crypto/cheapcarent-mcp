// Partner (affiliate) links. With a partner code, every cheapcarent.com link in a search result goes through
// https://api.cheapcarent.com/api/v1/affiliate/visit/{code}?to=/path, which records the click and redirects to the
// same page with ?affiliate_click_id=. The site keeps that id 30 days and sends it with the booking, so the booking
// is credited to the partner. The code itself is never sent to the search API.

export const VISIT_BASE = 'https://api.cheapcarent.com/api/v1/affiliate/visit/'
const SITE = 'https://cheapcarent.com'
// Same limits as the API (AffiliateVisitController): `to` up to 500 characters, sub_id [a-zA-Z0-9_-] up to 80.
const MAX_TO = 500
const PARTNER_CODE = /^[a-z0-9-]{3,40}$/
const SUB_ID = /^[A-Za-z0-9_-]{1,80}$/

/** Null when partner / partner_sub_id are absent or well formed, else a message for the caller. */
export function partnerError(input) {
  const { partner, partner_sub_id: subId } = input ?? {}
  if (partner !== undefined && (typeof partner !== 'string' || !PARTNER_CODE.test(partner))) {
    return 'Partner code must be 3 to 40 lowercase letters, digits or hyphens, as given by CheapCarRent.'
  }
  if (subId === undefined) return null
  if (partner === undefined) return 'partner_sub_id needs partner.'
  if (typeof subId !== 'string' || !SUB_ID.test(subId)) {
    return 'partner_sub_id must be 1 to 80 letters, digits, underscores or hyphens.'
  }
  return null
}

/** The partner visit link for a cheapcarent.com URL; any other URL is returned unchanged. */
export function partnerLink(url, partner, subId) {
  if (typeof url !== 'string' || !url.startsWith(`${SITE}/`)) return url
  let to = url.slice(SITE.length).split('#')[0]
  if (to.length > MAX_TO) to = to.split('?')[0]
  if (to.length > MAX_TO || to.startsWith('//') || to.includes('\\')) to = '/'
  const params = new URLSearchParams({ to })
  if (subId) params.set('sub_id', subId)
  return `${VISIT_BASE}${encodeURIComponent(partner)}?${params}`
}

/** A copy of a shaped search body with every site link sent through the partner visit link. */
export function withPartnerLinks(body, partner, subId) {
  if (!partner) return body
  const link = (url) => partnerLink(url, partner, subId)
  const location = body.meta?.location
  return {
    ...body,
    data: body.data.map((offer) => (offer.url ? { ...offer, url: link(offer.url) } : offer)),
    meta: {
      ...body.meta,
      ...(location ? { location: location.page ? { ...location, page: link(location.page) } : location } : {}),
      partner,
    },
  }
}
