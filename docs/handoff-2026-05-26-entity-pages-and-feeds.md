# Claude Code handoff — Entity-page enhancements + Sniper/Market feed restoration

Date: 2026-05-26
Authored from: live Cowork audit (DB + production runtime logs + screenshot evidence)

This is a single prompt covering: (1) pack-page bug fix, (2) editions-duplicate root cause for the wrong-team bug, (3) moment / edition / player / series / set page enhancements, (4) Sniper + Market feed restoration for Top Shot and NFL All Day, (5) Top Shot pack outbound URL fix, (6) supporting DB migrations.

The work is committed direct-to-`main` per CLAUDE.md. Smoke-test after each chunk before moving to the next.

---

## 0. TL;DR — what to do in order

1. **Hotfix the pack dist page** — `/nba-top-shot/pack/dist/6739` is throwing client-side ("Attempted to call ti..." in runtime logs, 200 + error). Wrap with defensive nulls + a real error boundary so the actual error surfaces.
2. **Merge UUID-keyed duplicate TS editions.** ~8,000 TS editions have a UUID-`external_id` twin of an integer-keyed canonical row, and the UUID twin frequently has wrong `team_name` (the "Philadelphia 76ers" Avdija Fresh Threads in the screenshot — the integer row has "Portland Trail Blazers"). This is the single biggest data-quality lever in the audit.
3. **Restore Sniper + Market feeds.** The feeds (`cached_listings_v2`) are alive and fresh — 34,661 NFL All Day direct rows, 6,656 V1 Dapper rows, TS listings populated; pipelines green. The frontend just stopped reading `cached_listings_v2` after the Flowty teardown. Wire the existing `get_allday_sniper_deals` RPC back into `/api/sniper-feed`, add a TS-cached counterpart, point Market at the same.
4. **Moment page enhancements** — buyer/seller column, high offer, badges, parallels, info-bar correctness.
5. **Top Shot pack outbound URL fix** — `nbatopshot.com/listings/p2p?packListingId=...` is dead; switch to a stable URL that still resolves.
6. **Player / series / set polish** — loading skeletons, tiny token-compliance fix, info bar consistency.

Everything below assumes you are on `main`, working directly. No PRs. Don't create feature branches.

---

## 1. Pack dist page hotfix — `/nba-top-shot/pack/dist/6739`

### Symptom

- User report: "https://www.rippackscity.com/nba-top-shot/pack/dist/6739 errors out."
- Production Vercel runtime logs, last 12h:
  - `02:54:47 GET /nba-top-shot/pack/dist/6739 → 200 error: Error: Attempted to call ti...`
  - `01:45:48 GET /nba-top-shot/pack/dist/6739 → 500 error: (node:4) [DEP0169] Deprecat...`
  - `01:45:47 GET /nba-top-shot/pack/dist/6739 → 200 error: Error: Attempted to call ti...`
- DB confirms pack exists: `pack_distributions` and `pack_table_rows` both have a row for `(collection_id='95f28a17-...', dist_id='6739')` titled "Holiday of Hoops: Chance Hit", retail $5, 3 slots, `pack_listing_uuid='2d5b6510-f50a-40b2-9dcb-0c2a3ca9ce84'`.

So this is not a 404 — the page is fetching successfully then throwing during render. The truncated `"Attempted to call ti..."` is most likely a `TypeError` like "Attempted to call timeAgo / toFixed / toLocaleString on undefined" inside a downstream component. The runtime log truncates at ~50 chars (per CLAUDE.md), so the file/line isn't recoverable from the log search; we need to surface it.

### File to edit

`app/(collections)/[collection]/pack/dist/[distId]/page.tsx`

### What to do

a) **Add a top-level error boundary.** Create `app/(collections)/[collection]/pack/dist/[distId]/error.tsx`:

```tsx
"use client"
import { useEffect } from "react"

export default function PackDistError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // surface full message + stack to Vercel logs (console.log is indexed, console.warn is not per CLAUDE.md)
    console.log("[pack-dist-error]", { name: error.name, message: error.message, digest: error.digest, stack: error.stack })
  }, [error])

  return (
    <main style={{ minHeight: "60vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "48px 24px", gap: 16 }}>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)", letterSpacing: "0.3em", textTransform: "uppercase", color: "var(--rpc-text-muted)" }}>
        Pack page error
      </div>
      <h1 style={{ fontFamily: "var(--font-display)", fontWeight: 900, fontSize: "clamp(32px, 6vw, 56px)", letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--rpc-text-primary)", margin: 0 }}>
        Couldn't render this pack
      </h1>
      <p style={{ color: "var(--rpc-text-secondary)", maxWidth: 480, textAlign: "center", margin: 0 }}>
        We logged the failure. Reload to try again, or head back to the pack index.
      </p>
      <button onClick={() => reset()} style={{ marginTop: 8, padding: "10px 18px", border: "1px solid var(--rpc-border-subtle)", color: "var(--rpc-text-primary)", background: "transparent", fontFamily: "var(--font-mono)", letterSpacing: "0.2em", textTransform: "uppercase", fontSize: 12 }}>
        Reload
      </button>
    </main>
  )
}
```

