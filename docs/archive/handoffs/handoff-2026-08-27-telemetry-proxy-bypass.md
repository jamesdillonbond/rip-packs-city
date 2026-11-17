# Handoff — anon `/api/telemetry` beacon is proxy-gated and dropped (405)

**Date:** 2026-08-27 (PT) · **Author:** Cowork weekly surface-QA pass
**HEAD at time of writing:** `2cf20864`

## Context

Nothing shipped live by Cowork for this item — it is a route/proxy change, which needs Claude Code + git. This handoff covers **one** code fix. It was found by the weekly QA pass reading live network traffic on `https://www.rippackscity.com/insights/pack-sniper` (anonymous browser session), and confirmed against the DB and the repo. This is the **P1 Finding A class** the QA checklist watches for: an anonymous fire-and-forget POST that `302 → /login → 405` and is silently dropped.

## Item 1 (P1) — add `/api/telemetry` to `isPublicPath` in `proxy.ts`

**File:** `proxy.ts` (verified present; function `isPublicPath`, the anon-bypass block around the existing `/api/track-funnel` / `/api/track-click` / `/api/subscribe` entries near line 386).

**Symptom (observed live 2026-08-27):** On an anonymous load of `/insights/pack-sniper`, the browser fires `POST /api/telemetry`. The network trace shows:

```
POST https://www.rippackscity.com/api/telemetry            → 405
POST https://www.rippackscity.com/login?next=%2Fapi%2Ftelemetry   (redirect target)
```

`POST /api/track-funnel` on the same page returns **200**. The difference is that `track-funnel` is in the proxy's public-bypass list and `/api/telemetry` is not, so the unauthenticated telemetry POST is caught by the session gate, `302`'d to `/login`, and `/login` rejects POST with `405`. The beacon is dropped.

**Root cause:** `app/api/telemetry/route.ts` is explicitly designed to accept anonymous callers — its header comment says it resolves the wallet server-side "…falling back to a `user:<auth_id>` sentinel … and `"anon"` for fully unauthenticated callers," and it clamps/validates every field server-side (`normalizeFeature`, `safeMetadata`, 80-char feature cap, 4 KB metadata cap, returns 204). But `isPublicPath` in `proxy.ts` never allow-lists it (`grep -n "telemetry" proxy.ts` → not found). So every anonymous beacon is gated out. `lib/telemetry/track.ts` (the client that fires it) runs for anon visitors, so the entire anonymous telemetry stream is lost.

**Positive control (DB, read-only, verified 2026-08-27):**

```
SELECT count(*) FILTER (WHERE wallet_address='anon')     AS anon_14d,   -- 0
       count(*) FILTER (WHERE wallet_address LIKE 'user:%') AS authed_14d -- 10
FROM usage_events WHERE occurred_at > now() - interval '14 days';
```

Over 14 days `usage_events` has **10 authed (`user:%`) rows and 0 anonymous rows** — authed telemetry lands (those paths carry a session cookie), anon telemetry is uniformly dropped. This is exactly the "authed rows exist, anon rows zero" signature the checklist calls for.

**The fix (one line), mirroring the adjacent `track-funnel` bypass:**

Add, immediately after the existing `if (pathname === "/api/track-funnel") return true` line:

```ts
// /api/telemetry — lightweight anon-safe beacon backing lib/telemetry/track.ts.
// Client fires it for anonymous visitors; the route resolves the caller server-side
// (auth session -> wallet, else "user:<id>", else "anon") and clamps every field.
// Without this bypass the unauth POST 302s to /login -> 405 and the beacon is dropped.
// The proxy /api/ rate limiter (60/min/IP) still applies.
if (pathname === "/api/telemetry") return true
```

**Why safe:** the route already validates/clamps all input server-side and returns 204; it writes only to `usage_events`; it holds no destructive capability. This exactly matches the risk profile of `track-funnel` / `track-click`, which are already public. The `/api/` rate limiter still applies.

**Verify after shipping:**
- `npx tsc --noEmit` clean.
- Vercel deploy reaches READY (touch a non-docs file so `ignoreCommand` doesn't skip the build — commit the ledger BEFORE the code so the code commit is the tip).
- Re-load `/insights/pack-sniper` in an anonymous/incognito window and confirm `POST /api/telemetry` returns **204** (not 405), no `/login` redirect.
- Positive control: after a little anon traffic, `SELECT count(*) FROM usage_events WHERE wallet_address='anon' AND occurred_at > now()-interval '1 hour'` should be **> 0**.

**Revert path:** `git revert <the fix commit>` — the change is a single additive `if` return in `isPublicPath`; reverting it restores the current gated behavior. No DB half.

## Guardrails (repeat every handoff)

- Direct-to-`main`, **no branches, no PRs** (CLAUDE.md non-negotiable). If a `claude/*` branch is pre-checked-out, `git switch main` first.
- Commit via **PowerShell `git`** on Windows (Git Bash `git commit` can silently no-op). Re-verify the push with `git rev-list --count origin/main..HEAD` (expect `0`).
- `curl` fails silently in Git Bash for Vercel REST — use PowerShell `Invoke-WebRequest`.
- Vercel Pro `maxDuration` hard cap is **800 s** — anything higher sends the deploy to ERROR invisibly.
- CRLF: don't string-replace-patch on Windows; use full-file writes or `findIndex` on split lines.
- Commit the **ledger before the code** so the code commit is the tip and auto-deploys (a docs-only tip skips the Vercel build).

**Claude Code's direct file inspection wins over this doc and over `project_knowledge_search` on any disagreement — adapt to the actual file shape.** In particular, place the new `if` beside the real `track-funnel` line wherever it currently sits, not at a hardcoded line number.

## Expected end state

One commit on `main`, Vercel deploy READY, anonymous `POST /api/telemetry` returns 204, and `usage_events` starts accumulating `anon` rows again (currently 0 over the last 14 days).
