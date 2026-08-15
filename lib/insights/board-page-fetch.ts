// lib/insights/board-page-fetch.ts
//
// The server-side initial fetch every `/insights/**` board page performs.
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────
// Eight board pages had byte-identical copies of this block:
//
//     const fetchedAt = new Date().toISOString()
//     try {
//       const rows = await fetchSomething(supabaseAdmin, …)
//       return { rows, fetchedAt, ok: true }
//     } catch (e) {
//       console.error("[insights/<slug>] initial fetch", e instanceof Error ? e.message : e)
//       return { rows: [], fetchedAt, ok: false }
//     }
//
// Every one of them imported `supabaseAdmin` for the sole purpose of handing it
// to a fetcher that already lives in `lib/`. That import is what put each page
// on `__tests__/server-page-data-access-ratchet.test.ts`, and
// `app/**/page.tsx` is measured by NEITHER coverage gate — so eight copies of
// the one branch that decides whether an outage renders as a fact were sitting
// in the only part of the tree no gate watches.
//
// Centralising it swaps eight untested copies for one tested function AND drops
// eight pages off the ratchet, because the page no longer needs a client.
//
// ── THE PROPERTY THIS PROTECTS ─────────────────────────────────────────────
// `ok` answers *did the READ succeed*, never *were there rows*. It is what
// `summarizeDegraded([boardStatus(label, ok)])` turns into the visible notice,
// and without it a statement timeout renders as an EMPTY BOARD at HTTP 200 —
// byte-identical to "nothing matched", which on these surfaces is a market
// claim. See lib/insights/board-status.ts.
//
// ⚠ `fetchedAt` is returned even on a FAILED read, deliberately, and it is the
// one field here that could mislead on its own: it is the moment we ASKED, not
// the age of the data. That is safe only because it always travels with `ok`,
// and the caller renders the degraded notice from `ok`. **Do not use
// `fetchedAt` as a freshness signal without checking `ok`** — a caller that
// showed "updated just now" beside a failed read would be making exactly the
// claim this module exists to prevent.

import { supabaseAdmin } from "@/lib/supabase"

export interface BoardPageFetch<T> {
  /** The fetched payload, or the caller's `fallback` when the read failed. */
  data: T
  /** When we ASKED — not the age of `data`. Only meaningful alongside `ok`. */
  fetchedAt: string
  /** Did the READ succeed. NOT "were there rows". */
  ok: boolean
}

/**
 * Run a board page's initial server-side read with the shared failure policy.
 *
 * @param label   Board name for the log line and the degraded notice, e.g.
 *                "Rookie board". Kept human-readable because it is what a
 *                reader sees, not just what an operator greps.
 * @param fallback What `data` becomes when the read fails. Pass the SAME empty
 *                value the client renders for a genuinely empty board — the
 *                honesty comes from `ok`, not from a distinguishable payload.
 * @param fetcher Receives the service-role client. Supplying it here is the
 *                whole point: the page never imports one, so it stays off the
 *                data-access ratchet and out of the unmeasured tree.
 *
 * Never throws — a board page that throws renders an error boundary instead of
 * a board, and these sections are worth serving degraded.
 */
export async function fetchBoardForPage<T>(
  label: string,
  fallback: T,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fetcher: (db: any) => Promise<T>,
): Promise<BoardPageFetch<T>> {
  // Stamped BEFORE the read so it reflects when we asked, matching what these
  // pages did individually.
  const fetchedAt = new Date().toISOString()
  try {
    const data = await fetcher(supabaseAdmin)
    return { data, fetchedAt, ok: true }
  } catch (e) {
    console.error(`[insights/${label}] initial fetch`, e instanceof Error ? e.message : e)
    return { data: fallback, fetchedAt, ok: false }
  }
}
