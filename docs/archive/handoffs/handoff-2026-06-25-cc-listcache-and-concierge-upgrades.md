# Claude Code handoff — listing-cache fix + concierge upgrades from Trevor's bot feedback (2026-06-25)

Four items. #1 is a verified bug (GHA timeout starving a step). #2–#3 are concierge training/tool gaps from Trevor's own feedback on the live bot last night (`support_conversations` ids 4063/4064, `tdillonbond@gmail.com`, non-smoke). #4 is a UI feature request (id 4067). Each note marks what was **verified** vs **recommended**, so don't take the recommendations as established fact — confirm before shipping.

Guardrails: direct to `main`, no branches/PRs; PowerShell `git`, re-verify push `git rev-list --count origin/main..HEAD` → 0; `npx tsc --noEmit` clean; Vercel `maxDuration` ≤ 800s; deploy READY + smoke. After any DB change confirm `check_public_security_invariants()` = [] and `check_secdef_anon_execute_violations()` = [].

---

## 1. [HIGH-ish] `topshot-listing-cache` is starved by the GHA pipeline's 18-min timeout

**Verified (read the YAML + the GitHub Actions run page 2026-06-25):**
- `topshot-listing-cache` is triggered ONLY by `.github/workflows/rpc-pipeline.yml` ("RPC Data Pipeline", schedule `5,25,45 * * * *`). Not in `vercel.json`, not cron-job.org.
- That `pipeline` job has `timeout-minutes: 18` and **no** `concurrency`/`cancel-in-progress`.
- Actions run history: runs **988–991 (since 12:29Z) are "Cancelled"**; run 987 (09:47Z) "completed successfully." Run 991's annotation verbatim: *"The job has exceeded the maximum execution time of 18m0s → The operation was canceled"* (duration 18m18s).
- The "Top Shot Listing Cache" step is **#5 of 7** in the job (Ingest → FMV Recalc → FMV Backfill → Backfill Player Names → **Listing Cache** → Backfill historical → Price snapshots). When the job is killed at 18m during the earlier steps, step 5 never runs — which is why the last `topshot-listing-cache` `pipeline_runs` log (09:53Z) lines up with the last successful job (987, 09:47Z). At time of writing it's ~11.8h stale; sibling listing-caches (allday/golazos/ufc) run every ~20m via their own triggers.

