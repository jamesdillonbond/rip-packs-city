# Handoff — Top Shot pack subpage: fix contradictory counts + no-pool degrade (2026-07-25)

## Context

Trevor flagged that the NBA Top Shot **pack subpages** (`/nba-top-shot/pack/dist/[distId]`) show wrong counts and missing images/names. Root-caused in a Cowork session; two of the fixes are frontend-only and need Claude Code (Cowork has no git creds).

**Already shipped live by Cowork this session (no CC action needed):**
- **`ingest-topshot-atlas-pool` redeployed → v6.** The *deployed* function was still v5 with the leaked key `<gate-key — now an edge secret, see D2>` hardcoded (the 2026-07-20 "M4" security fix existed in the repo at `supabase/functions/ingest-topshot-atlas-pool/index.ts` but was **never deployed**). v6 now reads `Deno.env.get("ATLAS_POOL_INGEST_KEY")` and **fails closed** if unset. Verified live: old key → `HTTP 401 unauthorized`; no key → `HTTP 401`. Deployed `verify_jwt=false` (custom key auth), so the MCP-deploy verify_jwt gotcha did not re-trip. **Repo already matches** the deployed v6 source — no commit needed for the edge fn.
- Deployed source is byte-identical to `supabase/functions/ingest-topshot-atlas-pool/index.ts` at HEAD. Revert (if ever needed): `supabase functions deploy ingest-topshot-atlas-pool` from that path.

**Current HEAD:** `b7e80ba0` on `main`.

**This handoff covers two frontend edits, both in one file:**
`app/(collections)/[collection]/pack/dist/[distId]/page.tsx` (verified present; 2,7xx lines).

> Claude Code's direct file inspection wins over this doc and over `project_knowledge_search` on any disagreement — adapt to the actual file shape.

---

## Item 1 — Reconcile the "Observed pack lifecycle" strip so it stops contradicting the real counts (HIGH — this is the "counts are off")

**File:** `app/(collections)/[collection]/pack/dist/[distId]/page.tsx`

**Root cause.** The page renders two different "opened" numbers from two different sources, and labels the small one as if it were complete:

- **Authoritative counts** (KPI row, ~lines 1505–1518): `Depletion` and `Packs remaining / of N minted` come from the supply counters (`pack_table_rows.total_minted/total_opened` + metadata). For **dist 1730 (Seeing Stars)** these are correct: **188,587 opened · 13,001 sealed · 94% depletion · 201,588 minted**.
- **Observed-lifecycle strip** (`StreamedTopGroup`, ~lines 2382–2467): `get_pack_lifecycle_row(distId)` returns only opens **attributed to this dist via the `pack_rips` bridge** — partial (~20% and growing), per the `rpc-data` note. For dist 1730 that RPC returns **`packs_opened: 28`, `packs_sealed_observed: 0`, `observed_depletion_pct: 100`**.
- The strip then labels the 28 as **"complete open history"** (line 2387, because `lcFullHistory` is true for `nba-top-shot`) and shows an **"Opened share 100% of observed packs"** cell. So a pack that is really 94% depleted with 188k opens shows "28 opened / 100%" right under the correct numbers. That is the "counts are off."

**Verified how:** `get_pack_lifecycle_row('1730')` via `execute_sql` returned the 28/0/100 row; `pack_table_rows` for dist 1730 returned 188,587 opened / 13,001 sealed / 94%.

**Fix (two small edits — keep the useful "realized pull value" cells, kill the misleading ones):**

**1a.** ~line 2386–2387. The Top Shot lifecycle count is the *attributed-rip sample*, not the complete open history. Relabel it as the sample it is (AllDay's `v_allday_pack_lifecycle` count is genuinely complete, so keep AllDay's label). Replace:

```tsx
  const lcFullHistory = collection === "nfl-all-day" || collection === "nba-top-shot"
  const lcSince = lcFullHistory ? "complete open history" : "observed since Apr 2026"
```

with:

```tsx
  // AllDay's v_allday_pack_lifecycle count is complete (on-chain open ingest).
  // Top Shot's get_pack_lifecycle_row counts only opens ATTRIBUTED to this dist via
  // the pack_rips bridge (partial: ~20% and growing) — NOT the complete open history,
  // which lives in the supply counters shown in the KPI row above (total_opened /
  // Depletion). Label the TS number as the sample it is so it never contradicts them.
  const lcSince = collection === "nfl-all-day" ? "complete open history" : "attributed rips · sample"
```

**1b.** The "Opened share" cell (~lines 2458–2464) is only meaningful when authoritative (AllDay). For Top Shot `lcDepletionAuthoritative` is `false`, so it renders "100% of observed packs" — the contradiction. Gate it on `lcDepletionAuthoritative`. Replace:

