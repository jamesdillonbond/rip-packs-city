# Handoff — Pack Sniper polish + the TS recency clamp bug (2026-06-21, round 2)

## Context

Round 1 (`0f19da4`) shipped the Pack Sniper live "as they get listed" feed + Sniper controls, and the `snapshot-pack-asks` cron is now **wired and firing** (cron-job.org job `7878615`, every 5 min; first tick green, `pack_ask_state` seeded 2,882 rows). I then QA'd the live surface in Chrome and found two real bugs + a few worthwhile improvements. This handoff is the follow-up.

**Already shipped LIVE by Cowork (DB):** migration `audit_20260621_get_pack_ask_state_map_rpc` — new function `public.get_pack_ask_state_map(p_collection_slug text) RETURNS jsonb` (SECURITY INVOKER, granted anon/authenticated/service_role). Returns the whole `is_listed` recency state for a collection as ONE jsonb row keyed by `dist_id`. Verified live: returns the full **1,903**-key TS map (and 979 AllDay), `check_public_security_invariants()` = 0, `check_secdef_anon_execute_violations()` = `[]`. This exists so Item 1 below is a clean, clamp-proof reader swap.

**This handoff covers code only** (route/.tsx — Cowork can't push). Priority order: 2 bugs first, then 3 cheap improvements, then optional polish, then 2 proposed-but-not-built items.

> **Claude Code's direct file inspection wins over this doc on any disagreement — adapt to the actual file shape.** All file paths verified live 2026-06-21.

---

## Guardrails (repeat every handoff)

- **Direct-to-`main`. No branches, no PRs.** If a `claude/*` branch is pre-checked-out, `git switch main` first.
- Commit via **PowerShell `git`**; re-verify `git rev-list --count origin/main..HEAD` → `0`.
- `npx tsc --noEmit` clean; Vercel deploy READY; smoke `/api/public/insights/pack-sniper` + `/insights/pack-sniper` + `/api/og/insights/pack-sniper` (all 200).
- CRLF: full-file writes, not string-replace patches.

---

## Item 1 — [BUG, HIGH] TS recency only joined on ~24 of 140 deals (PostgREST 1000-row clamp)

**Root cause (measured live).** `lib/packs/pack-deals.ts` reads recency with `(supabaseAdmin).from("pack_ask_state")…limit(5000)`. PostgREST **clamps any select to 1000 rows** ([[postgrest-limit-clamp-false-positive]]). Top Shot has **1,903** `is_listed` dists, so ~900 never came back and the `askByDist` map missed them → only **24 of 140** TS deals showed `isNew`/`askChangedAt` (the missing dists are genuinely in `pack_ask_state`, confirmed by direct query). AllDay (979 < 1000) was unaffected — **16/16** showed recency, which is what isolated the cause. The sibling `pack_table_rows` EV query is **not** affected (gated rows: TS 526, AllDay 295, both < 1000).

**Fix.** Swap the clamped table read for the already-shipped one-row RPC `get_pack_ask_state_map`, and build the map from the returned jsonb object. Two edits in `lib/packs/pack-deals.ts`:

**(a)** In the `Promise.all`, replace the third element (the `pack_ask_state` `.from(...).limit(5000)` block) with the RPC call:

```ts
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabaseAdmin as any).rpc("get_pack_ask_state_map", { p_collection_slug: collection }),
```

So the array reads:
```ts
  const [{ listings }, evRes, askRes] = await Promise.all([
    fetchLivePackListings(collection),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabaseAdmin as any)
      .from("pack_table_rows")
      .select(
        "dist_id, gross_ev, fmv_coverage_pct, ev_snapshotted_at, is_rare_single_pack, depletion_pct, edition_count, slots",
      )
      .eq("collection_slug", collection)
      .not("gross_ev", "is", null)
      .gte("fmv_coverage_pct", MIN_FMV_COVERAGE)
      .eq("is_rare_single_pack", false)
      .gte("ev_snapshotted_at", evCutoff)
      .lt("depletion_pct", MAX_DEPLETION_PCT)
      .limit(2000),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabaseAdmin as any).rpc("get_pack_ask_state_map", { p_collection_slug: collection }),
  ])
```

**(b)** Replace the `askByDist` builder (the loop over `askRes.data` rows) with a build from the jsonb object. The RPC returns `{ "<distId>": { lowest_ask, prev_ask, ask_first_seen_at, ask_changed_at }, … }`:

```ts
  // Recency overlay is non-fatal — a read error just means no NEW/▼ flags today.
  // askRes.data is a clamp-proof jsonb object keyed by dist_id (one row, from
  // get_pack_ask_state_map — replaces the PostgREST-1000-clamped table read).
  const askByDist = new Map<string, AskStateRow>()
  if (!askRes?.error && askRes?.data && typeof askRes.data === "object") {
    for (const [distId, v] of Object.entries(
      askRes.data as Record<string, Omit<AskStateRow, "dist_id">>,
    )) {
      askByDist.set(String(distId), { dist_id: String(distId), ...(v as Omit<AskStateRow, "dist_id">) })
    }
  }
```

Everything downstream (`askByDist.get(String(lst.distId))`, the `isNew`/`isPriceDrop`/`askDropPct` computation, the recency sort) is unchanged.

**Verify:** `curl -s 'https://www.rippackscity.com/api/public/insights/pack-sniper?collection=nba-top-shot&limit=200' | python -c "import sys,json;d=json.load(sys.stdin)['deals'];print(len(d), sum(1 for x in d if x.get('askChangedAt')))"` → the second number should ≈ the first (most TS deals now carry recency), not ~24/140. AllDay already 16/16.

**Revert:** restore the `.from("pack_ask_state")…limit(5000)` block + the row-loop builder (the round-1 code). The RPC can stay (inert).

---

## Item 2 — [BUG, MED] Hydration mismatch (React #418) from the timezone-dependent "Updated" label

**Root cause (live console).** `/insights/pack-sniper` throws `Minified React error #418` (text content did not match server HTML). It's the `updatedLabel` in `app/insights/pack-sniper/PackSniperClient.tsx`:

```ts
const updatedLabel = fetchedAt
  ? new Date(fetchedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })
  : "—"
```

`toLocaleString` renders in the runtime timezone — **UTC on the Vercel server, local on the client** — so the SSR text ("11:43 PM") ≠ the hydrated text ("4:43 PM") → mismatch. (Pre-existing from round 1; it's rendered in both the locked and standalone hero.) The file already has a `mounted` flag (added for the relative-time labels); reuse it.

**Fix.** Gate `updatedLabel` on `mounted` so the server and first client render agree on `"—"`, then the real timestamp paints after mount:

```ts
const updatedLabel =
  mounted && fetchedAt
    ? new Date(fetchedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })
    : "—"
```

**Verify:** reload `/insights/pack-sniper`, console has no `#418`. The "Updated …" line shows "—" for one frame then the local time.

**Revert:** drop the `mounted &&`.

---

## Item 3 — [UX, MED] Deal table overflows below ~1180px; the "View Listing" CTA scrolls off-screen

**Observed (screenshot, 998px viewport).** The 7-column table exceeds its `max-width:1180px` wrap and `overflow-x:auto` kicks in, so on any < ~1180px viewport (small laptops, tablets, phones) the **Actions** column — including the primary `View Listing ↗` CTA — is off-screen until the user horizontal-scrolls. The CTA is the conversion action; it shouldn't require scrolling.

**Fix (cheap, recommended): hide the two least-critical columns on narrow screens** so Pack / Tier / Live ask / EV÷ask / Actions fit. In `PackSniperClient.tsx`, add a class to the **Gross EV** and **FMV cov.** header cells and their body cells, and a media query.

- Header: add `rpc-ps-col-optional` to the `<th>` for "Gross EV" and "FMV cov.".
- Body: add `rpc-ps-col-optional` to the matching `<td>`s (the `{fmtUsd(d.grossEV)}` cell and the `{d.fmvCoveragePct}%` cell).
- CSS (append to the `CSS` template, inside the existing `@media (max-width: 760px)` block or a new `@media (max-width: 900px)`):

```css
@media (max-width: 900px) {
  .rpc-ps-col-optional { display: none; }
}
```

That keeps the EV÷ask ratio (the headline signal) + the CTA visible without scrolling. Gross EV / FMV-coverage remain on desktop and in the methodology.

**Optional richer alternative (bigger lift, nicer result):** under ~760px, render `processed` as stacked cards (thumbnail + title + badges, a 2×2 stat grid of Ask / EV÷ask / Gross EV / FMV, then the action links) instead of the table — matching the regular Sniper's mobile card pattern. If you do this, gate on a `matchMedia("(max-width: 760px)")` state and branch the render. The column-hide above is the 80/20; do the cards only if mobile is a priority.

**Revert:** remove the class + media query (and the card branch if added).

---

## Item 4 — [PARITY, LOW] Pack-name search box

The regular Sniper has search; the Pack Sniper doesn't, and with 50–140 deals it's useful. Pure client filter (no refetch).

- Add state near the other control state: `const [search, setSearch] = useState("")`
- Add an input to the controls `<section className="rpc-ps-controls">` (e.g. before the refresh control), styled with the existing `rpc-ps-field` / `rpc-ps-input`:

```tsx
        <label className="rpc-ps-field">
          <span className="rpc-ps-field-label">Search</span>
          <input
            className="rpc-ps-input rpc-ps-input-search"
            type="search"
            inputMode="search"
            placeholder="pack name…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
```

- In the `processed` `useMemo`, add a filter (and add `search` to the dep array):

```ts
    if (search.trim()) {
      const s = search.trim().toLowerCase()
      rows = rows.filter((d) => (d.title || "").toLowerCase().includes(s))
    }
```

- CSS: `.rpc-ps-input-search { width: 150px; }` (append near `.rpc-ps-input`).

**Revert:** remove the state, input, filter line, CSS.

---

## Item 5 — [FEATURE, LOW/MED] "Just listed / price drops only" quick filter

Leans directly into the new recency feed — a one-click way to see only packs that just hit the market or dropped. Cheap client filter.

- Add state: `const [recentOnly, setRecentOnly] = useState(false)`
- Add a toggle to the controls (next to the high-variance toggle), styled with `rpc-ps-toggle`:

```tsx
        <label className="rpc-ps-toggle">
          <input
            type="checkbox"
            checked={recentOnly}
            onChange={(e) => setRecentOnly(e.target.checked)}
          />
          <span>Just listed / price drops only</span>
        </label>
```

- In `processed` (add `recentOnly` to deps):

```ts
    if (recentOnly) rows = rows.filter((d) => d.isNew || d.isPriceDrop)
```

Note: on cold start (first ~2h after the cron's first run) nearly everything is `isNew`, so this filter is a near-no-op until the baseline settles — expected.

**Revert:** remove the state, toggle, filter line.

---

## Item 6 — [POLISH, OPTIONAL] Thumbnail hover preview

The regular Sniper shows an enlarged thumbnail on hover (`SniperThumbnailPreview` in `app/(collections)/[collection]/sniper/page.tsx`). Nice-to-have parity for the Pack cell image. Only worth it if Items 1–5 are in and you want polish — skip otherwise.

---

## Proposed (NOT built — your call before any work)

- **24h / 7d low-ask trend.** A "this pack is at/near its 24h low" signal would be a real intelligence edge, but it needs ask **history** (a `pack_ask_history` table the cron appends to, or a capped per-row JSONB sample buffer). At 2,882 dists × 288 ticks/day a naive history table is ~830k rows/day → needs retention pruning and is non-trivial DB-size cost (the cost-flat constraint, [[cost-flat-infra-constraint]]). Worth doing, but as its own scoped task with a retention plan — flagging, not building.
- **Pack deal alerts.** Hook the Pack Sniper into the existing omni-channel alerts system (`/alerts`, `dispatch_due_deal_alerts`) so a user can subscribe to "alert me when a sealed pack lists below X% of EV." The deal-board plumbing exists; this is a real feature, not a quick edit.

---

## Expected end state

One commit on `main`, deploy READY, `tsc` clean. TS recency now covers ~all deals (not 24/140); no `#418` in the console; the `View Listing` CTA is reachable on sub-1180px screens; search + "just listed only" filter present. The two proposed items are logged for a later decision.

### Full revert
`git revert <commit>` reverts Items 1–6. The `get_pack_ask_state_map` RPC can stay (inert) or `DROP FUNCTION public.get_pack_ask_state_map(text);` if fully abandoning.