b) **Defensive null guards in the page itself.** Audit every `.toFixed`, `.toLocaleString`, `.toString()`, `formatDistanceToNow(...)` / `fmtAbsDate(...)` / `timeAgo(...)`, and every `.map(...)` against arrays sourced from `fetchTopPulls` / `distMetadata`. The Avdija data we ran through DB shows `game_date` can be NULL (the Avdija Base Set play_id 1900 with `game_date: null, series: 1`). Anything that does `new Date(game_date).toLocaleString()` blows up on NULL — that's the most likely "Attempted to call ti..." (`toLocaleString` on Invalid Date or undefined).

  Concrete grep targets inside that file: `toLocaleString`, `toLocaleDateString`, `toLocaleTimeString`, `timeAgo`, `fmtAbsDate`, `formatDistanceToNow`. For each, replace `value.toLocaleString()` with `value != null ? value.toLocaleString() : "—"` and for date helpers, guard against `null` and `Invalid Date`.

c) **`topPulls` array shape guard.** Around line 134-240 the page builds top-pulls. The fmv-recalc Step 3 chunk-correctness fix on 2026-05-25 means some editions now have NULL `fmv_usd` even though they had values before. Make sure `topPulls.filter(p => p.fmv_usd != null).map(...)` rather than crashing on null.

d) **Re-deploy and tail logs** with `mcp__9147546a-a5d7-42b9-9cd6-d67951a51908__get_runtime_logs` filtered by `query="pack-dist-error"`. With the boundary in place you will get the full error.message + stack and can pinpoint the line, then remove the boundary or tighten it.

### Acceptance

- Hitting `/nba-top-shot/pack/dist/6739` while authenticated returns 200 with rendered content. If it still hits the boundary, the error.tsx logs surface the real cause in Vercel runtime logs, and you push a targeted fix.

---

## 2. Top Shot editions duplicate-merge (the wrong-team-name root cause)

### Symptom

User screenshot: Avdija Fresh Threads from 2024-10-24 shows **Team: Philadelphia 76ers**. Avdija was on Portland Trail Blazers on that date (he was traded to POR from WAS July 2024; the PHI trade is current-season 2025-26). The "current team" label is leaking into a historical moment.

### Root cause (verified live)

There are **two rows** in `editions` for that single moment:

| id | external_id | team_name | source |
|---|---|---|---|
| `9fa40ba0-b365-4e26-b68e-951b7475f8c7` | `3b742784-7a8d-4b43-9dc8-b33c1be841b3:e171c5a8-...` | **Philadelphia 76ers** ❌ | GQL `searchEditions` (UUID-keyed) |
| `6781d5b3-d45d-4c58-90b6-2803f868f3df` | `168:5766` | **Portland Trail Blazers** ✅ | Cadence on-chain (integer-keyed) |

Both rows share `(set_id_onchain=168, play_id_onchain=5766)`. The UUID-keyed row was written by the TS GQL editions catalog (which reflects whatever team TS currently labels the player) and the integer-keyed row was written by Cadence on-chain metadata, which has team-at-time-of-play.

**Scope**: across NBA Top Shot (`collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd'`):

| metric | value |
|---|---|
| Total TS editions with both `set_id_onchain` + `play_id_onchain` populated | 17,106 |
| Integer-keyed canonical rows | 8,995 |
| UUID-keyed duplicate rows | 8,111 |
| Distinct `(set_id_onchain, play_id_onchain)` pairs | 9,067 |
| Pairs with only integer row (no UUID dupe) | 1,196 |
| Pairs with only UUID row (no integer twin yet) | 72 |
| Pairs with both (mergeable) | 7,799 |

So ~47% of TS editions are duplicates that need merging.

### What to do

a) **Apply the migration** (this is the big one — write it as a transactional migration via `apply_migration`).

The plan: for each `(set_id_onchain, play_id_onchain)` pair that has both an integer-keyed canonical row and one-or-more UUID-keyed dupes:
1. Repoint FK references from the UUID-keyed `id` to the integer-keyed `id` across every dependent table.
2. Copy any non-NULL field from the UUID-keyed row into the integer-keyed row only if the integer row's field is NULL (the integer row is the trusted source for team_name/game_date; UUID row may have richer thumbnails / videos in some cases).
3. Delete the UUID-keyed row.

Dependent tables to repoint (audit each before running):

