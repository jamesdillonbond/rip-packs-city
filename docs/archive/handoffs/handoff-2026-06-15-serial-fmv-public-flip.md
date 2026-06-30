# Handoff 2026-06-15 — Serial-FMV: flip the public line + recompute coordination

Context. The per-serial FMV layer is shipped (CC deploy 0122f9c): serial_fmv_estimate() wired into get_moment_detail + get_trophy_slab_data, additive, floored at edition FMV, HIGH/MEDIUM-gated, #1+perfect only, "estimated #1 premium" label. Owner surfaces (trophy slabs) already render it. The PUBLIC moment-page line is gated behind env SERIAL_FMV_PUBLIC. Cowork ran the mandatory LiveToken cross-check today — it PASSES (serial-fmv-livetoken-gate-2026-06-15.md). Cowork also scheduled the weekly recompute server-side via pg_cron. This doc covers the env flip + a coordination note so the recompute isn't double-scheduled. No code commit is required for either item.

HEAD at write time: origin/main = 0122f9c (per the relayed CC ship). Nothing in this handoff edits tracked code.

---

Item 1 — Flip the public serial line (env only, no commit)

What: set Vercel env var SERIAL_FMV_PUBLIC = true (Production), then redeploy so it bakes in. The gate is already in the deployed code: app/moment/[id]/page.tsx ~L607 reads `process.env.SERIAL_FMV_PUBLIC === "true"` and only then passes detail.serial_fmv to the page. Verified that line exists; no .tsx change needed.

Why it's safe to flip: the LiveToken gate passed. Three #1s + one perfect, across RARE/COMMON and circ bands, on Trevor's own wallet vs LiveToken's serial-adjusted FMV:
- Clingan Denied! #1/365 RARE: RPC $205 vs LiveToken $151 (+36%)
- McConnell Rookie Debut #1/1250 COMMON: RPC $56 vs LiveToken $32 (+75%)
- Curry Hustle and Show #1/8539 COMMON: RPC $45 vs LiveToken $71 (-36%)
- McCollum Archive Set #4500/4500 COMMON perfect: RPC $7.58 vs LiveToken $5 (+52%)
RPC straddles LiveToken both directions (no systematic bias), every estimate right order-of-magnitude and far above the edition FMV, all inside the ±~45% median error already measured against actual sales. The HIGH/MEDIUM base gate also correctly suppressed 4 of Trevor's 5 Clingan #1s (LOW/STALE base) — it won't fabricate a premium on weak data.

Who flips it: this makes a new number visible to all users, so it's Trevor's call. He can do it directly in Vercel env (Settings → Environment Variables → add SERIAL_FMV_PUBLIC=true → redeploy), or CC can via POST https://api.vercel.com/v10/projects/prj_YBJ6Utl32GfyBOIzbsp3kbshJh96/env?teamId=team_YWGCVToPBJSS60NgVh8jiCFV (PowerShell Invoke-WebRequest; curl fails silently in Git Bash), then trigger a redeploy.

