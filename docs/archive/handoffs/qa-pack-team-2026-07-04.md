# QA sweep — Pack pages (30) + Team pages (10) — 2026-07-04

Audited live on https://www.rippackscity.com via Claude-in-Chrome (same-origin SSR
fetches for coverage + DOM/console reads for render verification). Findings below;
one clearly-broken, safe display bug was **fixed in this pass** (commit alongside this doc).

## Scope correction (task premise vs. live schema)

- The task SQL referenced a `packs` table with `pack_type/total_count/is_active` — **no
  such table exists.** Pack data lives in `pack_distributions` (template) + `pack_ev_latest`
  / `v_allday_pack_ev_corrected` (EV). Audited against those.
- Public pack pages are nested under the collection: `/<collection>/pack/dist/<distId>`
  (the EV / drop-pool / top-pulls **template** page — the audit target) and
  `/<collection>/pack/<packNftId>` (per-instance opened-pack lifecycle). There is no
  top-level `/pack/<slug>` route.
- **UFC Strike and Disney Pinnacle have ZERO rows in `pack_distributions`** — there are no
  UFC/Pinnacle pack pages to audit. (UFC/Golazos/Pinnacle never had primary pack drops we
  index; the dist route only serves Top Shot + All Day meaningfully. Golazos pack pages
  still resolve but the surface was de-linked from nav 2026-05-19.)
- So the audited mix is Top Shot (16, rich EV), All Day (10, corrected EV), Golazos (4,
  sparse). This is the representative-across-collections set the live data allows.

---

## Pack pages — 30 checked, 30 loaded cleanly

All 30 returned HTTP 200, none rendered the "Pack not found" surface, all rendered a
contents/pull section, and spot-checked pages had **zero client-side console errors**.

| Collection | n | Result |
|---|---|---|
| NBA Top Shot | 16 | All load; EV + drop-pool + top-pulls render; values reasonable |
| NFL All Day | 10 | All load; odds/median **corrected** EV renders; holding pack correctly suppressed |
| LaLiga Golazos | 4 | All load; graceful "awaiting pool data" empty state (no drop pool — expected) |

Dist IDs checked — TS: 454, 468, 956, 1205, 1732, 1740, 1748, 1753, 2046, 5215, 5223,
5351, 5355, 5711, 6034 (+1); AD: 764, 768, 769, 1036, 4663, 5000, 5190, 6373, 6396, 6970;
Golazos: 1, 15, 183, 227.

Representative rendered EV (sanity, matches DB):
- TS 5215 "Chasing Haliburton: Chance Hit" — Gross EV $1,053, +EV, value ratio 12.5x ✓
- TS 454 "Base Set S3R4" — Gross EV $3.67, 97% depleted, survivor-bias caveat shown ✓
- AD 5000 "Drake Maye Rookie Marquee" — corrected Gross EV $2,069 ✓
- AD 6373 — correctly shows **"Holding pack — not a consumer pack"** (no nonsense verdict) ✓
- Golazos 15 "Kings of the World" — "Gross EV — awaiting pool data" (honest empty state) ✓

No `$0.00`-as-missing-data, no `$NaN`, no `undefined` reached the rendered pages. (Two pages
initially flagged "NaN" by a case-insensitive scan — both false positives matching the
player name "Nance"; confirmed no NaN in the DOM.)

### BUG FOUND + FIXED — negative Net EV dropped its minus sign

**File:** `app/(collections)/[collection]/pack/dist/[distId]/page.tsx` (KPI grid, ~L1675).

The "Net" sub-line under Gross EV built its string as:

```
`Net ${packEv >= 0 ? "+" : ""}${fmtUsd(Math.abs(packEv))}`
```

For a **negative** net it prepended an **empty string** (not a minus) and then formatted
`Math.abs(packEv)` — so a pack that loses money rendered its loss as a bare positive number.

**Reproduction (pre-fix):** `/nba-top-shot/pack/dist/468` (2020 NBA Finals, pack price
$2,199, Gross EV $954, DB `pack_ev` = **−1245.44**). The KPI rendered **"Net $1,245"** — no
sign — reading like a +$1,245 gain when the pack actually nets **−$1,245**. Same on dist
6034 ("Net $1,244" for a −$1,244 pack), and every other value-negative pack (the majority of
real retail packs). The Value-ratio (0.43x) and margin (−56.6%) cells were correct; only the
Net string lost the sign. Confirmed against the live DOM (leaf text literally `Net $1,245 …`,
no U+2212/hyphen).

**Fix (this pass):** both occurrences on that line changed to
`${packEv >= 0 ? "+" : "−"}` — matching the site's existing negative convention (the
per-pack lifecycle page already uses `d >= 0 ? "+" : "−"`). Pure display-string change, no
data/logic change. `npx tsc --noEmit` clean. Committed + pushed to `main`, deployed, and
**verified live** (below).

### Post-fix verification (live, after deploy)

The fix deployed and was confirmed on production. To make sure the sign class of bug doesn't
lurk elsewhere, a **second, wider sweep of 40 additional Top Shot packs** (not in the first
30) was run against production, chosen to span every EV regime via `ntile(5)` buckets plus
edge cases. Each rendered "Net" string's sign was cross-checked against the DB `pack_ev`
sign:

