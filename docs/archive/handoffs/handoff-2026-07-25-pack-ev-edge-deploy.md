# Handoff — pack-EV edge functions: repo↔prod drift reconciled, now safe to deploy (2026-07-25)

**Status: repo-side reconciliation SHIPPED to `main`. Nothing was deployed.** Four edge functions are
waiting on an operator deploy; three of them are the pack-EV writers below, the fourth is a separate
mojibake fix bundled here because it shares the same deploy step.

Written 2026-07-25 ~01:10 PT.

---

## 1. The drift that existed (and why CI could not see it)

`pack_ev_history.typical_ev` is the **"Typical Pull EV"** — slots × the supply-weighted *median*
edition FMV — shipped 2026-07-16 and live on the pack page and the `/packs` board via
`mv_pack_ev_latest` → `pack_table_rows`. It is the honest counterweight to `gross_ev` ("Actual EV",
the weighted *mean*, which grails drag upward).

On **2026-07-18** the AllDay / Golazos / Pinnacle writers were updated to persist `typical_ev` and
deployed **via the Supabase MCP** — which does not touch git. The repo copies stayed on the older
bodies. Then on **2026-07-20**, commit `fb7eb0f2` refactored *those older bodies* onto the new
`supabase/functions/_shared/pack-ev-supply-weighted.ts` module.

Net effect: the repo was **simultaneously ahead of production** (shared module) **and behind it**
(no `typical_ev`). Deploying the repo copy would have been a *silent regression* — the deploy would
succeed, the pipeline would keep running `ok=true`, and `typical_ev` would just start writing NULL,
blanking a shipped display.

**Why CI stayed green:** `__tests__/edge-pack-ev-supply-weighted.test.ts` compared the edge functions
against `_shared` — i.e. **repo↔repo**. Nothing in CI has ever compared repo↔deployed, and no test
asserted an absolute property of the INSERT payload. A repo-only refactor that dropped a field was
invisible by construction.

### Verified drift table (deployed source read via `mcp__Supabase__get_edge_function`, 2026-07-25)

| function | deployed (Supabase `version` / internal) | repo before | what differed | correct side |
|---|---|---|---|---|
| `compute-allday-pack-ev` | **29** / `v9` | `v8` | deployed persists `typical_ev` (off RPC `typical_pull_ev`) + `function_version: 9`; repo had **zero** occurrences of `typical_ev` but DID have the `_shared` import | **both** — deployed for the field, repo for the architecture |
| `compute-golazos-pack-ev` | **6** / `v2` | `v1` | same class: deployed persists `typical_ev` + `function_version: 2`; repo had the `_shared` import and no `typical_ev` | **both** |
| `compute-pinnacle-pack-ev` | **8** / `v2` | `v1` | same class, plus deployed carries an INLINE `weightedMedianFmv()` (Pinnacle computes EV without the RPC); repo had the `_shared` `weightedMeanEv` import and no median at all | **both** |
| `compute-topshot-pack-ev` | **43** / `v23` | `v23` | **byte-identical** (md5 `5133101c08413e80a1b53662a870d6ca`, 1,569 lines both sides). Already persists `typical_ev` at line 1440. Was **not** part of the `_shared` rewire, so it has no relative imports — consistent on both sides. | n/a — no drift |

There is no `topshot-atlas-pack-ev` function; the Atlas surface is `ingest-topshot-atlas-pool`
(untouched here) plus the `refresh_atlas_pack_ev()` pg_cron job.

---

## 2. What was reconciled (repo only — no math changed)

Treated **deployed as the behavioural source of truth**. No weighting, threshold, clamp, or rounding
was altered. The canonical median semantics were independently confirmed against the live SQL
`compute_pack_ev_per_edition_weighted`:

```
med AS (SELECT min(fmv_usd) FROM cum WHERE cw >= 0.5 * tw)
v_typical_pull_ev := round(COALESCE(v_typical_per_slot,0) * GREATEST(p_slots,1), 2);
v_typical_pull_ev := GREATEST(LEAST(v_typical_pull_ev, 1000000), 0);
```

- **`supabase/functions/_shared/pack-ev-supply-weighted.ts`** — added exported `weightedMedianFmv()`
  (ported verbatim from the deployed Pinnacle body; same semantics as the SQL above) and added
  `typicalEv` to `WeightedEvResult`, computed inside `weightedMeanEv()` from the same
  `(fmv, weight)` pairs it already walks, with the RPC's `[0, 1e6]` clamp.
