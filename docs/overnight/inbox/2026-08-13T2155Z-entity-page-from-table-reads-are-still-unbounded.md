# Two `.from()` table reads on the edition page are still unbounded — the RPC half is fixed, this half is not

> ## ✅ RESOLVED — verified against the code 2026-08-15
>
> `withQueryDeadline` exists in `lib/analytics/rpc-with-retry.ts` and the entity
> page's table reads moved into `lib/edition/fetchers.ts`, which uses it. The
> unbounded `.from()` reads this filing measured are gone.


Claude Code, interactive, 2026-08-13 ~14:55 PT (21:55Z). **Read-only finding. Filed as the deliberately
scoped-out remainder of a fix that shipped in the same session (`e39b9621`).**

---

## What shipped, and what it does not cover

`rpcWithRetry` now carries a TOTAL wall-clock budget (`DEFAULT_RPC_TIMEOUT_MS = 45_000`), so an **RPC**
that never answers can no longer park a render until Vercel's 300s kill. Every RPC in the edition page's
blocking shell was routed through it, including the three that were still on a bare `.rpc()`
(`get_edition_market_bundle`, `get_edition_insight_links`, `get_badge_display_metadata`).

⚠ **`rpcWithRetry` is RPC-shaped and does not cover PostgREST TABLE reads.** Two remain on the edition
page, both on a bare `supabaseAdmin.from(...)` with no bound:

| fetcher | read | file |
|---|---|---|
| `fetchPackProvenance` | `.from(v_topshot_edition_pull_provenance \| v_allday_edition_pull_provenance)` | `app/(collections)/[collection]/edition/[slug]/page.tsx` ~L263 |
| `fetchOwnerUsernames` | `.from("wallet_usernames")` | same file, ~L319 |

Both are real production error sources today — `[edition] pack provenance Timed out acquiring connection
from connection pool.` (19 events) and `[edition] owner_usernames Timed out acquiring connection from
connection pool.` (5 events) — so the connection they use is demonstrably one that can stall.

## Why this was NOT folded into the same fix (and why it is lower severity)

**They sit BELOW the `<Suspense>` boundary.** The reported symptom — the page stuck on
"SCANNING THE MARKETPLACE…" — is the route `loading.tsx` covering the page's blocking *shell*, and these
two are in the streamed bottom block. A hang here therefore strands a lower SECTION on its own fallback
while the hero renders; it cannot reproduce the reported bug. It does still burn the lambda to the 300s
kill and leaves a permanently-spinning section, so it is worth closing — just not the same defect.

Bounding them needs a **different helper**: `rpcWithRetry` takes `(client, fnName, args)` and returns
`{ data, error }` from `.rpc()`. A `.from().select()...` builder is a different call shape, so reusing it
would mean either overloading it awkwardly or writing a second primitive.

## Suggested shape

A small `withQueryDeadline(builder, ms)` alongside `rpcWithRetry`, reusing the **same two mechanisms that
are already proven in `withDeadline`**:

1. `.abortSignal(AbortSignal.timeout(ms))` when present — genuinely cancels and **releases the pool
   slot**, which is the half that matters while the pool is the thing saturating.
2. a `Promise.race` guard — because the repo's own mocks shape these builders as bare thenables, so the
   signal cannot be assumed to exist. (Verified 2026-08-13: `PostgrestFilterBuilder` DOES expose
   `abortSignal`, and an abort **RETURNS** an error rather than throwing, with `code: ""`.)

⚠ **Keep the same 45s reasoning — do not pick a tighter number here either.** The bound exists to catch
what the database cannot bound itself; a genuinely running statement is already capped by `service_role`
`statement_timeout=30s`. See the `2026-08-13T2115Z` file for the companion case: `get_series_detail`
legitimately runs ~20s and dies on Postgres's own timeout into a retryable error boundary. A 15–20s
client bound would pre-empt that handled path.

## Scope check already done

Swept all five entity routes: **only the edition page** has bare `.rpc(`/`.from(` data access left.
`player`, `team`, `set`, `series` are fully on `sectionRows`/`sectionRow` → `rpcWithRetry`. So this is
two call sites in one file, not a sweep.

Related: the new `__tests__/server-page-data-access-ratchet.test.ts` already freezes the count of pages
holding an inline Supabase client. Extracting these two into `lib/` would satisfy that ratchet's stated
remedy *and* let them be bounded and tested at the same time — the two pieces of work are the same edit.