| table | edition_id column |
|---|---|
| `sales*` (partitioned) | `edition_id` |
| `fmv_snapshots*` (partitioned) | `edition_id` |
| `wallet_moments_cache` | `edition_id` (also `edition_key` joins by `editions.external_id` — keep this in mind) |
| `cached_listings_v2` | `edition_id` |
| `marketplace_offers*` (partitioned) | `edition_id` |
| `special_serial_holders` | `edition_id` |
| `pack_drop_pool` | `edition_id` |
| `badge_editions` | `edition_id` |
| `unmapped_sales` | `edition_id` (may be NULL pre-resolution) |
| `pinnacle_*` tables | N/A (Pinnacle uses its own table — skip) |

Note on `wallet_moments_cache.edition_key` — per the memory in `wmc-edition-key-contract.md`, `wmc.edition_key` MUST equal `editions.external_id`. Since the integer row is canonical going forward, ensure `wmc.edition_key` rows that previously pointed to the UUID-keyed external_id are rewritten to the integer-keyed external_id (e.g. `168:5766`).

b) **Migration body sketch**. Apply via `mcp__24ab6d77-3292-4646-b039-669cc9535ef8__apply_migration`:

```sql
-- audit_20260526_merge_topshot_uuid_keyed_edition_duplicates

-- Step 1: build a mapping table of UUID-keyed -> integer-keyed canonical
CREATE TEMP TABLE ts_edition_merge AS
WITH ts AS (
  SELECT id, external_id, set_id_onchain, play_id_onchain,
    (external_id ~ '^[0-9]+:[0-9]+$') AS is_integer_keyed
  FROM editions
  WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
    AND set_id_onchain IS NOT NULL
    AND play_id_onchain IS NOT NULL
),
canonical AS (
  SELECT set_id_onchain, play_id_onchain, id AS canonical_id, external_id AS canonical_ext
  FROM ts WHERE is_integer_keyed
)
SELECT u.id AS dupe_id, u.external_id AS dupe_ext, c.canonical_id, c.canonical_ext
FROM ts u
JOIN canonical c USING (set_id_onchain, play_id_onchain)
WHERE NOT u.is_integer_keyed;

-- Step 2: repoint each dependent table inside one transaction
-- (use EXECUTE in a DO block so the migration completes even if a table is missing)

UPDATE sales s SET edition_id = m.canonical_id
FROM ts_edition_merge m WHERE s.edition_id = m.dupe_id;

UPDATE fmv_snapshots f SET edition_id = m.canonical_id
FROM ts_edition_merge m WHERE f.edition_id = m.dupe_id;

UPDATE wallet_moments_cache w SET edition_id = m.canonical_id, edition_key = m.canonical_ext
FROM ts_edition_merge m WHERE w.edition_id = m.dupe_id;

UPDATE cached_listings_v2 cl SET edition_id = m.canonical_id
FROM ts_edition_merge m WHERE cl.edition_id = m.dupe_id;

UPDATE marketplace_offers o SET edition_id = m.canonical_id
FROM ts_edition_merge m WHERE o.edition_id = m.dupe_id;

UPDATE special_serial_holders s SET edition_id = m.canonical_id
FROM ts_edition_merge m WHERE s.edition_id = m.dupe_id;

UPDATE pack_drop_pool p SET edition_id = m.canonical_id
FROM ts_edition_merge m WHERE p.edition_id = m.dupe_id;

UPDATE badge_editions b SET edition_id = m.canonical_id
FROM ts_edition_merge m WHERE b.edition_id = m.dupe_id;

UPDATE unmapped_sales u SET edition_id = m.canonical_id
FROM ts_edition_merge m WHERE u.edition_id = m.dupe_id;

-- Step 3: pull-through any richer fields from the dupe into the canonical (only fill NULLs)
UPDATE editions e
SET thumbnail_url = COALESCE(e.thumbnail_url, d.thumbnail_url),
    video_url     = COALESCE(e.video_url, d.video_url),
    badges        = COALESCE(e.badges, d.badges),
    reward_indicators = COALESCE(e.reward_indicators, d.reward_indicators),
    play_category = COALESCE(e.play_category, d.play_category),
    first_minted_at = COALESCE(e.first_minted_at, d.first_minted_at)
FROM ts_edition_merge m
JOIN editions d ON d.id = m.dupe_id
WHERE e.id = m.canonical_id;

-- Step 4: delete the dupes
DELETE FROM editions e USING ts_edition_merge m WHERE e.id = m.dupe_id;
```

c) **Pre-flight verification before running**:

```sql
-- Row counts before
SELECT count(*) FROM editions WHERE collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd';
-- After (expect ~9,067 + the 72 UUID-only orphans = ~9,139 TS editions, down from 17,106)

-- Spot check: Avdija Fresh Threads
SELECT id, external_id, team_name FROM editions
WHERE player_name='Deni Avdija' AND set_name='Fresh Threads';
-- After: only the integer-keyed row with team_name='Portland Trail Blazers' remains
```