- **`compute-allday-pack-ev`** → `v9`. Added `typical_ev: ev.typical_pull_ev != null ? Number(...) : null`
  to the `pack_ev_history` row; `function_version` 8 → 9 (all 5 sites).
- **`compute-golazos-pack-ev`** → `v2`. Same one-field addition; `function_version` 1 → 2.
- **`compute-pinnacle-pack-ev`** → `v2`. Added `typical_ev: ev.typicalEv`, now sourced from
  `_shared` rather than an inline copy; `function_version` 1 → 2.
- **`compute-topshot-pack-ev`** — untouched (no drift).

**The repo is now a behavioural superset of production and cannot regress it on deploy:** every
field production writes, the repo writes, with the same arithmetic — the only difference is where the
median lives (shared module vs inline).

### The new guard (this is the part that stops a recurrence)

`__tests__/edge-pack-ev-supply-weighted.test.ts` gained:

- **`describe("every pack-EV writer persists typical_ev")`** — **directory-driven** (globs
  `supabase/functions/compute-*-pack-ev`, so a future collection's writer is covered the moment it
  exists), asserting for each writer that `typical_ev:` appears as a real object key in the INSERT
  payload (comment lines excluded) **and** that it is fed from `typical_pull_ev` / `typicalEv` /
  `typicalPerSlot` rather than hardcoded null — plus that `gross_ev` and `pack_ev` are still written.
  A "guard is not silently empty" test pins the four known writers so an rename can't hollow it out.
- 12 new unit tests for `weightedMedianFmv` + `typicalEv` (weight-median vs unweighted middle, the
  grail-shape mean/median divergence, the `>= 0.5·tw` inclusive boundary, slots multiplier, 2dp
  rounding, the `1e6` clamp, null-FMV exclusion, and `typicalEv === null ⟺ ok === false`).

**Proven to bite:** deleting the `typical_ev` line from `compute-golazos-pack-ev` reddens
`compute-golazos-pack-ev writes typical_ev into its pack_ev_history row`. Verified, then restored.

---

## 3. Bundled fix — the mojibake WRITER (`atob` is latin1-only)

The DB damage was already repaired on 2026-07-25 (`audit_20260725_pack_dist_mojibake_repair_v2` +
`_pack_dist_metadata_mojibake_latin1_class`, 216 rows). **The writer was not fixed** — that needed a
repo push. It is fixed now:

- **`seed-allday-pack-distributions/index.ts`** — `JSON.parse(atob(...))` → `JSON.parse(b64ToUtf8(...))`.
  This is the **single** decode site and both `title` and `metadata` derive from it, so one change
  covers both corrupted columns. This one function seeds **both Golazos and All Day** via
  `?collection=`, which is exactly why Top Shot and Pinnacle have zero corrupt rows.
- Pattern ported from the existing `scan-pinnacle-wallet/index.ts:24-30` (`atob` → `Uint8Array` →
  `TextDecoder("utf-8")`). Not invented.

**Full `atob` audit — all 20 call sites under `supabase/functions/` were read.** Verdict:
**2 more NEEDS-FIX, 16 SAFE.** Both were fixed in this push:

- **`topshot-stub-resolver/index.ts`** (highest impact) — decodes `TopShot.getPlayMetaData` /
  `getSetSeries` and writes `p_player_name` / `p_set_name` / `p_team` via
  `upsert_topshot_edition_metadata`. **846 Top Shot editions already carry non-ASCII in
  `player_name`/`set_name`** (Dončić / Jokić / Şengün class), so this writes straight into a column
  where non-ASCII is routine. Added a `b64ToUtf8` decode helper next to the pre-existing (encode-only)
  `b64Utf8`.
- **`enrich-ufc-wallet/index.ts`** — decodes the UFC `Display`/`Editions` view and writes
  `wallet_moments_cache.player_name` from the on-chain fighter name.

Both are **prospective** damage, not already-done: no `Ã`-class mojibake exists in `editions` or
`wmc` today. The fix is a **no-op for pure-ASCII payloads**, so it cannot change any currently-correct row.