Optional ease-in: leave it owner-only a few more days (it already renders on Trevor's trophy slabs) and eyeball it on his own #1s before flipping. Either is defensible; the data supports public now.

Verify after flip: load any public moment page for a #1 or perfect-serial edition with a HIGH/MEDIUM base (e.g. the Clingan Denied! #1/365 edition) logged-out — the "estimated #1 premium" secondary line should render above the edition FMV. Normal/low serials and LOW/STALE-base editions should show no serial line. npx tsc --noEmit is unaffected (no code change). Deploy reaches READY.

Revert: delete the SERIAL_FMV_PUBLIC env var (or set it to false) and redeploy — the page falls back to edition FMV only. Owner slabs are unaffected (they render unflagged by design).

---

Item 2 — Do NOT wire the refresh-serial-fmv-multipliers route to any external cron (coordination)

What changed: Cowork scheduled the weekly multiplier recompute server-side via pg_cron — job rpc-serial-fmv-multipliers-weekly (jobid 5), schedule 0 11 * * 0 (Sunday 11:00 UTC), command SELECT public.compute_serial_fmv_multipliers(); active. This runs entirely in Postgres, costs zero Vercel invocation, and has no external-scheduler dependency. The 37-cell table was last computed 2026-06-15 23:06 UTC.

Action for CC/operator: the route app/api/cron/refresh-serial-fmv-multipliers/route.ts that CC built is now redundant as a scheduled job. DO NOT wire it to cron-job.org or a GHA schedule — that would recompute the table twice (harmless because compute_serial_fmv_multipliers is DELETE-then-INSERT idempotent, but it adds needless Vercel Fluid cost and confusion). This cancels the previously-queued "Operator: wire weekly cron to /api/cron/refresh-serial-fmv-multipliers" step. Leave the route as a manual on-demand trigger (useful for forcing a recompute), or delete it for tidiness — either is fine. If you prefer the route over pg_cron for pipeline_runs observability, then instead unschedule the pg_cron job (SELECT cron.unschedule('rpc-serial-fmv-multipliers-weekly');) and wire the route — but don't run both.

Revert (pg_cron job): SELECT cron.unschedule('rpc-serial-fmv-multipliers-weekly');

---

Item 3 — tshb (sales-history backfill): no action needed

Checked the queue so this isn't mis-prescribed. topshot-sales-history-backfill is a bounded job: 784 total targets (the zero-sale ASK_ONLY tail), 459 done / 325 pending (59%). It's healthy (45 logged runs/7d, 0 fails) and finishing itself in ~1-2 weeks at the current cadence. GitHub throttles the */15 schedule down to ~6-10 actual fires/day, but since this is a finite tail that's already 59% drained, that's fine — do not add a reliable high-frequency scheduler (Vercel cron / cron-job.org). Each fire is up to 120s of Vercel Fluid compute (ELAPSED_BUDGET_MS=120_000 is the real limiter, not the 40-edition cap), so accelerating it would trade real Vercel cost — the bill Trevor is already watching — to finish a small tail a few days sooner. Not worth it. If you ever want a one-off push, the workflow has a manual workflow_dispatch (mode=drain) that's cost-free beyond the single run.

Note on the broader FMV lever: tshb only drains the 784 zero-sale ASK_ONLY editions — it is NOT the lever that lifts the ~4,693 LOW editions to HIGH/MEDIUM. That lift comes from ongoing fresh-sales density via the normal sales-indexer over time, not a one-shot backfill. Current TS canonical coverage: 3,205 HIGH+MEDIUM (35%), 4,693 LOW, 915 ASK_ONLY, 212 NO_DATA (structurally zero-sale), of 9,137.

---

Roadmap (after the public line is live and has run a few days clean)

Port the serial layer to AllDay: SELECT public.compute_serial_fmv_multipliers('dee28451-5d62-409e-a1ad-a83f763ac070'); then the same serial_fmv_estimate call already works (it's collection-parameterized). AllDay is the biggest cross-collection FMV gap (712 HIGH+MED of 6,191). Validate against LiveToken the same way before exposing AllDay's public line. Then Pinnacle/Golazos/UFC.

---

Guardrails (standard)
- Direct-to-main, no branches, no PRs. If a claude/* branch is pre-checked-out, switch to main first.
- Commit via PowerShell git on Windows (Git Bash git commit can silently no-op). Re-verify push with git rev-list --count origin/main..HEAD (expect 0). (Items 1+2 need no commit; this applies only if you delete the redundant route.)
- curl fails silently in Git Bash for Vercel REST — use PowerShell Invoke-WebRequest.
- Vercel Pro maxDuration hard cap is 800s.
- Don't string-replace-patch on Windows (CRLF) — full-file writes.
- Claude Code's direct file inspection wins over this doc and over project_knowledge_search on any disagreement — adapt to the actual file shape.

Expected end state: SERIAL_FMV_PUBLIC=true on Production (Trevor-approved), deploy READY, the "estimated #1 premium" line live on public #1/perfect moment pages; the multiplier table self-refreshing weekly via pg_cron with no external cron wired; tshb left to finish on its own.
