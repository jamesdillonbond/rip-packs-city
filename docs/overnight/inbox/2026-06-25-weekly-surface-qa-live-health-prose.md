# Inbox candidate — weekly surface-QA (rpc-surface-qa), 2026-06-25

Source: weekly `rpc-surface-qa` Part 1 (artifact freshness). Two **stale static-prose** items found in the `rpc-live-health` Cowork artifact. Both are non-breaking (queries are all valid; UUIDs/`cached_listings_v2`/`topshot_2025_rookie_index` all correct — no object-ref drift anywhere). Routed here rather than fixed in-session because `rpc-live-health` is the 550-line monitor-owned board with the verified full-file install procedure (char-count + 4 `<script>` + N MATERIALIZED CTEs + render-fn count + JSON-meta-parses check) and because item (1) needs a live-DB status check before rewording.

LOW priority, docs/prose only — no user-facing or query impact. Apply only on a genuine overnight run with the standard verified `update_artifact` install + fresh-subagent read-back.

## (1) Open-Issues panel — stale "Item B" entry (renderIssues, ~line 469)

Current verbatim:
> `Item B fix shipped 2026-05-30 — /api/ingest UUID→int redirect is live. Residual is the pack-EV pipeline path; full canonical merger plan in docs/audits/item-b2-uuid-merger-plan-2026-05-30.md (drafted, not yet applied).`

Why stale: the TS edition-writer leak reads **sentinel TS-UUID-48h ≈ 0** in every recent pass (06-23/24/25), and the misattribution/writer-leak workstream **CLOSED 2026-06-21** (`6b9e89a`, "0 leaks live"; self-heals via pg_cron job7/job8 + the daily drain cron). So "residual is the pack-EV path / merger drafted-not-applied" no longer describes reality.

Action before editing: confirm the live sentinel count + whether the B2 historical-UUID-dupe cleanup is genuinely done (the 06-21 misattribution drain re-keyed/cleaned the historical UUID editions). Then either remove this Open-Issue or reword to: "Edition-writer leak CLOSED — sentinel TS-UUID-48h ~0; writer-side fixed (`/api/ingest` UUID→int redirect 2026-05-30) and historical UUID-dupes drained via the 2026-06-21 misattribution closeout."

## (2) Pinnacle methodology caveat — now moot (~line 225)

Current verbatim:
> `change-point history begins 2026-06-08, so the Pinnacle trend fills forward from that date — earlier days are intentionally empty`

Why stale: the trend window is a trailing 14 days. As of 2026-06-25 the visible window (≈06-11 → 06-25) is entirely after 2026-06-08, so there are no "earlier empty days" left to caveat. The note is now confusing rather than helpful.

Action: drop the "earlier days are intentionally empty" clause (or the whole sentence). No query change — the SQL window logic is fine; only the explanatory caption is outdated.
