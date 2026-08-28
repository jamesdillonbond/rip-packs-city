# Swept the "server-seeded prop has no provenance" class across all 35 call sites — it is **33/35 covered**, and the single real residual is LOW severity

**2026-08-29 00:00Z · Claude Code · a NEGATIVE result, recorded so nobody re-sweeps it**

CLAUDE.md names this as a fifth layer its own helper table does not cover: *"a SERVER-SEEDED PROP …
`initial={rows}` arrives as `[]` with no provenance, so a component that distinguishes failure for its
OWN fetch still concludes on the seed (7 by 08-24)."* **I swept every call site. The class is
substantially CLOSED, and that is worth knowing because the count in CLAUDE.md invites a re-hunt.**

## Method, and the two ways my own scan was wrong first

**Population: 35 `.tsx` files under `app/` + `components/` passing an `initial*={…}` prop.**

⚠ **My first scan printed NOTHING and I nearly recorded "no gaps".** A `|| echo 0` inside a subshell
broke the counter, so the loop compared against a variable that was never set. **A silent scan and a
clean scan look identical** — this repo's own rule (*"assert the COUNT it inspected"*) is what caught it.
- **Attempt 1 (broken):** no output, 0 files actually evaluated.
- **Attempt 2 (too narrow):** matched only `*Failed|Ok|Degraded|Unavailable=` → **16 false gaps**. It
  missed `loadError` (`app/insights/market/page.tsx` returns `{ rows: [], loadError }` and is fully
  honest) and the throw-based path.
- **Attempt 3 (widened):** + `loadError`, `summarizeDegraded`, `degradedFromSource`, `boardUnavailable`,
  `boardEmptyCopy`, `withPagedBoardBudget`, `fetchJson` → **5 candidates**.
- **Attempt 4:** three of those five (`series`, `player`, `set`) use `sectionRows(…, { structural: true })`,
  which **throws** rather than seeding — 8–13 hits each. **→ 2 real candidates.**

⛔ **The lesson for the next sweeper: this class has FIVE sanctioned spellings, not one.** A grep for
`initialFailed` alone reports a false epidemic.

## The two candidates, characterised rather than counted

**1. `app/(collections)/[collection]/sniper/SniperClient.tsx` — NOT a gap.** It throws on `!res.ok` for
the primary feed, carries `depthFloorError` / `depthListingsError`, and its own comment flags that *"the
panel's empty copy is a CONCLUSION"*. Its two silent fallbacks (`ownedIds`, `editionStats`) are
documented enrichments, not the page's claim.

**2. `app/profile/[username]/page.tsx` — a REAL residual, and LOW severity.** The server computes
provenance and then discards it:

```ts
const result = await getPublicProfile(username, "ssr")
const data = result.ok ? result.data : null      // ok is checked, then dropped
initialWallets={Array.isArray(data?.wallets) ? data.wallets : []}
```

A failed read seeds `[]`, identical to a genuinely empty profile.

⭐ **But it does NOT render a false claim, and that is why this is low and not high severity.** The
wallets section is gated `{sortedWallets.length > 0 && …}` — it **omits itself** rather than printing
"no wallets". The tier line returns a bare `"COLLECTOR"` with the comment *"claims nothing either way"*.
`ProfileClient` re-fetches `/api/public/profile/[username]` on mount and self-corrects. And the file
already implements the exact pattern for a sibling section (`slabsError`, *"distinguishes 'this collector
has pinned nothing' from 'we could not read'"*), so the omission looks like a per-section judgement, not
ignorance.

**Residual harm, stated honestly and narrowly:** the SSR HTML — what a crawler and the first paint see —
shows an incomplete profile on a failed read, and `revalidate = 300` can bake that for up to 5 minutes.
The client's own correction is also unguarded: `.catch(function() {})` swallows the re-fetch failure
entirely, so if BOTH reads fail the page stays quietly incomplete.

## Recommendation

👉 **Thread `initialFailed` through `page.tsx` → `ProfileClient` and reuse the existing `slabsError`
shape for the wallets section.** Small and local. ⛔ **But do NOT ship it on the strength of this filing
alone** — it touches a large client component to fix a silent omission rather than a false statement,
and the honest severity is *incomplete*, not *lying*. Worth doing when someone is next in that file.
⚠ **If it IS done, assert it by SSR (`renderToString`), not a mount test** — the mount effect corrects
the state before jsdom looks, which is precisely why CLAUDE.md records that two OPPOSITE mutations pass
every client test here.

## What this filing does NOT establish

⛔ **That the class is closed platform-wide.** The sweep covers `initial*` PROPS only. A server component
that seeds through a differently-named prop, context, or a `children` render is outside it.
⛔ **That 33/35 is durable.** One dated sample, and nothing watches the ratio.
