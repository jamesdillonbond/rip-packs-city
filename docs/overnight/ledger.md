# RPC overnight pass — ledger

Rolling record of items the nightly autonomous pass has shipped / queued / declined. The night pass reads this fully before acting and never re-suggests anything under "Declined — do not re-suggest" (that heading is Trevor's to edit).

Format per item: date · status · what · revert path (if shipped) · target metric · night-count (if queued).

---

## Shipped (autonomous, with revert path)

_None yet._

---

## Queued — awaiting a clean window or operator decision

- **Q1 · 2026-05-30 (night 1) · Flip remaining 3 `topshot_pack_reality_*` views to `security_invoker`.**
  Clears the last 3 Supabase `security_definer_view` ERRORs (down from 14; the operator flipped 11 live this afternoon via `audit_20260530_secdef_views_to_security_invoker`). NOT auto-shipped because the operator was actively executing this exact remediation during the run — collision. Verified safe (all readers are service_role; no anon client reads).
  Ready migration: `ALTER VIEW public.topshot_pack_reality_{top_ev,stats,dist} SET (security_invoker = on);`
  Revert: `... SET (security_invoker = off);`
  Target: `get_advisors(security)` SECDEF-view ERROR 3 → 0; `/api/public/insights/pack-reality` still returns rows.

- **Q2 · 2026-05-30 (night 1) · Confirm `compute-laliga-pack-ev` cron cadence (inbox P4).**
  Idle ~17h, 0 fails — likely by-design (Golazos has no confirmed primary pack path). Operator to verify the cron-job.org entry. Not autonomous (pack-EV logic off-limits + external cron).

---

## Resolved during the day by the operator (logged so the pass doesn't re-raise)

- **P2 (inbox 2026-05-30T21:32) · pinnacle-listings-indexer Sentry noise** — RESOLVED by commit `bd4d8c4` (deploy `dpl_4UBShmk267fUqit46PFZNuTLRFJd` READY). Counter now only increments on genuinely-new failure inserts.
- **P3 (inbox) · pinnacle/moment null destructure (`JAVASCRIPT-NEXTJS-1B`)** — RESOLVED by `01b3878`→`26d5968`→`fe96d4b`. Stopped firing ~5h before the run. Mark the Sentry issue resolved once 24h clean.
- **P1 (inbox) · 11 of 14 SECDEF views** flipped to `security_invoker` via `audit_20260530_secdef_views_to_security_invoker` (operator, 21:48 UTC). Tail-3 tracked as Q1.
- **Entity-pages pass (operator/Cowork, 2026-05-30) · 3 migrations shipped LIVE + code packaged for Claude Code.** All read-only SECDEF, `service_role`-only, verified: `audit_20260530_fix_get_team_players_dedup_roster` (team roster no longer fans out duplicate `players` rows — Lakers 30×LeBron → 73 distinct), `audit_20260530_fix_get_team_detail_player_count_dedup` (`player_count` 116→73), `audit_20260530_add_get_team_top_editions` (NEW rpc — revert `DROP FUNCTION public.get_team_top_editions(uuid,text,integer,integer);`; the two fixes' prior bodies are in the 2026-05-30 session transcript but reverting a bug fix is not expected). **Do NOT re-suggest team-roster / player-count work — fixed.** Remaining entity-page work (P0 edition-404 colon-decode fix, JSON-LD ×6, pack contents grid, hero montages, branded OG cards, hover-video) is packaged for Claude Code in `docs/handoff-2026-05-30-entity-pages.md` — **night pass should NOT auto-ship these (operator/CC owns them).** Full audit: `docs/audits/entity-pages-improvement-2026-05-30.md`.
  **UPDATE 2026-05-31 — CODE HALF FULLY SHIPPED by Claude Code (commits `bf3f4f6`, `b106a27`, `5797235`, `29d2e46`; all 4 CI+Smoke green, all deploys READY).** All 8 handoff items live + verified. Also opened the entity detail pages (`/<collection>/{edition,set,player,team,series,pack}/<slug>`) + `GET /api/entity/*` + `/api/og/*` to anon in `proxy.ts` (with Trevor's go-ahead) — they were auth-gated despite being advertised in the sitemap, so the SEO work was invisible to crawlers. One extra migration shipped live: `audit_20260530_entity_edition_rpcs_thumbnail_filter_and_video_url` (grid RPCs filter `thumbnail_url IS NOT NULL` + expose `video_url`). See CLAUDE.md Recent sessions 2026-05-31. **Night pass: entity-pages work is DONE — do not re-raise.**

---

## Declined — do not re-suggest
_(Trevor owns this section. Add an item here to stop the night pass proposing it.)_

_None._
