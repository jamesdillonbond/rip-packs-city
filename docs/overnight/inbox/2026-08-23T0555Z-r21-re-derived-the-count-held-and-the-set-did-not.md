# R21 re-derived: 67 / 38 / 29 reproduces exactly — but its named example LEFT the set, and nobody had enumerated it

**Filed 2026-08-22 ~22:5x PT (2026-08-23 ~05:5x Z), Claude Code interactive, read-only.
Nothing deployed, nothing committed to `supabase/functions/`.**

The register says severities, rates and liveness claims must be re-derived every pass. This is R21's
re-derivation, plus the thing that re-derivation exposed.

## The counts reproduce to the unit (2026-08-22)

| measure | R21 (2026-08-22) | today | source |
|---|---:|---:|---|
| deployed edge functions | 67 | **67** | Supabase MCP `list_edge_functions` |
| committed dirs (excl. `_shared`) | 38 | **38** | `git ls-tree -d origin/main supabase/functions/` |
| deployed with NO committed source | 29 | **29** | set difference |
| committed but not deployed | 0 | **0** | set difference, other direction |
| of the 29, `verify_jwt: false` | 21 | **21** | per-function flag |

Both halves counted by the same instrument, both directions taken.

## ⚠ But the count holding does NOT mean the set held — and here it demonstrably did not

R21 reads: *"Proven by example, not theory: `b70d4582` (08-18) found `resolve-allday-rip-dist-api` — a
member of that set — deployed with a literal `const GATE` as the sole auth on a service-role writer."*

**`resolve-allday-rip-dist-api` is NOT in the set today, and has not been since 08-18** — that same
commit is what committed its source (`supabase/functions/resolve-allday-rip-dist-api/` first appears in
`b70d4582`, 2026-08-18). The sentence is defensible as history and misleading as a present-tense
membership claim; a reader chasing the example finds it already fixed and may conclude the row is stale.

🚨 **So the population is 29 in both readings while its MEMBERSHIP changed by at least one, and nobody
can say by how much, because no pass ever wrote the members down.** This is CLAUDE.md's *"diff the SET,
not the count"* in its least visible form: not a number that moved, but a number that **didn't**.

## The fix for that is this list. It is the baseline the next pass diffs against.

**Deployed, no committed source, `verify_jwt: false` (21) — publicly invokable with auth unreadable from the repo:**

- `allday-unmapped-resolver`
- `audit-storefront-wallets`
- `backfill-allday-dist-opened`
- `backfill-allday-pack-sales`
- `backfill-golazos-series`
- `backfill-player-names`
- `backfill-topshot-pack-sales`
- `backfill-ufc-thumbs`
- `classify-acquisitions`
- `compute-achievements`
- `flowty-loan-indexer`
- `ingest-external-announcements`
- `ipfs-catalog-loader`
- `pipeline-failure-alerts`
- `resolve-allday-pack-dist`
- `resolve-allday-pull-editions`
- `scan-allday-wallet`
- `scan-golazos-wallet`
- `scan-storefront-events`
- `seed-allday-editions`
- `seed-golazos-editions`

**Deployed, no committed source, `verify_jwt: true` (8) — JWT-gated, so lower severity:**

- `admin-badge-backfill-bridge`
- `allday-consumer-gql-smoke`
- `allday-unmapped-bridge`
- `badge-icon-cache-put`
- `pinnacle-render-cache-put`
- `pinnacle-render-smoke`
- `shared-deploy-probe`
- `tmp-pack-pool-probe`

⚠ **This is a NAME list, not a risk ranking.** `verify_jwt: false` means the platform does not check a
JWT; several of these carry their own `?key=` gate whose value cannot be read from the repo — which is
exactly the auditability gap R21 names, not proof any one of them is open. **Do not treat the 21 as 21
vulnerabilities, and do not "fix" one by fetching its deployed source into the transcript** —
`get_edge_function` returns the full `index.ts` and has echoed a live gate key before.

⚠ **Both credential guards derive their file set from `supabase/functions/**`, so all 29 are outside
them BY CONSTRUCTION** — the guard-derivation class this repo keeps re-learning. Committing a function's
source is what brings it into scope; nothing else does.

## What would close R21, in order of cost

1. **Commit the source of the 21 unauthenticated ones** — that alone puts them inside both guards.
2. Re-run this diff and confirm the set is empty in the `verify_jwt: false` half.
3. Only then consider the 8 JWT-gated ones, which are a hygiene item rather than an exposure.
