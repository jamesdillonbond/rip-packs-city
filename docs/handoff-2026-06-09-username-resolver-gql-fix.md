# Handoff — username resolver returns 0 (missing GQL fragment) — 2026-06-09

**One-line fix.** The username populator `/api/cron/resolve-wallet-usernames` (CC `3fdbf25`) is live and the cron is wired (cron-job.org job 7776245, every :08/:38, test-run-verified 200 + correct `X-Matched-Path`), but its first run logged `wallet-username-resolver` `ok=true` with **`resolved: 0` of a 150-address batch, missed: 0** — it resolves no usernames at all, so `wallet_usernames` is stuck at 57.

**Root cause (verified by diff against the working seed script).** The route's `SEARCH_USERS_QUERY` in `app/api/cron/resolve-wallet-usernames/route.ts` (~line 27) is **missing the `... on Users` inline fragment** that the proven `scripts/seed-wallet-usernames.ts` (which populated the original 57 rows) has. `searchSummary.data` is a union type, so selecting the inner `data` without the `... on Users` fragment makes the query invalid — Top Shot returns a GQL error, the route's `if (body?.errors?.length) return null` swallows it, and every address resolves to null. That's exactly the `resolved 0 / missed 0` signature (it's a clean null return, not a fetch failure).

**The fix** — add the `... on Users` layer so the query matches the seed script:

```graphql
// CURRENT (broken) — app/api/cron/resolve-wallet-usernames/route.ts SEARCH_USERS_QUERY
searchUsers(input: $input, paginationInput: $paginationInput) {
  searchSummary {
    data {
      data {
        ... on User { publicInfo { username flowAddress } }
      }
    }
  }
}

// FIXED — insert "... on Users { ... }" between searchSummary.data and the inner data
searchUsers(input: $input, paginationInput: $paginationInput) {
  searchSummary {
    data {
      ... on Users {
        data {
          ... on User { publicInfo { username flowAddress } }
        }
      }
    }
  }
}
```

The response-parsing path is already correct and unchanged: `body?.data?.searchUsers?.searchSummary?.data?.data` (the seed script uses the same path). Only the query needs the fragment. Everything else in the route (proxy routing via `TS_PROXY_URL` + `x-proxy-secret`, the `searchPhrase: addr` input, the negative-cache `last_attempted_at`, the upsert) is fine.

**Verify after fix:** trigger the cron once (or wait for the next :08/:38) and confirm the `wallet-username-resolver` `pipeline_runs` row shows `resolved > 0`, and `SELECT count(*) FROM wallet_usernames` climbs above 57. Then the wired UI surfaces (`UserLabel`, SalesTablePaginated, BiggestSales, WhaleWatch7d, NetMarketplaceLeaderboard, the moment page) will start showing `@handles`.

**Guardrails:** commit/push to `main` directly; PowerShell `git` on Windows (verify `git rev-list --count origin/main..HEAD` = 0). **Revert:** `git revert`.

---

# Item 2 (small) — pack dist-page survivor-bias caveat shows the wrong depletion %

On `app/(collections)/[collection]/pack/dist/[distId]/page.tsx`, the Phase-1 EV honesty caveat (the new survivor-bias / secondary-ask text shipped in `b40ce05`) renders **"EV inflated by survivor bias (0% opened)"** on dist 5888, which is actually **86% depleted** (`pack_ev_latest.depletion_pct = 86`). The caveat fires correctly and the secondary-ask anchor is right; only the parenthetical **% opened** is wrong — it's reading the wrong field (or `0%` is a default), which is self-contradictory since survivor bias requires a *high* opened %. Fix: point that % at the real depletion (`depletion_pct`, or `100 - remaining/original`). Verified live 2026-06-09 on `/nba-top-shot/pack/dist/5888`. Cosmetic but user-facing on an honesty caveat. **Revert:** `git revert`.