**NOT verified (don't assume):** which earlier step started eating the time, or why around 12:29Z. The per-step durations in the job log (click into a cancelled run) will show it. Plausible-but-unconfirmed: DB load from the studio backfills draining ~124K sales slowed the ingest/FMV steps.

**Fix (pick one — all are `rpc-pipeline.yml` edits):**
- Quickest: bump `timeout-minutes: 18 → 30`. Restores the step now; doesn't address the underlying slowdown.
- More robust (recommended, since this recurs as load grows): **decouple** the listing-cache from this monolith — give it its own small scheduled workflow (or move the step to position #1 so it runs before the heavy steps). Decoupling is best because the listing-cache route is already fire-and-forget (`after()`), so it doesn't need to share the pipeline's runtime budget.
- First, look at the job log to see if one step is genuinely hung (then fix that step) vs. general slowness (then bump/decouple).

**Verify after:** next scheduled run completes (not Cancelled) AND `topshot-listing-cache` logs a fresh `pipeline_runs` row.

---

## 2. [concierge] #1/special-serial "for sale" queries — the bot can't actually answer them (feedback id 4063)

**Trevor's feedback (verbatim summary):** asked for best value on a Top Shot #1 serial; bot called `get_special_serial_owners`, then said *"none of these are listed for sale right now per the live feed"* **without** calling `search_live_deals` with a serial-aware filter.

**Verified root cause (read the tool schemas in `app/api/support-chat/route.ts`):**
- `get_special_serial_owners` returns **ownership** (who holds the #1/perfect/jersey among tracked wallets), explicitly *"not a guarantee of present custody"* — it is NOT a listings tool. The bot wrongly treated its empty/owner result as "nothing for sale."
- `search_live_deals` (input: collectionId/player/character/tier/maxPrice/minDiscount/limit) and `search_catalog_deals` (adds team/hasBadge) have **NO serial filter**. They return `serial_number` in results but cannot restrict to #1/special serials. So even if the bot had called them, it could not target #1s.

**Verified the data exists to fix it (queried live):** `public.topshot_active_listings` (352 rows, `last_seen_at` ~2h fresh — the Atlas residential serial-listing feed) and `public.topshot_underpriced_serials_board` (10 rows; cols include `serial_number, ask_usd, listing_url, edition_fmv_usd, serial_fmv_usd, serial_multiplier, discount_pct, serial_bucket, estimate_quality, player_name, set_name, tier, thumbnail_url, nft_id, edition_key`). These are exactly "special serials currently LISTED (and how far below serial-FMV)."

**Fix (route code):**
- Add a concierge tool — e.g. `search_serial_deals(playerName?, tag('#1'|'perfect'|'jersey')?, tier?, minDiscount?, limit?)` — that queries `topshot_underpriced_serials_board` (already discount-ranked; prefer `estimate_quality='tight'` rows first, the board's own honesty flag) and/or `topshot_active_listings` filtered by `serial_number=1` (or special-serial logic) for the "what's listed" case. Return ask_usd, serial_fmv_usd, discount_pct, listing_url, player/set/tier.
- Prompt fix (system prompt, the "Deal concierge" / examples area): make explicit that `get_special_serial_owners` answers *who holds* a chase serial, NOT *what's for sale*; for "best value / buy / listed #1 (or special) serial," call the serial-deal tool (or `search_live_deals` + filter), and never conclude "nothing's listed" from an ownership tool.
- **Caveat to encode:** `topshot_underpriced_serials_board` is only ~10 rows and depends on the Atlas residential ingest (runs ~3h on Trevor's machine); when empty, say "nothing special-serial is listed below FMV right now," don't imply the feed is broken.

---

## 3. [concierge] Badge-awareness in valuation/ranking (feedback id 4064)

**Trevor's feedback (verbatim summary):** the Flagg Legendary is a rookie moment and the Jokić Base Common carries a Top Shot Debut badge — both priced in by the market; the bot acknowledged it but **declined to factor it in, citing lack of a tool call.**

**Verified:** `search_catalog_deals`'s handler already returns `badges: d.badge_slugs` in its result rows (route.ts ~line 942), and the system prompt already references badges in several places. So in many cases the bot **already has** badge data in the tool result — the gap is that it isn't *using* it in valuation/ranking, and it claimed it couldn't. `get_fmv`, by contrast, does **not** return badges.

**Fix (mostly prompt, small tool note):**
- Prompt: instruct the bot that when a tool result includes `badges`/`badge_slugs`, it MUST factor them into valuation/ranking commentary (Rookie Year, Top Shot Debut, Championship Year, etc. carry real market premium), and must NOT say it can't factor badges in — the data is in the row. For "is this a chase / why is this worth more" or #1-serial questions, prefer `search_catalog_deals` (returns badges) over `get_fmv` (doesn't), or chain them.
- Tool: when you add the serial-deal tool (#2), have it return badges too (join `badge_editions` / `get_edition_badges_unified` by `edition_key`/`external_id`) so serial-deal answers are badge-aware. (Verify the join — I did not confirm the serial board carries badges; its columns above do **not** include a badge field.)

---

## 4. [feature request, larger] Alerts config UI: toggleable + type-to-fill (feedback id 4067)

**Trevor's request:** on the alerts page, replace the current filter/option structure with **toggleable (on/off) options + type-to-fill (typeahead/autocomplete) inputs** — the current layout is cluttered/cumbersome to configure.

**Verified file location:** the alerts UI is `app/alerts/page.tsx` (+ `app/alerts/layout.tsx`); there is also `app/dashboard/alerts/page.tsx`. The feedback's `page_context` was "overview (alerts)" / "/overview/alerts" — confirm which surface Trevor meant before redesigning (likely the alert-creation filter block in `app/alerts/page.tsx`). This is a real frontend redesign (toggles for each alert dimension + typeahead for player/set/team), not a quick change — scope it as its own task.

---

## Source of the feedback
`select * from support_conversations where id in (4063,4064,4067)` (non-smoke, `tdillonbond@gmail.com`, 2026-06-25 ~02:29–02:32Z). Update each row's `feedback_status` when shipped.