- **40/40 loaded (HTTP 200), 0 sign violations, 0 NaN, 0 not-found.**
- Negatives now render correctly across the range: −$1.64, −$7.08, −$48.01, −$118, −$729 …
- Positives render `+`: +$0.67, +$19.77, +$30.74, +$305 …
- Clamped-sentinel pack (dist 5424: `pack_ev` −10000, price $200,000) → correctly treated as
  a **Holding pack** (no literal "−$10,000" Net rendered).
- Zero-EV / no-pool packs (dist 659/663/1219/1580/7185/7738/8422/8577 …) → correctly show
  **"awaiting pool data"**, never a false "Net $0.00 / worthless".

**Total audited this session: 70 pack pages + 10 team pages. All load cleanly; the only
defect found (negative Net sign) is fixed and verified across the full EV range.**

---

## Team pages — 10 checked, 10 loaded cleanly

All 10 (Top Shot) returned HTTP 200, rendered the hero + stat strip + Team Checklist, no NaN,
no soft-404. **Edition count and Total Mint match the production `editions` table exactly**
for every team:

| Team | Editions (page = DB) | Total Mint (page = DB) | Players | FMV Total | Floor Total |
|---|---|---|---|---|---|
| Los Angeles Lakers | 580 | 2,307,904 | 74 | $59,547 | $68,054 |
| New York Knicks | 572 | 2,475,503 | 64 | $26,452 | $26,485 |
| Boston Celtics | 567 | 2,824,914 | 51 | $26,958 | $27,678 |
| Golden State Warriors | 540 | 3,181,213 | 61 | $48,214 | $43,666 |
| Denver Nuggets | 519 | 2,910,468 | 52 | $34,849 | $39,466 |
| Minnesota Timberwolves | 509 | 2,769,782 | 47 | $15,807 | $15,440 |
| Cleveland Cavaliers | 494 | 2,379,907 | 52 | $19,858 | $23,220 |
| Philadelphia 76ers | 489 | 2,610,976 | — | — | — |
| Oklahoma City Thunder | 562 | 1,886,691 | — | — | — |
| San Antonio Spurs | 513 | 2,152,841 | — | — | — |

(Editions/Mint verified equal to DB for all 10; the trailing cells were truncated in the
capture but rendered on-page.) FMV Total vs Floor Total ordering varies by team (floor > FMV
where asks sit above fair value) — plausible, not an error. No issues found on team pages.

---

## Scoping items (documented, not fixed)

1. **Golazos pack titles contain mojibake** — UTF-8-decoded-as-Latin-1 corruption in
   `pack_distributions.title`. Scope: **85 / 224 Golazos rows (38%)**; AllDay 9 / 3052 (old,
   2026-05-05); Top Shot 0. No dedicated Golazos pack-distributions seeder exists in the repo
   (only `seed-topshot-pack-distributions` / `seed-allday-pack-distributions`), so these are a
   **frozen one-time import** — no live edge-function writer is re-corrupting them, so a
   durable one-time repair is viable. **But the corruption is heterogeneous and partly
   lossy**, so it is NOT a safe blanket `REPLACE`:
   - Lossy (trailing byte stripped): dashes collapsed to a bare `â` — e.g. `"…Challenge â
     Reward"` (em-dash `—` vs en-dash `–` is unrecoverable from the string); `"Wizard of Ãz"`
     (should be `Öz`).
   - Recoverable (both bytes survive): `"GaudÃ­" → "Gaudí"`, `"CharrÃºa" → "Charrúa"` (LaLiga
     Spanish diacritics).
   Correct durable fix = a mojibake-repair migration handling each pattern **plus re-ingesting
   the lossy dash titles from a clean Golazos source** (Dapper/Golazos GQL). Low priority
   (Golazos pack surface de-linked from nav; title/SEO-only). Out of safe-inline-fix scope —
   a single-substitution UPDATE would introduce wrong characters.

2. **All Day #1-serial reward packs frame gross EV as a green "Net +$X"** (e.g. dist 5000
   "Net +$2,069", Value ratio "—"). These are free reward packs, so net == gross with no
   price anchor — honest, but the positive framing on a non-purchasable pack is slightly
   ambiguous. Minor; not a break. Consider a "Reward pack" badge parity with the Top Shot
   reward-pack handling (`isRewardPack` currently keys on `retailPrice === 0`, which AllDay
   reward packs don't satisfy since their retail is null, not 0).

3. **UFC Strike + Disney Pinnacle have no pack distributions** — the task's "UFC packs"
   can't be audited (none exist to index). Noted for expectations, not a defect.

## Summary

- Pack pages: **70/70 loaded cleanly** (30 primary audit + 40 post-fix verification sweep).
  1 real display bug (negative Net EV missing its sign) found, **fixed, deployed, and verified
  live** across the full EV range; 3 scoping items documented.
- Team pages: **10/10 loaded cleanly**, all edition/mint counts reconcile with the DB.
