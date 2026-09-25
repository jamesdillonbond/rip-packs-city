<!-- Moved VERBATIM out of CLAUDE.md on 2026-09-19 to pay for the chain-two
address section, per that file's own rule: an addition arrives paired with its
displacement, and you move DATA, never judgement. This index is navigation data
— every CLAUDE.md section still carries its own inline pointer to the file it
needs, so nothing here is load-bearing for a single lookup. -->

# docs/reference — index

All under `docs/reference/`:

- **`key-files-and-honesty.md`** — largest and most-read. Key modules + the full honesty canon, leak guards, fabricated-number shapes, OG cards, Workers.
- **`database.md`** — `editions` · `wmc` · `fmv_snapshots` · `sales`, role timeouts, PostgREST caps, `apply_migration` cost, security posture.
- **`testing-and-ci.md`** — vitest layers, the 3 coverage gates + ratchets, DB-invariant SQL pins, mutation categories, CI jobs, Playwright.
- **`known-issues.md`** — open/resolved register (stable item numbers), deferred hardening, deep-audit follow-ups.
- **`cron-and-schedulers.md`** — the 4 schedulers, pg_cron mechanics, `pipeline_runs` retention + rollup traps, fleet health, saturation.
- **`trust-board-and-safety.md`** — trust board (⚠ read its own "arm count drifts / 60 s timeout" caution first), precompute split, destructive-op breaker, cross-session coordination.
- **`chain-strategy.md`** — multi-chain thesis, Candy/Solana + Panini readiness, chain-abstraction Phases A–F.
- **`routes-and-surfaces.md`** — route structure, per-collection `pages`, API endpoints, search.
- **`apis-and-cadence.md`** — Top Shot / All Day GraphQL, Flowty, Flow REST, the RPC FMV API, contracts, Cadence gotchas.
- **`concierge.md`** · **`brand-auth-proxy.md`** · **`tooling-gotchas.md`** · **`packs.md`** · **`architecture-notes.md`** · **`ledger-discipline.md`** · **`autonomous-tasks.md`** · **`roadmap-status.md`** · **`session-and-archive-conventions.md`** · **`parallels-variants-data-model.md`** · **`revert-map-2026-07-25.md`**.
- **`vitest-config-notes.md`** — the case histories moved verbatim out of the three vitest gate configs (2026-09-02); each config line points to its section.
- **`claude-md-condensed-originals.md`** — verbatim pre-restructure text of sections **shortened rather than moved**. ⚠ **Check here first if a detail seems missing.**
- **`schema-truth.md`** — read from the live DB; **wins on any disagreement with prose — but only as fresh as its stamp** (no generator; read the stamp).