d) **Post-merge invariant trigger** (defensive — prevent the dupes from re-accumulating). After the merge, write a BEFORE INSERT trigger on `editions` that rejects a UUID-keyed insert for TS if an integer-keyed row already exists for the same `(set_id_onchain, play_id_onchain)`:

```sql
CREATE OR REPLACE FUNCTION editions_block_topshot_uuid_dupe() RETURNS trigger AS $$
BEGIN
  IF NEW.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
     AND NEW.external_id !~ '^[0-9]+:[0-9]+$'
     AND NEW.set_id_onchain IS NOT NULL
     AND NEW.play_id_onchain IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM editions e
       WHERE e.collection_id = NEW.collection_id
         AND e.external_id ~ '^[0-9]+:[0-9]+$'
         AND e.set_id_onchain = NEW.set_id_onchain
         AND e.play_id_onchain = NEW.play_id_onchain
     ) THEN
    -- Silently drop; the integer-keyed canonical exists
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER editions_block_topshot_uuid_dupe_trg
BEFORE INSERT ON editions
FOR EACH ROW EXECUTE FUNCTION editions_block_topshot_uuid_dupe();
```

e) **GQL editions ingest** — find the route that writes UUID-keyed editions rows (search the repo for `external_id:` references and look for the GQL editions-catalog populator). Switch it to upsert against the integer key (`set_id_onchain:play_id_onchain`) when both are known. The Cadence path that writes integer-keyed rows is the source of truth; GQL should backfill metadata only.

### Acceptance

- Avdija Fresh Threads 2024-10-24 renders `Team: Portland Trail Blazers`.
- `count(editions WHERE collection_id=TS) ≈ 9,139` (down from 17,106).
- Re-run `audit_20260524_edition_detail_badges_from_unified` and the moment-page audit screenshots — every page renders the integer-keyed canonical.

---

## 3. Moment page enhancements

File: `app/moment/[id]/page.tsx` (per-NFT page, e.g. `/moment/<nft_id>`)
Companion file: `app/(collections)/[collection]/edition/[slug]/page.tsx`
Companion modal: `components/MomentDetailModal.tsx`

The per-NFT page is where most of the user's complaints land; the edition page is the per-edition aggregator. Both need parallel improvements.

### 3.1 Replace "Marketplace" column with Buyer + Seller in Recent Activity

The `sales` table already has `buyer_address` + `seller_address` populated (verified). Most NFTs sell on Top Shot for TS-collection moments and on Dapper-V1 for AllDay/Golazos/UFC, so the marketplace column is low-information ("topshot" everywhere). Buyer/seller is high-information.

**Steps**:

a) The recent-sales RPC contracts already return buyer/seller fields. Confirm the route handlers pass them through (per the audit they already do — `RecentSale` interface line 87-94 in `app/moment/[id]/page.tsx` and `SaleRow` line 73-83 in the edition page).

b) Replace the rendered "MARKETPLACE" column header with two columns: "BUYER" / "SELLER".

c) Each cell renders a `<Link href="/profile/<addr>">` to a truncated address (use the existing `OwnerLink` helper added in the 2026-05-24 batch — see `app/moment/[id]/page.tsx` line ~569 — and lift it into `lib/owner-link.tsx` if needed so it can be shared).

d) Resolve canonical owner. Call `resolve_canonical_owner(addr)` (RPC exists) so child accounts under a HybridCustody parent collapse to the parent. Cache the resolved name client-side in a `Map<addr, displayName>` to avoid N+1.

e) Display ordering: BUYER on the left, SELLER on the right. Sales table columns become: SERIAL · PRICE · WHEN · BUYER · SELLER. Drop the MARKETPLACE column entirely for the live UI (keep it in the underlying RPC for power-users; can be revealed under a "More" toggle later).

f) When `buyer_address` or `seller_address` is NULL (some V1 Dapper price-uncertain sales currently land without one), render "—" rather than blank.

### 3.2 Add the high offer ("Top Shot Best Offer")

Data is sitting in `marketplace_offers` (partitioned monthly, populated, has `offer_price`, `offer_state`, `offeror_address`) and `badge_editions.highest_offer` (already aggregated for TS).

**Steps**:

a) Add a new RPC `get_edition_high_offer(p_edition_id uuid) RETURNS TABLE(offer_price numeric, offeror_address text, offered_at timestamptz)`:

```sql
CREATE OR REPLACE FUNCTION public.get_edition_high_offer(p_edition_id uuid)
RETURNS TABLE(offer_price numeric, offeror_address text, offered_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT offer_price, offeror_address, created_at
  FROM marketplace_offers
  WHERE edition_id = p_edition_id
    AND offer_state IN ('open','active','live')
    AND (expires_at IS NULL OR expires_at > now())
  ORDER BY offer_price DESC NULLS LAST
  LIMIT 1
$$;
REVOKE ALL ON FUNCTION public.get_edition_high_offer(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_edition_high_offer(uuid) TO postgres, service_role;
```