**SAFE (16) — decode only ASCII identifiers, or persist nothing.** `_shared/hybrid-custody-parse.ts`,
`_shared/pinnacle-mint-parse.ts`, `backfill-allday-listing-serials`,
`backfill-topshot-base-parallel-probe`, `backfill-topshot-subeditions`, `hybrid-custody-backfill`,
`hybrid-custody-events`, `ingest-allday-pack-opens`, `ingest-pinnacle-mints`,
`ingest-topshot-pack-opens-history`, `pinnacle-nft-resolver`, `pinnacle-owner-discovery`,
`pinnacle-owner-discovery-forward`, `sales-serial-backfill`, `scan-ufc-wallet`,
`ufc-stub-thumbnail-resolver` — these write ids, hex addresses, serials, block heights, and closed
enum/slug codes. Two worth naming:

- **`scan-ufc-wallet`** decodes `editionName` but only feeds it to `slugify()`, which strips
  `[^A-Z0-9]+` — mojibake bytes (U+0080–U+00BF) are non-alphanumeric and collapse to the same `-`,
  so the resulting `edition_key` is byte-identical either way. Genuinely safe, not merely unlikely.
- **`ufc-stub-thumbnail-resolver`** is the one borderline call: it persists a decoded *string*
  (`editions.thumbnail_url`) rather than an identifier. Left unchanged because it is a
  `Display.thumbnail.uri()` URL and every `thumbnail_url` row in the DB is pure ASCII. A `b64ToUtf8`
  swap there is cheap insurance if you ever want zero decoded-string exposure — **not urgent.**

**Timing is safe:** `seed-allday-pack-distributions` has written **nothing in 15+ days**
(`new_rows_30d = 0`, `touched_7d = 0`; both collections' newest `updated_at` is the repair's own
timestamp), so the DB repair holds until the deploy happens. There is no race.

---

## 4. Deploy steps (operator — nothing below has been run)

All four are **`verify_jwt: false` today** and authenticate via their own Bearer/`?key=` check.
**MCP `deploy_edge_function` RESETS `verify_jwt` → true on every redeploy**, which 401s the cron
trigger. So after each deploy: dashboard → Edge Functions → *fn* → Settings → **Verify JWT with
legacy secret → OFF** → Save, then confirm `verify_jwt: false` via `list_edge_functions`. (The page
renders stale on first load — F5, wait ~8s, then click.)

Deploy each with `mcp__Supabase__deploy_edge_function`:

```
project_id:      bxcqstmqfzmuolpuynti
name:            <slug>
entrypoint_path: index.ts
verify_jwt:      false
files:           [{ name: "index.ts", content: <full contents of supabase/functions/<slug>/index.ts> }]
```

> **⚠ `_shared` NOTE — the one genuinely unresolved risk. Read before deploying the three pack-EV fns.**
>
> They `import { … } from "../_shared/pack-ev-supply-weighted.ts"`. Per the 2026-07-20 handoff these
> are the FIRST edge functions in this repo to import `_shared` at all, and **no `_shared`-importing
> pack-EV fn has ever been deployed** — every currently-deployed copy is inline. So this deploy
> exercises an untested path.
>
> The 2026-07-20 handoff prescribes the **Supabase CLI** (`supabase functions deploy …
> --no-verify-jwt`), which Deno-typechecks and **bundles** the import automatically, so a wiring error
> fails the deploy instead of shipping broken pricing. That is the preferred path **if the CLI works** —
> but note the `sbp_` PAT was revoked on 2026-07-16, so the CLI may 401; check before relying on it.
>
> **I could NOT verify how MCP `deploy_edge_function` resolves a relative `../_shared/` import** — I
> did not deploy anything, and the tool's behaviour here is undocumented in this repo. Best guess is
> that the `files:` array must carry both entries
> (`[{name:"index.ts",…},{name:"../_shared/pack-ev-supply-weighted.ts",…}]`), but treat that as
> **unverified**. Mitigation, either way:
>
> 1. Prefer the CLI if it authenticates (it bundles + typechecks).
> 2. **Deploy Golazos FIRST as a canary** (lowest traffic, and its EV is a small collection), then
>    confirm a real tick wrote `typical_ev` before touching AllDay or Pinnacle.
> 3. If the import cannot be resolved by whichever tool you use, the fallback is a **one-file inline
>    deploy**: take the repo `index.ts` and paste the two helpers (`weightedMedianFmv`,
>    `weightedMeanEv`) inline in place of the import. Behaviour is identical — the repo↔`_shared`
>    drift guard in CI explicitly accepts an inline-verbatim copy as well as the import, so doing this
>    does not redden CI. Prefer keeping the repo on the import and inlining only in the deploy payload.

