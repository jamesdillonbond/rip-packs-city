# Handoff — public board routes report a Supabase-edge 522 as a hard 500, not a transient 503

> ✅ **IMPLEMENTED 2026-09-18 ~08:30 AM PT (Claude Code, desktop) — DO NOT RE-IMPLEMENT.** Shipped as proposed: `lib/api-error.ts` gains a `TRANSPORT_ERROR_CODES` set (read off `err.code`) plus a narrow message match, and a new `upstream_unavailable` code that `statusForSafeError` maps to **503 + Retry-After, `retryable: true`**. Your "new code" option was taken over reusing `timeout`: a query that timed out and a host that was unreachable have **opposite operational responses**, and `default: 500` would have swallowed a new code silently, so the `case` was added too.
>
> ⭐ **Your footgun guard was followed exactly, and it earned its keep.** The match is on `<!doctype html` (the decisive tell — a DB read that returns a **web page**), `522:`/`523:`/`524:` **with the colon**, and the undici/node transport strings — never a bare `"timeout"` or `"connection"`. Three controls pin that narrowness: *"the request hit a timeout building the board"*, *"no connection between these two editions"* and *"this edition sold 522 times"* must each still be a **non-retryable 500**. The last passes **only** because of the colon. Tests assert the **status number and the retryable flag**, per your note, not "some error came back". Checked **after** the timeout branch so no existing classification is re-routed.
>
> ✅ **Verified as you asked:** `__tests__/api-error.test.ts` **25/25** · `tsc` **0** · `lint:ratchet` **715 vs baseline 715** · full `npm test` green. `boardUnavailable` → `apiErrorResponse` was confirmed by grep, so all **29** `/api/public/insights/*` routes inherit it. ⚠ **Your post-deploy verify step is still OWED** — the DB is unreachable (#122), so this is proven against the verbatim production message by unit test, **not** by observing a live 503. The next transient blip is the confirmation: expect `code=upstream_unavailable` at 503 where the log read `code=internal`.
>
> ⚠ **One correction to this document.** It cites *"the established RPC playbook (ledger 2026-09-14)"* for the CF-522 reasoning. **There is no 522 entry in the 09-14 ledger** — `grep` finds the only 522 entries under **2026-09-18**, written ~an hour before this handoff was filed. The reasoning is right; the citation points at the wrong date, and a citation to a playbook that does not exist is the kind of thing the next reader re-derives from scratch.


**Filed:** 2026-09-18, ~8:20 AM PT, by the weekly `rpc-surface-qa` pass.
**Type:** small additive hardening in `lib/api-error.ts`. Not urgent, not a live incident fix.
**Ship discipline:** Cowork can't push and can't verify against the DB right now (see incident), so this is a Claude-Code handoff rather than a live ship. `lib/api-error.ts` is load-bearing for *every* anon-reachable route's error classification and the CLAUDE.md honesty canon warns about it — land it with `npm test` + `test:coverage` green, in a low-traffic window.

## What the QA saw (context — not the thing to fix)

During the pass, a **Supabase platform-side outage** was in progress and still ongoing at ~8:18 AM PT: the project origin `bxcqstmqfzmuolpuynti.supabase.co` was returning **Cloudflare 522 "Connection timed out"** (cf-host-status = Error; Browser + Cloudflare legs green). Per the established RPC playbook (ledger 2026-09-14), **a CF 522 means Cloudflare could not open a connection to the origin — platform-side, NOT our query load** (query-load exhaustion returns a JSON error from a reachable PostgREST, never a 522). Symptoms, all one root cause: Supabase MCP `execute_sql` connection timeouts, slow/timing-out heavy SSR detail pages, `/sitemap/{0,1}.xml` → 503, and Pack Sniper down.

**That outage is transient and self-heals — no code fix, just monitor.** The honesty layer behaved correctly throughout (Pack Sniper page showed "Pack deals couldn't be loaded right now — this is our problem, not an empty market", KPIs "—" not fabricated zeros; sitemap children 503 not a fabricated partial). This handoff is about the one durable code gap the outage *exposed*.

## The actual finding

Vercel runtime errors for `/api/public/insights/pack-sniper` (24h) show a single cluster, both collections (TS + AllDay control), count≈10, HTTP **500**:

```
[public/insights/pack-sniper] code=internal detail=pack_table_rows read failed: <!DOCTYPE html> … supabase.co | 522: Connection timed out
```

`getPackDeals` → the `pack_table_rows` read gets Supabase's **522 HTML page** back (not a PostgREST JSON error), throws, and `boardUnavailable` → `apiErrorResponse` classifies it. In `lib/api-error.ts`, `safeApiError` only maps to the transient `timeout` code (→ **503 + Retry-After**, kept out of the hard-5xx budget) on these message fragments:

```
"statement timeout" | "canceling statement" | "timeout acquiring" | "connection pool"
```

A Supabase-edge **522** carries none of those, so it falls through to `{ code: "internal", retryable: false }` → **`statusForSafeError` returns 500**.

**Consequence:** during a Supabase edge/transport outage (522/523/524, connection reset), every migrated anon board route emits **500 / retryable:false** for what is a *transient, retryable, not-our-fault* platform blip. This (a) inflates the hard-5xx budget the timeout branch was written to protect, and (b) tells clients `retryable:false` when the correct answer is "retry in a minute". The existing `Cache-Control: no-store` on the failure already prevents CDN-pinning, so the blast radius is the status code + retryable flag, not a stuck cache.

## Proposed change (one file)

In `lib/api-error.ts` `safeApiError`, extend the transient branch to also catch Supabase-edge transport failures. Suggested, message-sniffing (these arrive as thrown Errors with the 522 HTML in `.message`, so match on stable substrings):

- `"connection timed out"` / `"522:"` / `"523:"` / `"524:"` (Cloudflare origin-side 5xx from the supabase.co host)
- `"fetch failed"` / `"ECONNRESET"` / `"ETIMEDOUT"` / `"socket hang up"` (undici transport failures reaching the DB host)

Map these to a transient result — reuse `code: "timeout"` (503 + Retry-After, `retryable: true`) or a new `code: "upstream_unavailable"` that `statusForSafeError` maps to 503. Keep classification **SQLSTATE-first**; this is a message-fallback for errors that carry no SQLSTATE (a transport failure has none).

**Guard against a footgun:** match specific tokens, not a bare `"timeout"` or `"connection"` substring — the wrapper text (`"pack_table_rows read failed: …"`) and arbitrary upstream copy must not accidentally get classified transient. Add a unit test asserting a 522-HTML-bodied error → 503/retryable, and a control asserting an unrelated `internal` error still → 500 (the vacuous-assertion trap: assert the *status number*, not just "some error").

## Verify

- `npm test` + `npm run test:coverage` green (new tests included).
- After deploy + Supabase recovery, re-hit `/api/public/insights/pack-sniper` under a forced backing failure if reproducible; otherwise confirm the next transient blip logs the same detail but returns 503. Positive control: an unrelated board `internal` error still returns 500.

## Revert

`git revert <sha>` (single-file change to `lib/api-error.ts` + its test). No DB half, no migration.

## Explicitly NOT in scope

- No change to `boardUnavailable` / the route files (`route.ts`) — the fix is entirely in the shared classifier.
- The Supabase 522 incident itself — platform-side, self-heals.
- The known-deferred artifact prose items (tracked separately in the surface-QA checklist).