Verify the column names against `marketplace_offers` before applying — the audit captured `offer_price`, `offer_state`, `offeror_address` but the offer-state vocabulary and expiry column name need a quick `\d marketplace_offers`.

b) Add a "TOP SHOT BEST OFFER" stat cell next to "TOP SHOT ASK" in both `app/moment/[id]/page.tsx` (~line 530-545) and `app/(collections)/[collection]/edition/[slug]/page.tsx` (~line 308-314).

c) When the offer is non-null, render `$X · by <truncated offeror_address linked to profile>`. When null, render "—".

d) For per-NFT pages, also surface "Best offer **on this serial**" if the underlying `marketplace_offers` row points to the specific `nft_id` rather than the edition (check the schema — if `marketplace_offers` has `nft_id text`, support both views).

### 3.3 Add badges row

Badge data flows via `get_edition_badges_unified(p_edition_id)` per the 2026-05-24 audit. The edition page renders `detail.badges` array (line 300-306). The standalone moment page does not.

**Steps**:

a) `app/moment/[id]/page.tsx` — after the FMV pill area, add a `<BadgesRow badges={detail.badges} />` component.

b) Component: render each badge as a small token-styled pill using `var(--rpc-red)` for "core" badges (`topshotdebut`, `rookieyear`, `championshipyear`, `mvpyear`, `allstar`, `rookiepremiere`, `rookiemint`, `rookieoftheyear`, `threestarrookie`) and a muted border for set-tag badges. The 2026-05-24 batch already restricted the unified-badges play_tag allowlist to those 9 — reuse the constant.

c) For per-serial badges (special_serial_holders) that match THIS NFT's serial, render a separate inline row: "#1 SERIAL · JERSEY MATCH · PERFECT MINT" etc. as red pills.

### 3.4 Parallels & special serials

**Parallels definition for NBA Top Shot**: two editions share the SAME `(player_id, play_id_onchain)` but different `set_id_onchain`. The DB confirms parallels exist (e.g. Avdija Fresh Threads has play_id_onchain=5766; Hoop Vision is a separate set with a different play_id but the same game footage).

Note: Top Shot's product semantics for "parallel" actually means "different sets featuring the SAME on-chain play_id" (Base Set + Fresh Threads + Metallic Gold LE all reuse the same play_id_onchain for the same clip). For other collections (AllDay/Golazos/UFC) the schema differs — punt parallels to a follow-up for those.

**Steps**:

a) Add RPC `get_edition_parallels(p_edition_id uuid) RETURNS SETOF editions`:

```sql
CREATE OR REPLACE FUNCTION public.get_edition_parallels(p_edition_id uuid)
RETURNS TABLE(
  id uuid, external_id varchar, set_name varchar, tier text, series smallint,
  circulation_count int, thumbnail_url text, set_id_onchain int
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH src AS (
    SELECT collection_id, player_id, play_id_onchain
    FROM editions WHERE id = p_edition_id AND play_id_onchain IS NOT NULL
  )
  SELECT e.id, e.external_id, e.set_name, e.tier::text, e.series,
         e.circulation_count, e.thumbnail_url, e.set_id_onchain
  FROM editions e JOIN src s
    ON e.collection_id = s.collection_id
   AND e.player_id = s.player_id
   AND e.play_id_onchain = s.play_id_onchain
   AND e.id <> p_edition_id
   AND e.external_id ~ '^[0-9]+:[0-9]+$' -- canonical integer-keyed only (post-merge)
  ORDER BY e.set_id_onchain
$$;
REVOKE ALL ON FUNCTION public.get_edition_parallels(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_edition_parallels(uuid) TO postgres, service_role;
```

b) Render a "PARALLELS" section on the moment + edition page directly above "SIMILAR EDITIONS". The "Similar Editions" section currently mixes parallels (same play, different set) with same-player-different-play moments — this clarifies the distinction.

c) Each parallel renders the same edition-card component used in "Similar Editions" but tinted with a subtle `var(--rpc-red)` border to differentiate.

**Special-serial detection** (already mostly built, just surface on per-NFT page):

a) The moment page (`app/moment/[id]/page.tsx`) currently only checks `serial === 1` inline (line 537-554). Replace with a direct query against `special_serial_holders WHERE nft_id = <this nft_id>` and render every matching badge_type (`first_serial`, `jersey_match`, `perfect_mint`, `last_serial`, `birthdate_serial`).

b) The edition page (`app/(collections)/[collection]/edition/[slug]/page.tsx`) already does this at line 169-180 and 400-423 — leave it alone, it's the reference impl.

### 3.5 Info-bar correctness (Mint Count, Team)

