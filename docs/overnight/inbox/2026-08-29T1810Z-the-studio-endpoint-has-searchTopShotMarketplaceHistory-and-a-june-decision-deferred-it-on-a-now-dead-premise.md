# `searchTopShotMarketplaceHistory` exists — and a June decision deferred using it on a premise that died yesterday

**Filed 2026-08-29 ~18:10Z (11:10 PT). Status: SCOPED FROM THE REPO, NOT SHIPPED. No
network probe was needed or used.**

My 1630Z filing closed with *"whether the Studio endpoint exposes equivalents is NOT
established and is the first thing to check."* It is established, and it was already in
the repo.

## The introspection was done on 2026-06-24 and it lists Top Shot

`docs/archive/handoffs/handoff-2026-06-24-studio-platform-gql-deep-history.md`, line 34,
enumerating the studio-platform root fields:

> `searchAllDayMarketplaceHistory`, `searchGolazosMarketplaceHistory`,
> `searchPinnacleMarketplaceHistory`, **`searchTopShotMarketplaceHistory`**,
> `searchUFCMarketplaceHistory` (+ EPL, AthleteStudio, Seeds, Pack, Team/Seasonal
> variants), plus `searchAllDayEditions` / `searchGolazosEditions` /
> `searchPinnacleEditions`.

## 🚨 And the same doc explains why we never used it — on a premise that is now false

Line 97:

> **TopShot** is optional here — the existing `topshot-sales-history-backfill` already
> drains via the (different, **also-live**) public-api marketplace GQL; studio-platform
> is a fallback/cross-check.

That reasoning was correct in June and is dead now: `public-api.nbatopshot.com` has been
answering 530/1033 for ~24 hours. ⭐ **This is CLAUDE.md's rule firing exactly — "a filed
DECISION NOT TO ACT is a hypothesis too, and that is the one nobody re-checks." The tell
it names is a cost stated with no number in it; here it is a dependency stated as
"also-live" with no expiry.**

## The work is smaller than it looks — the module is already collection-generic

`lib/studio-sales-history.ts` takes a `StudioHistoryConfig` whose fields include
`queryName: string // searchXMarketplaceHistory`. Two routes already pass it:

```
app/api/cron/allday-studio-sales-history-backfill/route.ts   queryName: "searchAllDayMarketplaceHistory"
app/api/cron/golazos-studio-sales-history-backfill/route.ts  queryName: "searchGolazosMarketplaceHistory"
```

**Both are green today** — 8/8 ok each in 24 h, through the outage. So a Top Shot lane is a
config object plus the per-collection objects the module expects (`progressTable`,
`seedFn`, `sourceTag`), mirroring two working examples — not new integration code.

⚠ It also inherits the module's existing safety rails, which is the reason to reuse it
rather than write fresh: synchronous (no `after()` tail that dies silently), ~200 s
self-budget under the platform's ~300 s cap, self-throttle at >15 recent failures,
idempotent dedup by `transaction_hash`, and `source=<sourceTag>` so the revert is one
`DELETE`.

## ⛔ THE LIMIT, AND IT IS THE IMPORTANT HALF: this covers SALES HISTORY ONLY

The introspected list names `searchAllDayEditions` / `searchGolazosEditions` /
`searchPinnacleEditions` — **and no `searchTopShotEditions`.** So the *editions* side has
no confirmed Top Shot equivalent, and that is where the damage actually is:

| dead-endpoint need | caller | Studio equivalent |
|---|---|---|
| `searchMarketplaceEditions` (asks + offers) | `offers-sweep`, `topshot-fmv-populate` | ⛔ **none in the introspected list** |
| `getUserProfile` (usernames) | `wallet-username-resolver` | ⛔ none listed |
| `getMintedMoment` (moment metadata) | `topshot-moments-hydrator` | ⛔ none listed |
| `searchEditions` (badges/catalog) | `topshot-badges.ts` | ⛔ none listed |
| marketplace sales history | `topshot-sales-history-backfill` | ✅ `searchTopShotMarketplaceHistory` |

⚠ **`offers-sweep` is the one that matters most** — it is the sole writer of
`edition_offers.updated_at`, so it is why every Top Shot low-ask on the site is ~24 h stale
(see the 1605Z filing). **Migrating sales history does not touch that**, and claiming "we
migrated off the dead endpoint" after doing only this slice would be false.

⛔ **NOT established:** whether a Top Shot editions/asks root field exists under a name the
June introspection did not enumerate. The list is explicitly non-exhaustive ("+ EPL,
AthleteStudio, Seeds, Pack, Team/Seasonal variants"), so **absence there is weak evidence,
not proof.** A fresh introspection is the next step and it needs egress this sandbox does
not have — the agent proxy denies `public-api.nbatopshot.com` and I did not test the studio
host, so treat both as unprobed from here.

## Recommended order

1. **Re-introspect studio-platform** for Top Shot editions/asks/profile root fields. One
   query, from an environment with egress. This decides whether the dead endpoint is
   replaceable or merely supplementable.
2. If an editions equivalent exists → migrate `offers-sweep` first; it is the highest
   user-facing value and the 24 h ask staleness stops.
3. The sales-history lane is worth adding regardless as a **cross-check**, per its own
   June framing — it augments (dedup by `transaction_hash`), never replaces.
4. ⚠ Copy the healthy client's request headers when migrating anything:
   `Origin: https://nbatopshot.com`, `Referer`, and a real product User-Agent. The module's
   own comment says the endpoint is "reachable unauthenticated from Vercel egress **with an
   Origin header**". The dead-endpoint client sends `User-Agent: sports-collectible-tool/0.1`
   and nothing else. ⛔ That did not cause this outage — the proxy path failed identically —
   but it is a gratuitous difference from the configuration we know works.