```tsx
            {lcDepletion != null && (
              <KpiCell
                label="Opened share"
                value={`${lcDepletion.toFixed(lcDepletion >= 10 ? 0 : 1)}%`}
                sub={lcDepletionAuthoritative ? "of all minted packs" : "of observed packs"}
              />
            )}
```

with:

```tsx
            {lcDepletion != null && lcDepletionAuthoritative && (
              <KpiCell
                label="Opened share"
                value={`${lcDepletion.toFixed(lcDepletion >= 10 ? 0 : 1)}%`}
                sub="of all minted packs"
              />
            )}
```

After this, a Top Shot pack shows: `Packs opened 28 · attributed rips · sample`, `Moments pulled 88`, `Realized pull value $22.91`, `Avg / pack $0.82` — all honest, no contradiction with the 94% Depletion above. AllDay is unchanged.

**Optional 1c.** The section header at ~line 2438 reads "Observed pack lifecycle". Consider "Observed rips (sample)" for Top Shot to reinforce it's a sample. Cosmetic; skip if you prefer minimal.

**Revert path:** `git revert <this commit>` — the two blocks are self-contained.

**Expected verification:** `npx tsc --noEmit` clean; Vercel deploy READY; load `/nba-top-shot/pack/dist/1730` and confirm the lifecycle strip no longer shows a "100%" opened share or a "complete open history" label, while `Depletion 94%` stays in the KPI row.

---

## Item 2 — No-pool packs: fix the empty-state copy (LOW/MED — optional composition)

**File:** `app/(collections)/[collection]/pack/dist/[distId]/page.tsx`

**Why.** 1,521 of 2,031 Top Shot dists have **no drop pool** (verified: `edition_count` is 0/null in `pack_table_rows`), so `get_pack_contents` returns `[]`, the "What's Inside" grid is hidden (line 2642 gate `packContents.length > 0`), the hero falls back to a letter tile, and "Top pulls by EV" shows the empty state at ~line 2678:

> "No drop-pool data indexed for this distribution yet. Check back after the next pack-EV cron tick."

That copy is misleading for this class — a cron tick will **not** fix them; they need the **Atlas real-remaining harvest** (see the separate Atlas runbook). The honest bulk fix is running that harvest, which repopulates real pools (→ art, names, EV). Until then:

**2a (safe, recommended).** Soften the empty-state copy at ~line 2678 so it doesn't promise a cron tick will fix it. Suggested:

> "Drop-pool contents aren't indexed for this distribution yet. Older/depleted packs are re-pooled from Dapper Atlas remaining-count data as that harvest runs."

**2b (optional, verify first).** You *could* surface raw pool composition from `pack_distributions.metadata.original_counts_by_tier` (already parsed as `originalByTier`, ~line 946) as **counts only** (e.g. "Originally ~1,448,144 common · 4,850 rare · 2,535 fandom · 324 legendary") on no-pool packs. **Caution:** the existing `TierOddsPanel` deliberately returns `null` when `!hasDropPool` (lines 1974–1978) because on some packs that metadata is pack-count-by-tier, not pool entries, so **odds/percentages would be fabricated**. If you add a composition block, show absolute counts only, never odds/percentages, and label it "original pool composition (counts)". Only worth it if you first confirm `original_counts_by_tier` is moment counts for the class you're rendering (for dist 3099 it is: common 1,448,144 ≈ 485,285 packs × 3 slots). If in doubt, ship 2a only.

**Revert path:** `git revert <this commit>`.

**Expected verification:** `npx tsc --noEmit` clean; Vercel READY; load a no-pool dist (e.g. `/nba-top-shot/pack/dist/3099` — Locker Pack R10) and confirm the empty state reads correctly and (if 2b shipped) shows counts without fabricated odds.

---

## Guardrails (repeat every handoff)

- **Direct-to-`main`, no branches, no PRs** (CLAUDE.md non-negotiable). If a `claude/*` branch is pre-checked-out, `git switch main` first.
- **Commit via PowerShell `git`** on Windows (Git Bash `git commit` can silently no-op). After push, re-verify: `git rev-list --count origin/main..HEAD` → expect `0`.
- `curl` fails silently in Git Bash for Vercel REST — use PowerShell `Invoke-WebRequest` if you check the deploy over the API.
- Vercel Pro `maxDuration` hard cap is **800s** — never set higher (silent ERROR).
- CRLF: don't string-replace-patch on Windows; use full-file writes or `findIndex` on split lines. Both edits above are small and location-anchored — apply by matching the surrounding lines.

## Expected end state

One commit on `main`, Vercel READY. Top Shot pack subpages no longer show a lifecycle strip that contradicts the headline counts (Item 1), and no-pool packs give an honest empty-state instead of promising a cron fix (Item 2). The bulk restoration of art/names/EV to ~225 no-pool packs comes from the **Atlas harvest restart** (separate runbook — operator step), not from this handoff.