User reported the bottom info-bar feels inaccurate. With editions merged (§2 above), Team will be correct. Two additional fixes:

a) **Move the info bar into the body**, not the footer. The 6-cell strip (MINT COUNT · TIER · SERIES · TEAM · PLAY TYPE · GAME DATE) belongs next to the FMV pills (right column on desktop, below the video on mobile). Put it between the FMV stat cells and the "Recent Activity" block in both:
   - `app/moment/[id]/page.tsx` (~line 709-714 currently — relocate it to ~line 540 area, just below FMV cells)
   - `app/(collections)/[collection]/edition/[slug]/page.tsx` (mirror the structure)

b) **Mint Count source**: `editions.circulation_count` is the on-chain mint cap. For per-NFT views, ALSO display "Serial X / Y" where Y is `circulation_count`. The current moment page omits the cap.

c) **Series**: keep the `SERIES_DISPLAY` mapping (CLAUDE.md series map: 0=S1, 2=S2, 3=Sum21, 4=S3, 5=S4, 6=23-24, 7=24-25, 8=25-26). Don't show raw integer.

d) **Team**: render as a link to `/<collection-slug>/team/<team_slug>`. The `team` route already exists per the player/series/set audit.

e) **Play type**: when `play_type` is NULL or "Unknown", render "—" rather than the literal "Unknown".

### Acceptance for §3

- Moment page renders: Buyer/Seller columns (with profile links), Best Offer cell, Badges row, Parallels section, Special-serial pills (when applicable), info bar in body with corrected Team.
- Edition page renders: same except per-serial Special-serial row replaced with the existing per-edition special-serials grid.

---

## 4. Restore Sniper + Market feeds for Top Shot and NFL All Day

### Status today (verified live)

`cached_listings_v2` (the underlying feed table) IS being populated, by current pipelines that are all green:

| collection | source | total rows | open listings | fresh 1h | fresh 6h | latest ingest |
|---|---|---|---|---|---|---|
| disney_pinnacle | direct | 7,859 | 2,940 | 72 | 208 | 02:40:07 |
| laliga_golazos | direct_v2 | 10 | 10 | 0 | 1 | 23:52 (prior day) |
| nfl_all_day | direct | 34,661 | 8,083 | 4 | 35 | 02:53:05 |
| nfl_all_day | direct_v1 | 6,656 | 0 | 21 | 170 | 03:00:42 |
| nfl_all_day | flowty | 1,431 | 0 | 0 | 0 | 2026-05-24 (frozen) |

**Top Shot is missing from `cached_listings_v2`** despite the `topshot-listings-indexer` pipeline showing green runs at 03:02. Investigate: either it's writing to a different table or it's filtering everything out. Find the route via `grep -r "topshot-listings-indexer" app/api`.

**Pipelines** in the last 6h, all GREEN:
- `topshot-listings-indexer`: 23/24 (1 transient pool timeout)
- `allday-listings-indexer`: 23/23
- `allday-listings-retry`: 24/25 (1 transient pool timeout)
- `topshot-listing-cache`, `topshot-listing-cache-v2`: 3/3 each
- `ts-listing-ingest`: 3/3

So the **data plane is live**. The **read plane (Sniper + Market) is broken** because:

Per CLAUDE.md May 23: "Sniper is Top Shot GQL only now; `marketplaceAvailability.flowty` hardcoded `false`. The `computeCachedSniperFeed` path (golazos/ufc) was deleted with it — it read the dead `cached_listings` table; those collections now return empty rather than serve frozen rows."

But the new table is `cached_listings_v2`, not the dead `cached_listings`. And `get_allday_sniper_deals` RPC EXISTS (6 args). So restoring is wiring a working table to a working RPC and exposing it.

### What to do

a) **Inventory** — read `app/api/sniper-feed/route.ts` and `app/(collections)/[collection]/market/page.tsx` (+ the corresponding API route) and inventory exactly what data each currently reads.

b) **Sniper-feed RPC for Top Shot** — write `get_topshot_sniper_deals` mirroring `get_allday_sniper_deals`. Inputs (suggested signature): `(p_min_discount_pct numeric, p_max_price numeric, p_min_confidence text, p_tier text, p_set_slug text, p_limit int)`. Implementation: read `cached_listings_v2` for `collection_id = TS_UUID AND completed_at IS NULL AND (expiry_at IS NULL OR expiry_at > now())`, JOIN against `editions` + most-recent `fmv_snapshots`, compute `discount_pct = 1 - (cl.price_usd / fmv.fmv_usd)`, filter by inputs, ORDER BY discount_pct DESC, LIMIT.

