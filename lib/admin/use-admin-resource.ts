"use client"

import { useCallback, useEffect, useState } from "react"

// The admin token-gate + fetch shell, extracted 2026-08-16.
//
// SEVEN `app/admin/*/page.tsx` pages carried a byte-identical copy of this: the same
// localStorage key, the same 401 handling, the same non-2xx body echo, the same
// try/catch/finally. That is the copy-paste class this repo has now paid for four times
// (15 OG cards, 5 sales indexers, 2 dashboard wallet loaders, 2 sniper pages) — and the
// lesson each time was the same: *grep for the shape before fixing the file*. Extracting it
// means the next fix lands in one place, and it moves the logic into `lib/**`, which the
// PRIMARY coverage gate measures — a `page.tsx` is measured by neither gate.
//
// ⚠ THE BEHAVIOUR IS PRESERVED EXACTLY, INCLUDING TWO THINGS THAT LOOK LIKE BUGS AND ARE NOT:
//
//  1. A non-2xx response puts up to 200 characters of the RESPONSE BODY on screen. That is
//     the driver-message leak this codebase bans everywhere else — and it is DELIBERATE
//     here, because CLAUDE.md's own rule carves out exactly this case: "the only routes
//     where a driver message is acceptable are ones gated on a shared OPERATOR SECRET,
//     where the reader is holding the token". The reader of an admin page is the operator
//     debugging the route. Do not "harden" this into a generic message; it would remove the
//     only diagnostic these pages have.
//
//  2. A non-2xx does NOT clear `data`, so a failed REFRESH leaves the previous payload on
//     screen beneath the error. That is also deliberate — last-good beats a blank
//     operations board — but it is the reason `stale` is returned: a caller that renders
//     figures needs to be able to say they are not current, which none of the seven pages
//     could do before.
//
// A 401 is the one case that DOES clear everything: the token is wrong, so the cached
// credential is removed and the page falls back to its entry form. Leaving stale data under
// a bad credential would show one operator another operator's last successful read.

export const ADMIN_TOKEN_KEY = "rpc_admin_token"

/** How many characters of an error body reach the screen. */
export const ADMIN_ERROR_BODY_CHARS = 200

export type AdminFetchOutcome<T> =
  | { kind: "ok"; data: T }
  | { kind: "unauthorized"; message: string }
  | { kind: "http-error"; message: string }

/**
 * Classify an admin response. Pure, so the three branches that decide what an operator is
 * told can be asserted without a DOM.
 *
 * ⚠ `unauthorized` is a SEPARATE kind from `http-error` on purpose. They differ in what the
 * caller must do, not merely in wording: a 401 means the stored credential is wrong and
 * must be discarded, while any other failure means the credential is fine and the request
 * is not. Collapsing them would either strand an operator holding a dead token or throw
 * away a good one every time the route hiccups.
 */
export async function classifyAdminResponse<T>(res: {
  ok: boolean
  status: number
  text: () => Promise<string>
  json: () => Promise<unknown>
}): Promise<AdminFetchOutcome<T>> {
  if (res.status === 401) {
    return { kind: "unauthorized", message: "Invalid token. Re-enter to continue." }
  }
  if (!res.ok) {
    const txt = await res.text()
    return { kind: "http-error", message: `HTTP ${res.status}: ${txt.slice(0, ADMIN_ERROR_BODY_CHARS)}` }
  }
  return { kind: "ok", data: (await res.json()) as T }
}

export interface AdminResource<T> {
  /** The active token, or "" when none is held. */
  token: string
  /** Controlled value for the token entry form. */
  tokenInput: string
  setTokenInput: (v: string) => void
  /** Store the typed token and start fetching. No-ops on blank input. */
  submitToken: () => void
  data: T | null
  loading: boolean
  error: string | null
  /**
   * True when `data` is being shown but the LATEST read failed — i.e. the figures are the
   * last successful ones, not current. Every page rendering a number from `data` should
   * disclose this; none of the seven could before, because none of them tracked it.
   */
  stale: boolean
  refresh: () => void
}

/**
 * @param url  The endpoint to read, or null to hold off (e.g. while a required filter is
 *             unset). Refetches whenever it changes, so a page can put its own filter state
 *             into the URL and get the refetch for free.
 */
export function useAdminResource<T>(url: string | null): AdminResource<T> {
  const [token, setToken] = useState("")
  const [tokenInput, setTokenInput] = useState("")
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [stale, setStale] = useState(false)

  useEffect(() => {
    if (typeof window === "undefined") return
    const cached = localStorage.getItem(ADMIN_TOKEN_KEY)
    if (cached) setToken(cached)
  }, [])

  const run = useCallback(async (t: string, target: string) => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(target, {
        headers: { Authorization: `Bearer ${t}` },
        cache: "no-store",
      })
      const outcome = await classifyAdminResponse<T>(res)
      if (outcome.kind === "unauthorized") {
        localStorage.removeItem(ADMIN_TOKEN_KEY)
        setToken("")
        setError(outcome.message)
        setData(null)
        setStale(false)
        return
      }
      if (outcome.kind === "http-error") {
        setError(outcome.message)
        // `data` is deliberately retained — but it is no longer current, and saying so is
        // the whole point of extracting this.
        setStale(true)
        return
      }
      setData(outcome.data)
      // ⚠ MUTATION SURVIVOR, DOCUMENTED RATHER THAN CONTRIVED AWAY: setting this to `true`
      // here changes nothing observable. Every render of the staleness notice is nested
      // inside the page's `{error && ...}` block, and a successful read clears `error` — so
      // on the success path `stale` is REDUNDANT BEHIND THE ERROR GUARD and no fixture can
      // separate the two values.
      //   It is still not dead: it is what prevents a stale flag SURVIVING a recovery, so
      //   the moment a caller renders the flag outside an error branch — a badge in a
      //   header, say, which is the obvious next use — this line becomes load-bearing. The
      //   three combinations that ARE observable (ok / http-error / unauthorized) are each
      //   asserted in __tests__/component-AdminHealthClients.test.tsx.
      setStale(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setStale(true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (token && url) void run(token, url)
  }, [token, url, run])

  const submitToken = useCallback(() => {
    const t = tokenInput.trim()
    if (!t) return
    localStorage.setItem(ADMIN_TOKEN_KEY, t)
    setToken(t)
  }, [tokenInput])

  const refresh = useCallback(() => {
    if (token && url) void run(token, url)
  }, [token, url, run])

  return { token, tokenInput, setTokenInput, submitToken, data, loading, error, stale, refresh }
}