| # | slug | why | post-deploy verification |
|---|---|---|---|
| 1 | `compute-golazos-pack-ev` | typical_ev + `_shared` (canary) | `pipeline_runs` newest row: `ok=true`, `extra.function_version = 2`; then `SELECT count(*) FILTER (WHERE typical_ev IS NOT NULL) FROM pack_ev_history WHERE collection_id='06248cc4-…' AND snapshotted_at > now()-interval '1 hour';` must be **> 0** |
| 2 | `compute-allday-pack-ev` | typical_ev + `_shared` | same, `function_version = 9`, collection `dee28451-…` |
| 3 | `compute-pinnacle-pack-ev` | typical_ev + `_shared` | same, `function_version = 2`, collection `7dd9dd11-…`. Note Pinnacle EV is currently SUPPRESSED at the read layer by `audit_20260725_pack_ev_require_drop_pool` (no `pack_drop_pool` rows) — `pack_ev_history` still fills, the board still shows no EV. Expected. |
| 4 | `seed-allday-pack-distributions` | mojibake writer | dormant 15+ days; nothing to verify until it next runs. If you force a tick, check `title`/`metadata` for new `Ã`/`â€“` sequences: expect **0**. |
| 5 | `topshot-stub-resolver` | mojibake writer | after a tick, spot-check a resolved edition's `player_name` for correct accents |
| 6 | `enrich-ufc-wallet` | mojibake writer | after a tick, spot-check `wmc.player_name` for a UFC wallet |

**Do NOT deploy `compute-topshot-pack-ev`** — it is byte-identical, so the deploy would be pure
churn plus a `verify_jwt` re-toggle risk.

**Deployed-vs-repo re-verified for the three mojibake fns before writing this** (so a deploy can't
drop deployed-only behaviour): `topshot-stub-resolver` v13 **byte-identical**, `enrich-ufc-wallet` v31
**byte-identical**, `ufc-stub-thumbnail-resolver` v8 differs by **comments only, all additive on the
repo side** (zero deployed-only lines). All safe.

---

## 5. Revert paths

Repo side (this push):

- Pack-EV reconciliation: `git revert <sha of the pack-ev reconcile commit>`. That restores the
  drift, so it should only be done together with a decision about prod.
- Individually: remove the `typical_ev:` field from the `evRows` push in the relevant
  `compute-*-pack-ev/index.ts`, and drop `weightedMedianFmv` + `typicalEv` from `_shared`.
- Mojibake: `git revert <sha>` on the same commit, or swap `b64ToUtf8(` back to `atob(` at the three
  sites (**not recommended** — that reinstates the corruption writer).

Prod side, if a deploy misbehaves: redeploy the **previous** body. For the three pack-EV fns the
previous deployed body is the inline `v9`/`v2`/`v2` source captured in this session; the safest
rollback is to re-deploy the inline variant (no `_shared` dependency) — i.e. take the repo file and
replace the `_shared` import with the inline helpers, or fetch the prior version from Supabase before
deploying so you hold a copy.

**Recommendation: fetch and save each function's current deployed source before deploying it.**
`get_edge_function` returns only the *current* version, so once you deploy, the previous body is not
retrievable from Supabase.

---

## 6. Durable lessons

1. **An MCP edge-fn deploy creates git drift by construction.** `deploy_edge_function` does not touch
   the repo. Any MCP deploy must be followed by a repo commit of the same body, or the next
   repo-based deploy silently reverts it. This has now bitten `compute-allday-pack-ev` twice
   (2026-07-01 v8, 2026-07-18 v9).
2. **A repo↔repo test cannot detect repo↔prod drift.** Guard the *property* (does this writer persist
   this field?), not just the *consistency* (does the copy match the module?).
3. **The dangerous drift direction is repo-BEHIND-prod.** Repo-ahead is benign — deploying improves
   prod. Repo-behind means deploying regresses it, silently, with `ok=true`.
