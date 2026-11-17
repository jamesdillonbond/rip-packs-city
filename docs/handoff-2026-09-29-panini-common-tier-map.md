# Handoff — Panini ingest tier-map is missing the `Common` rarity (edition_integrity trust breach)

**Date:** 2026-09-29 (~8:10 PM PT) · **Author:** daytime health monitor (Cowork cloud) · **HEAD at authoring:** `0f93b23eea786fda7878096583e50e77d6629e01`

## Context

Cowork (this session) has **already applied the data half live** — a targeted, reversible backfill that cleared the trust gate (details + revert below). This handoff covers only the **one-line code fix** that stops it recurring, which Cowork cannot push from this session. Nothing else is queued here.

- **Already shipped live by Cowork (data op, no migration):** `tier = 'COMMON'` backfilled onto the 301 affected rows in `panini_editions` and `editions`. `edition_integrity_flags` went 308 → **7** (status ok), 0 trust breaches, 0 Panini editions tier-null.
- **This handoff (code, needs your push):** add `Common` to the rarity→tier map so the next `Common`-rarity Panini batch maps correctly on ingest.

## What broke and why

`edition_integrity_flags` (in `v_rpc_trust_health`) breached at **308** (gate 250) — its first breach since the gate was fixed 2026-07-28. It decomposes exactly to `panini_blockchain.canonical_missing_tier = 301` + `nba_top_shot.canonical_missing_thumbnail = 7`. The 301 were **all created in the last ~24 h** (oldest 2026-09-29 09:54Z, newest 2026-09-30 02:54Z) by a Panini pack-card ingest batch — Base / Concourse / Premier-Level parallels, all `rarity_label = 'Common'`.

Root cause is one line in `lib/chains/panini/ingest-normalize.ts` (line 8):

```ts
const TIER: Record<string, string> = { Uncommon: "COMMON", Rare: "RARE", "Ultra Rare": "RARE", Epic: "LEGENDARY", Legendary: "ULTIMATE" };
```

`toEditionRow` sets `tier: TIER[c?.card_rarity ?? c?.rarity ?? ""] ?? null` (line 35). The map has **no `Common` key**, so every card whose `card_rarity` is the literal `"Common"` got `tier = null` in `panini_editions`, and `sync_panini_editions_to_shared` faithfully copied that null into `editions`. Verified against the catalog: the canonical mapping in-DB is `Epic→LEGENDARY, Legendary→ULTIMATE, Rare→RARE, Ultra Rare→RARE, Uncommon→COMMON` — `Common` never appears in the mapped set, and all 301 nulls carry `rarity_label='Common'`.

`Common → COMMON` is unambiguous: the map already sends Panini's `Uncommon` → `COMMON`, and `editions` with `set_name='Base'` are 168:1 `COMMON`. Panini uses no `UNCOMMON` tier at all.

## Item 1 — add `Common: "COMMON"` to the TIER map  (file verified to exist)

**File:** `lib/chains/panini/ingest-normalize.ts` — line 8.

**Change:** add one key at the front of the map object:

```ts
const TIER: Record<string, string> = { Common: "COMMON", Uncommon: "COMMON", Rare: "RARE", "Ultra Rare": "RARE", Epic: "LEGENDARY", Legendary: "ULTIMATE" };
```

Nothing else in the function changes. (This is a full description of the exact edit location, per surrounding lines, rather than a whole-file paste — the file is 226 lines and only line 8 changes.)

**Test:** `__tests__/panini-ingest-normalize.test.ts` exists — add a case asserting `toEditionRow({ card_rarity: 'Common', … }).tier === 'COMMON'`; the current map fails it (returns `null`). A companion assertion that an unknown label still yields `null` keeps the fallback honest.

**Optional (not required to close this):** the six observed Panini rarity labels are now all mapped, but an unknown future label would silently repeat this. Consider logging (not throwing) when `card_rarity` is non-empty and unmapped, so the next new label surfaces in `pipeline_runs.extra` instead of only in the trust gate days later. Your call — the minimal fix above is sufficient.

**Verify:** `npx tsc --noEmit` clean; the two panini test files green; the Vercel deploy reaches READY. No runtime smoke needed (the ingest cron will simply stamp tiers on the next `Common` batch).

**Revert:** `git revert` the commit titled "panini: map the Common rarity to the COMMON tier".

## The data op Cowork already applied (record in the ledger; revert if ever needed)

Applied live via `execute_sql` under Trevor's explicit direction this evening ("address all you can" → chose backfill-now):

```sql
-- catalog
UPDATE public.panini_editions SET tier = 'COMMON'
WHERE tier IS NULL AND rarity_label = 'Common';                 -- 301 rows
-- shared editions
UPDATE public.editions e SET tier = 'COMMON'
FROM public.collections c, public.panini_editions pe
WHERE c.id = e.collection_id AND c.slug = 'panini_blockchain'
  AND e.tier IS NULL AND pe.external_id = e.external_id AND pe.rarity_label = 'Common';  -- 301 rows
```

Post-state verified: `edition_integrity_flags` 7 / ok, `panini_editions` tier-null 0, `editions` panini tier-null 0, total trust breaches 0.

**Revert (only if the Common→COMMON mapping is ever judged wrong — it isn't):** set those exact rows back to NULL —
`UPDATE public.editions e SET tier=NULL FROM public.collections c, public.panini_editions pe WHERE c.id=e.collection_id AND c.slug='panini_blockchain' AND pe.external_id=e.external_id AND pe.rarity_label='Common' AND e.tier='COMMON';` and the matching `panini_editions` update. Not a migration (data only), so no sha/pin.

**Ledger:** please add an `OPERATED (data)` + code-fix entry so the record is complete; the daytime monitor does not write the ledger itself.

## Guardrails

- Direct to `main`, no branches, no PRs. If a `claude/*` branch is checked out, switch to `main` first.
- Commit via PowerShell `git` on Windows (Git Bash `git commit` can silently no-op). Re-verify with `git rev-list --count origin/main..HEAD` (expect 0 after push).
- **This no-push note is specific to this cloud monitor session.** Trevor's machine and Claude Code push normally via Git Credential Manager / `gh auth setup-git` — commit this file as usual. ⛔ Do NOT use any PAT in `remote.origin.pushurl`; that route is dead (burned + removed 2026-08-16).
- Claude Code's direct file inspection wins over this doc and over `project_knowledge_search` on any disagreement — adapt to the actual file shape.

## Expected end state

One commit on `main` ("panini: map the Common rarity to the COMMON tier") + one test, deploy READY, `npx tsc --noEmit` clean. The data is already correct in production; this commit keeps it correct as new `Common`-rarity Panini cards ingest, so `edition_integrity_flags` stays at its ~7 baseline instead of re-climbing.
