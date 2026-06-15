# Handoff 2026-06-13 — Next Claude Code prompt: clear everything pending

Master close-out for the 06-13 full audit + the follow-ups Trevor requested. Goal: the next CC run **commits all pending Cowork-authored docs** and lands the remaining code items, so nothing is left dangling in the VS Code working tree. Detailed context: docs/audits/full-platform-audit-2026-06-13.md + docs/handoff-2026-06-13-audit-trophy-moment-media.md.

## STEP 1 — commit the pending docs (Cowork can't push from this session)

These are written to the working tree but uncommitted. Commit them (docs-only → the `ignoreCommand` skips the prod build):
- docs/audits/full-platform-audit-2026-06-13.md
- docs/handoff-2026-06-13-audit-trophy-moment-media.md
- docs/handoff-2026-06-13-cc-next-prompt-clear-all.md (this file)
- docs/ledger-append-2026-06-13-audit.md
- docs/roadmap-2026-06.md (edited: Now section + open decisions reconciled to shipped state)

## ALREADY SHIPPED (do not redo — context only)

- CC `45f52bb` (READY): MomentHeroMedia, special-serials section + owners, copy fix, trophy confidence chip, trophy edition_id canonicalize.
- Cowork DB (live): `audit_20260613_trophy_slab_live_fmv_resolve` (trophy live FMV/tier/circ); `get_edition_special_serials_drop_low_serials` (dropped the low-serial branch per Trevor — function now emits #1 / jersey / last_mint only).

## STEP 2 — code items to land

### Item A — Special serials: final labeling (Trevor-confirmed) [do first, small]
Trevor: the ONLY special serials that matter are **#1, jersey match, and perfect serial — and the perfect serial IS the last mint (#N/N)**. Low serials and everything else do not count. The DB already dropped "low"; remaining is display:
- **app/(collections)/[collection]/edition/[slug]/page.tsx**: the tag-label map (~L851-853) — relabel `last_mint` → **"Perfect Serial"**; remove the `low` case if present; drop `low` from the priority sort (~L434, the `pr()` helper) so it's `#1`(0) / `jersey`(1) / `last_mint`(2).
- **app/moment/[id]/page.tsx**: tag-label map (~L338-340) — relabel `last_mint` → **"Perfect Serial"**.
- **app/moment/[id]/page.tsx** `derivedSerialBadges` (~L681-687, the hero pills): **remove the "Low Serial" push (L686)**; relabel the #N/N push **"Last Mint" → "Perfect Serial" (L687)**; keep the "#1 Serial" push. (Optional: also push a "Jersey Match" pill when `serial === jersey_number`, but the edition isn't carrying jersey on the moment page — the Special serials section already shows jersey, so this is optional.)
- Net: every special-serial surface shows exactly #1 / Jersey Match / Perfect Serial. No "Low Serial", no "Last Mint" wording.

### Item B — AllDay V1-Dapper price-recovery drain [DONE — Cowork wired the cron 2026-06-13]
~~Wire the recovery cron.~~ **DONE:** Cowork created cron-job.org job **7818270** ("RPC V1-Dapper Recovery", `43 5 * * *` UTC, Bearer INGEST inherited via donor-clone of the UFC-drain job). Test-run verified 200 `{ok:true,queued:true}`; first run patched the price-uncertain backlog `price_usd=0` rows 236 → 34 (the 34 = multi-NFT-unsplittable floor, by design). No code needed — the recovery engine already existed. **CC: nothing to do here** beyond optionally confirming the next `promote_unmapped_sales` sweep resolves the now-priced rows (open AllDay unmapped should fall from ~246 toward ~34). The 34 multi-NFT residual is expected, not a bug.

### Item C — Sentry NEXTJS-15 (allday-listings-indexer) [LOW]
`listing_resolution_failures_inserted` fired again ~8h after the `bd8e05c` alert-tuning (so it's a genuine-reason spike, not transient churn). Inspect the actual `unmapped_sales_resolution_failures` reasons being inserted for AllDay V1 — if it's `edition_external_id_not_in_editions_table` (a real keying/seed gap, same V1 root as Item B), seed/fix; if transient, widen the exclusion. Then resolve NEXTJS-15 with regression arming. Likely shares a root cause with Item B (AllDay V1 editions not resolving).

### Item D — Anon collection-overview panels [LOW, confirm]
`/api/fmv/demo` is confirmed public now (200 JSON — CX batch worked). But `/api/sniper-feed` (and likely `/api/packs`, `/api/marketplace-status`) still 307 for anon. Confirm `/<collection>/overview` **hides** those panels for anon (so the SEO front door doesn't render empty "Top Sniper Deals" modules) rather than calling them and showing blank. If they still render empty for anon, hide them or open read-only variants.

### Item E — Moment hero / edition hero parity [follow-up to 45f52bb]
MomentHeroMedia fixed the moment page. The **entity edition page** (`/<coll>/edition/<slug>`) hero likely has the same Series-1 `editions.thumbnail_url` 404 (no per-moment id available there — use a representative moment's `media/<momentId>` or at least an onError fallback). Verify and apply the same treatment. Lower priority.

## NOT doing (decisions logged)
- Full special-serial OWNER coverage (every #1/jersey/perfect holder) needs a per-edition on-chain holder index RPC doesn't run — wmc only covers tracked wallets (~30% of #1s). Leave until traction / fold into chain-two indexing (roadmap open decision #3).
- Jersey-match coverage is capped at ~18% (players.jersey_number sparsity + ~3x player-name dup rows). Optional backfill/dedup, not now.

## Revert paths
- Code: `git revert <commit>`.
- DB `get_edition_special_serials_drop_low_serials`: re-add the `low` UNION branch + `low` in the priority/order (prior body in git history / the 45f52bb migration).
- DB `audit_20260613_trophy_slab_live_fmv_resolve`: re-CREATE the prior frozen-column body (in handoff-2026-06-13-audit-trophy-moment-media.md Item 0).
