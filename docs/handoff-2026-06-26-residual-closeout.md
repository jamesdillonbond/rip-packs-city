# Residual closeout — 2026-06-26 audit follow-ups (post-CC-drain)

Companion to [docs/handoff-2026-06-26-audit-followups.md](handoff-2026-06-26-audit-followups.md) and the audit [docs/audits/full-platform-audit-2026-06-26.md](audits/full-platform-audit-2026-06-26.md). Records the genuinely-residual state after Claude Code drained the handoff (6 shipped: items 1/2/4/9/10/11; prod `219a34a` READY, independently verified). Read on desktop.

## AllDay badge parity (item 3) — moment-level badges DO exist; it's EGRESS-gated (empirically verified on Dapper Market 2026-06-26)

**Conclusion (corrected — supersedes the earlier "data-gated/absent" parking):** NFL All Day has real, per-moment, structured badges. The blocker is reaching them from our infra (WAF), NOT their existence. The set-name heuristic is the *wrong* approach and should not be expanded.

Two corrections converge here:
- **Trevor's correction:** AllDay badges are **moment-level and vary within a set**, so the `classifyAlldayBadges(set_name)` heuristic would smear one set-level guess across moments that differ. Do **not** expand it.
- **Empirical verification on Dapper Market** (`dapper.market/nfl`, the live post-Flowty Dapper marketplace): NFL All Day exposes per-moment badges as **first-class, filterable, structured** attributes. Observed badge facets in the moment filter rail: **All Day Debut, Rookie Year, Historical, Launch Codes** (achievement badges) alongside position (QB), tier (Rare/Legendary), and Series. Filtering applies via a `?badges=<slug>` query param (e.g. `badges=rookie-year`), and moment cards carry parallel chips (e.g. "Obsidian"). So a structured per-moment badge↔moment mapping demonstrably exists in Dapper's data layer.

**Why "absent from reachable data" was wrong:** the badge data is not absent — it lives in the Dapper / NFL All Day backend. dapper.market fetches it **server-side** (Next.js App Router RSC; the browser makes no public XHR for the moment list, only Segment analytics), behind the **same Cloudflare WAF that 403s our workers/edge** (the block behind the 389 AllDay unmapped sales). It's the same authoritative source the original [handoff item 3](handoff-2026-06-26-audit-followups.md) named — now confirmed to actually carry the badges.

**So item 3 is egress-gated, not data-gated.** The realistic path:
1. **Egress decision (Trevor):** reach the AllDay badge source from a WAF-proof surface — Vercel server egress (the AllDay resolver notes Vercel reaches some AllDay surfaces the topshot-proxy worker can't), or a residential proxy (the same lever the dapper.market/Atlas-style ingest already uses for the underpriced-serials board). A focused capture session (or a Vercel-egress probe of the AllDay consumer GQL with badge fields requested) confirms the exact endpoint + field — the browser RSC path hides it, so it needs a server-side probe, not a DOM scrape.
2. **Then a bounded writer:** replace the string-match writer in [app/api/seed-allday-badges/route.ts](../app/api/seed-allday-badges/route.ts) with a real per-moment-tag writer populating `badge_editions.play_tags`/`set_play_tags` (mirror [app/api/badge-sync/route.ts](../app/api/badge-sync/route.ts) `normalizeEdition`/`mergeTags`). The taxonomy is small + clean (All Day Debut / Rookie Year / Historical / Launch Codes + a few more behind the filter's "Select"), kebab-case slugs.
3. **Art:** NFL badge SVGs for `badge_taxonomy.icon_url` (TS `nbatopshot.com` art won't fit NFL); until then they render as colored text pills, which is honest.

Net: this is worth doing iff Trevor greenlights the egress work — and it's now justified, because the target data is confirmed real, structured, and per-moment (not a phantom). It is genuinely the same class of egress lever already used elsewhere on the platform, not new infra.

## Operator / infra (not code; Trevor or operator)

- **`allday-fmv-populate` cron — CONFIRMED safe to retire (read-only verified, Cowork + CC).** `fmv-recalc` owns **100%** of AllDay's current latest FMV snapshots across all 7 confidence tiers (1.7.0 + cold-tail + ASK fallbacks); the `allday-gql-v1` writer last wrote 2026-06-11 and now no-ops every tick (`editions_fetched:0`). Disabling its cron-job.org entry has zero pricing impact and saves the invocations + GQL-proxy calls. Operator action whenever convenient.
- **`NIGHTPASS-0626-NOCLOSE`** — the daytime monitor flagged that last night's autonomous pass took its lock but wrote no digest/closeout and left the inbox undrained (lock ~10h stale). Self-recovering per the monitor; if tomorrow's morning digest is missing again, check the scheduled-task trigger.

## Wait-for-data (monitored, no action)

- **Serial / #1 / perfect-serial FMV for AllDay + Pinnacle** — data-gated: needs enough #1/perfect-serial *sales* to fit the power model (the same gate TS cleared). AllDay exposes serialOne/lastMint/jersey and Pinnacle has per-render circulation, so the inputs exist; the sale density doesn't yet. Re-evaluate once AllDay #1/perfect-serial sale counts approach the TS fit threshold.

## Closed — no action (recorded for completeness)

- AllDay FMV dual-writer race (item 5) — disproven (not an actual race; `allday-gql-v1` no-ops, fmv-recalc owns AllDay).
- Golazos/UFC ASK fallback (item 7) — no live-ask source for those collections → no-op.
- Pinnacle FMV → shared consumers (item 8) — already done.
- Pack `total_minted/total_opened/total_sealed` columns — vestigial 0s, unused by the UI (reads `m