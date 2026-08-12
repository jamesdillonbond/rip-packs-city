// A fetch wrapper whose result can distinguish "the server said nothing matched"
// from "we never got an answer".
//
// WHY THIS EXISTS. Every client dashboard under /analytics fetches with some
// variant of
//
//     fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => {})
//
// which collapses four distinct outcomes — a network failure, a 5xx, an
// unparseable body, and a successful empty result — into one indistinguishable
// `null`/`[]`. The render layer then reads that as data and states a conclusion:
// "No recent whale trades.", "No Flowty marketplace activity in this window.",
// "Pack analytics not yet available for this collection.", and — sharpest —
// "No significant movers in this window — try a longer time range or lower min
// FMV floor.", which instructs the reader to loosen a filter in response to a
// database outage.
//
// This is the same class the /insights sweep closed server-side (see
// lib/insights/board-status.ts). The client dashboards were never swept because
// their failure path is a `.catch` in a useEffect rather than an `if (error)` in
// a server page, so a grep for the server spelling finds none of them.
//
// The discriminator is `ok`, NEVER `json == null`: a route may legitimately
// answer with a literal JSON `null` body, which is a successful response. A
// caller that branches on the payload being empty reintroduces the exact
// conflation this module exists to remove.

export interface JsonResult<T> {
  /**
   * true only when a response arrived, carried a 2xx status, AND its body
   * parsed as JSON. False means we do not know what the server would have said.
   */
  ok: boolean
  /** Parsed body on success; always null when `ok` is false. */
  json: T | null
}

/**
 * Fetch a URL and parse JSON, reporting failure as data rather than throwing.
 *
 * Never rejects — callers run inside useEffect chains where an unhandled
 * rejection would be swallowed anyway, and the whole point is that the failure
 * reaches the render layer instead of disappearing into a `.catch(() => {})`.
 */
export async function fetchJson<T = unknown>(
  url: string,
  init?: RequestInit
): Promise<JsonResult<T>> {
  try {
    const res = await fetch(url, init)
    // A 4xx/5xx often still carries a JSON body (an error envelope). Parsing and
    // returning it would put driver text or an `{error}` object where the caller
    // expects rows, so the status gates the parse.
    if (!res.ok) return { ok: false, json: null }
    const json = (await res.json()) as T
    return { ok: true, json }
  } catch {
    // Network failure, abort, or a 200 whose body is not JSON (an HTML error
    // page or a login redirect — both real on this site, since proxy.ts answers
    // an unauthenticated request with login HTML at status 200).
    return { ok: false, json: null }
  }
}