c) **Find where `cached_listings_v2` rows for `collection_id = TS_UUID` are coming from**. If `topshot-listings-indexer` is green but no rows exist in `cached_listings_v2` for TS, it's writing somewhere else. Probable targets: the legacy `cached_listings` table (now considered dead), or a TS-specific listing-cache table. Trace by reading the route handler and grepping for `cached_listings` (no v2 suffix). If it's writing to the v1 table, dual-write to v2 OR migrate the writer to v2.

d) **`/api/sniper-feed/route.ts`** — restore the multi-collection branch:
   - For `collection_slug='nba-top-shot'`: keep TS GQL leg + UNION with `get_topshot_sniper_deals` rows (new).
   - For `collection_slug='nfl-all-day'`: call `get_allday_sniper_deals` (existing RPC).
   - For `golazos`, `ufc-strike`, `disney-pinnacle`: equivalent RPCs or direct queries against `cached_listings_v2` JOINing edition FMV. Pinnacle uses `pinnacle_fmv_snapshots` separately.

e) **Market page** — `app/(collections)/[collection]/market/page.tsx` similarly. The May 23 reframe stripped the buy flow but kept the listing table. Restore the data feed using the same RPCs / table reads. CTA stays "View Listing →" outbound (don't reintroduce buy buttons — that path is intentionally shelved per memory `intelligence-first-decision.md`).

f) **Marketplace freshness pill** — add a small "Updated Xm ago" timestamp pulled from the freshest `ingested_at` per collection so users can see the feed is alive. Replace the dormancy red banner concept.

g) **For NFL All Day**, ensure the outbound URL on each listing card is the right thing. AllDay listings have `listing_resource_id` and `source` ('direct', 'direct_v1', 'flowty'). The correct outbound URL for an AllDay-direct listing is the moment page on nflallday.com: `https://nflallday.com/moments/<nft_id>`. Flowty rows should not be linked (they're frozen). V1 Dapper rows likely link to the same nflallday.com moment page.

### Acceptance for §4

- `/nba-top-shot/sniper` renders deals from both TS GQL + `cached_listings_v2` (deduped).
- `/nfl-all-day/sniper` renders deals from `cached_listings_v2` via `get_allday_sniper_deals` — at least 50 results visible.
- `/nba-top-shot/market` and `/nfl-all-day/market` render their respective feeds with "Updated Xm ago" pills.

---

## 5. Top Shot pack outbound URL fix

The user reported `https://nbatopshot.com/listings/p2p?packListingId=2d5b6510-f50a-40b2-9dcb-0c2a3ca9ce84` is broken. This URL pattern is the old peer-to-peer pack listing URL. TS rotates these UUIDs as pack listings sell out / get recycled.

### What to do

a) **Determine the canonical TS pack URL**. Likely candidates to test (server-fetch each via `mcp__workspace__web_fetch` to confirm a 200):
   - `https://nbatopshot.com/drop/<dist_id>` (works for primary drops)
   - `https://nbatopshot.com/packs/<dist_id>`
   - `https://nbatopshot.com/listings/p2p?distId=<dist_id>` (current URL pattern with dist_id instead of UUID)
   - `https://nbatopshot.com/pack/<pack_listing_uuid>` (singular, not plural)

b) **Pack-listing URL helper** — `lib/pack-urls.ts`:

```ts
export function topshotPackUrl({ distId, packListingUuid }: { distId: string; packListingUuid: string | null }): string {
  // Prefer dist-id-based URLs; fall back to UUID-based.
  // Validate each URL in the audit before shipping.
  return `https://nbatopshot.com/drop/${distId}`
}
```

c) Edit `app/(collections)/[collection]/pack/dist/[distId]/page.tsx` (~line 444) to call the helper:

```ts
const buyUrl = collection === "nba-top-shot" && !isRewardPack && priceSource !== "none"
  ? topshotPackUrl({ distId, packListingUuid })
  : null
