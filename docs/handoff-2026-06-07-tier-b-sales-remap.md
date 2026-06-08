# Handoff 2026-06-07 — F1/F2 Tier-B: re-map the 342 impossible-serial sales (52 TS editions, incl. the 8:62 Giannis fix)

CONTEXT

Sequencing: run AFTER the DUPE1 canonical merge (docs/migrations/dupe1-merge-plan-2026-06-07.md) so sales rows only move once. Both are yours (Trevor's decision 2026-06-07 evening). DB work via the Supabase MCP, audit_ migration tags, backups before any UPDATE.

342 TS sales in the last 365d carry serial_number > circulation_count — physically impossible, so each row sits on the WRONG edition. Evidence + the full top-10 hit list: docs/audits/fmv-low-quality-decomposition-2026-06-07.md. Precedent: the Tier-A fix (2026-06-03 interactive FMV sweep) re-mapped Clamps 226:7541 the same way. The F3 guard already excludes impossible serials from WAP, so current displayed prices are NOT wrong — the damage is invisible: the TRUE owner editions are missing volume, deflating sales_count_30d and pinning some at LOW that deserve MEDIUM (this is one of the two honest FMV-quality movers).

WHY 8:62 MATTERS SPECIFICALLY: Giannis Cosmic, circulation 49, has 65 impossible-serial sales attached (max serial 972) and currently prices at $5.95 LOW — absurd for a circ-49 Cosmic. The known eyeball-flag from 2026-06-03. Its in-range "sales" are likely also polluted (sales of the Base Set sibling with serials <= 49 are indistinguishable by serial alone — see the ambiguity rule below).

METHOD (per edition, dry-run everything first)

1. Reproduce the cohort: sales s JOIN editions e ON e.id=s.edition_id WHERE e.collection_id = TS AND e.circulation_count > 0 AND s.serial_number > e.circulation_count AND s.sold_at > now() - interval '365 days'. Expect ~342 rows / 52 editions (re-count at execute time).
2. For each bad sale, find the TRUE edition: same player_name + set_name (and play, if distinguishable) in the SAME collection, different external_id, whose circulation_count >= the sale's serial_number. Resolution classes:
   a. Exactly one sibling qualifies → re-map (UPDATE sales SET edition_id = sibling).
   b. Multiple siblings qualify → AMBIGUOUS: leave the row, log it. Do not guess.
   c. No sibling qualifies → the edition's circulation_count may be stale/wrong instead — verify circulation via the TS GQL/Cadence before concluding; if circ is wrong, fix editions.circulation_count instead of moving sales.
3. Backup first: CREATE TABLE audit_tierb_sales_backup_YYYYMMDD AS SELECT id, edition_id, serial_number, transaction_hash FROM the cohort. Revert = UPDATE back from the backup by id.
4. Collision check before each UPDATE batch: the per-partition unique(transaction_hash) — if a tx already exists under the target edition, the bad row is a double-ingest: DELETE it instead of re-mapping (log which).
5. After re-mapping: re-run FMV for BOTH sides of every move (the donor editions lose phantom volume, the receivers gain real volume). Easiest: hit /api/fmv-recalc with the touched edition list, or let the normal sweep cycle them and verify the day after.
6. The 8:62 special: after its impossible serials move out, eyeball whether its remaining low-serial sales are genuinely Cosmic (price level sanity: a circ-49 Cosmic Giannis should not be single-digit dollars). If still polluted, classify the residual by price-band and document — do not force a number.

VERIFY

- Cohort count drops 342 → ~only the logged ambiguous/no-sibling rows.
- 8:62 FMV moves to a sane circ-49 Cosmic level (or is documented as still-ambiguous); receiving editions' sales_count_30d rise; a few flip LOW → MEDIUM honestly.
- v_fmv_sanity_flags doesn't spike; smoke green; no Sentry novelty.

REVERT

audit_tierb_sales_backup_YYYYMMDD holds every moved/deleted row's original state — UPDATE back by id (re-INSERT for deleted double-ingests), then re-run fmv-recalc on the touched editions.

GUARDRAILS (standard)
- Direct-to-main for any code touched (none expected — this is DB-only). One statement per MCP call; count(*) before anything destructive; verify-then-write in separate steps; log the session in CLAUDE.md + ledger with revert paths.

END STATE: zero unexplained impossible-serial sales; donor and receiver editions both priced off their real history; the 8:62 mystery closed with either a corrected price or a documented residual.