```

d) Also update the simulator page and any other surface that constructs TS pack URLs.

### Acceptance

- Clicking "BUY ON TOP SHOT" on `/nba-top-shot/pack/dist/6739` opens a working Top Shot URL.

---

## 6. Player / Series / Set page polish

The aggregation pages are structurally fine (per the audit) — the gaps are smaller.

### What to do

a) **Add `loading.tsx` skeletons** to:
   - `app/(collections)/[collection]/player/[slug]/loading.tsx`
   - `app/(collections)/[collection]/team/[slug]/loading.tsx`

   Mirror the structure of `app/(collections)/[collection]/edition/[slug]/loading.tsx` (which exists). 4-section skeleton: hero + stat strip + grid + table.

b) **Tokenize the one Series page hardcoded font** at `app/(collections)/[collection]/series/[slug]/page.tsx:151` — change `fontFamily: "'Share Tech Mono', monospace"` to `fontFamily: "var(--font-mono)"`.

c) **Player page enhancement** — add a "Recent Sales (15)" table at the bottom of the player page using a new RPC `get_player_recent_sales(p_player_id uuid, p_limit int)`. Same structure as the moment-page sales table (with Buyer/Seller columns).

d) **Series page enhancement** — add a "TOP MOMENTS BY FMV" 25-card grid (currently the page jumps from stats to sets — needs the in-between).

e) **Set page enhancement** — add a "TOP MOMENTS BY FMV" grid like Series, and a "FLOOR LEADERS" mini-grid (cheapest live ask per edition in the set).

f) **Set page — fix the partial-page Tier Mix** (audit found it samples first 100 editions). Add an aggregate RPC `get_set_tier_mix(p_set_id uuid) RETURNS TABLE(tier text, n int)` and read from there.

### Acceptance

- All 5 page types (moment, edition, player, series, set) have loading.tsx skeletons.
- Player + Series + Set pages each have at least one drill-down element (recent sales, top moments, floor leaders).

---

## 7. Migrations checklist

The list of migrations to apply in order via `apply_migration`:

1. `audit_20260526_merge_topshot_uuid_keyed_edition_duplicates` (§2a-b)
2. `audit_20260526_editions_block_topshot_uuid_dupe_trigger` (§2d)
3. `audit_20260526_get_edition_high_offer_rpc` (§3.2a)
4. `audit_20260526_get_edition_parallels_rpc` (§3.4a)
5. `audit_20260526_get_topshot_sniper_deals_rpc` (§4b)
6. `audit_20260526_get_player_recent_sales_rpc` (§6c)
7. `audit_20260526_get_set_tier_mix_rpc` (§6f)

Pre-flight every migration with a `SELECT count(*)` before destructive work (per memory `verify-rowcount-before-destructive-db-ops.md`). Test each new RPC with a single-row probe before wiring the frontend.

---

## 8. Verification & smoke

After all of §1-§6 is shipped (in chunks — don't bundle):

a) **Pack page** — `curl -fI -H "Cookie: …" https://www.rippackscity.com/nba-top-shot/pack/dist/6739` should be 200. Visit it and confirm no client error.

b) **Avdija Fresh Threads** — visit the moment, confirm Team renders "Portland Trail Blazers".

c) **Sniper** — `/nba-top-shot/sniper` and `/nfl-all-day/sniper` each show ≥ 50 deal rows. `tsCount` log line in `/api/sniper-feed` log is > 0.

d) **Market** — `/nba-top-shot/market` and `/nfl-all-day/market` each show ≥ 50 listing rows.

e) **Moment page integration** — Buyer/Seller cells link to profile, Best Offer cell shows non-null value on any traded edition, Badges row renders for at least 9 known badges, Parallels section appears for Avdija Fresh Threads (parallels: Hoop Vision, Base Set, Metallic Gold LE etc).

f) **Editions duplicate scope** — `SELECT count(*) FROM editions WHERE collection_id='95f28a17-...'` is ~9,139 (down from 17,106).

g) **DB-side health check** — `health_check()` returns clean. `get_pipeline_alerts()` has no new alarms.

h) **No new RLS/SECDEF regressions** — `SELECT array_agg(tablename) FROM pg_tables WHERE schemaname='public' AND rowsecurity=false` still returns 0 rows.

---

## 9. Out of scope / explicit DON'Ts

- Do NOT reintroduce the in-app buy flow or the cart. Per memory `intelligence-first-decision.md`, RPC is committed intelligence-first.
- Do NOT mention or prioritize the Pro paywall / monetization (per memory `no-paywall-until-traction.md`).
- Do NOT reach out to Austin Kline / Flowty (per memory `no-austin-kline-outreach.md`).
- Do NOT add new GitHub Actions or cron entries without first checking they don't duplicate an existing 20-min pipeline.
- Do NOT branch off `main` (per CLAUDE.md). Commit and push directly to `main`.

---

## 10. Open questions / follow-ups (don't block on these)

- **AllDay parallels schema** — currently `editions.play_id_onchain` is TS-specific. For AllDay/Golazos/UFC, parallel detection needs a different join. Punt to a follow-up: write a per-collection parallel-detection function, surface only for TS in the first ship.
- **Pinnacle FMV is in `pinnacle_fmv_snapshots`** (UUID-keyed) — the `fmv_snapshots` table doesn't cover it. Make sure §3.2's high-offer RPC handles the Pinnacle path or punt to a Pinnacle-specific equivalent.
- **The 72 UUID-only TS editions** (no integer twin) — after the merge, decide whether to keep them (they have no Cadence sibling, may be orphans) or run the `ensure_topshot_edition_stub` self-heal on each.
- **`marketplace_offers` column verification** — confirm `offer_state` valid values and the existence of an `expires_at` column before shipping the high-offer RPC.

---

End of handoff. Commit messages should reference the audit doc path: `docs/handoff-2026-05-26-entity-pages-and-feeds.md`.
