// app/api/admin/drain-conflated-subeditions/route.ts
//
// F9 orchestrator (2026-07-04) — drains the standing `topshot_conflated_editions`
// guard (546 editions), whose shared-serial collisions are ~100% the
// SUBEDITION-SPLIT class: parallel moments (Club Collection ::16 /99, Blockchain
// ::17, Hardcourt ::18, Voltage ::13, …) keyed to the BASE setID:playID, so a
// Standard #N and a Club #N collide. The GQL misattrib-drain can't fix this —
// getMintedMoment returns setID:playID:serial but NOT the subedition. The only
// subedition source is on-chain TopShot.getMomentsSubedition (the
// `backfill-topshot-subeditions` edge fn), which only resolves nfts already
// SEEDED in topshot_moment_subeditions.
//
// This route ties the pipeline together, idempotently, per tick:
//   1.  seed_topshot_conflated_subedition_targets      — queue conflated moments
//   1b. seed_topshot_miskeyed_subedition_targets        — queue ::N-keyed unresolved moments
//   1c. seed_topshot_recent_base_subedition_targets     — queue unresolved base nfts in the
//       current parallel era (newest 2 series); catches brand-new parallel sets that neither
//       seed above reaches (no sales collision yet + no ::N editions) — the set-263 gap
//   1d. seed_topshot_collision_knot_targets              — queue the OCCUPANTS of collision
//       knots that aren't yet on-chain-resolved, so step 2 resolves their subedition; the
//       knot resolver (step 6) can then permute them on a later tick
//   2.  trigger the backfill-topshot-subeditions edge fn — resolve subedition on-chain
//   3.  catalog_topshot_subedition_editions_from_resolved — create base::subID editions
//   4.  remap_topshot_split_resolved_subeditions        — split sales/wmc/moments off base
//   4b. remap_topshot_realign_miskeyed_subeditions      — re-key ::N mis-keys back onto the
//       on-chain-correct edition (collision-safe); the inverse the split can't do
//   5.  refresh_topshot_conflated_editions_detector_only — re-measure the guard
//   6.  resolve_topshot_subedition_collision_knots       — resolve the collision knots the
//       realign/split SKIP: two moments transposed onto each other's (edition,serial) slot,
//       where neither can move until the other does. Once BOTH are on-chain-resolved (via the
//       1d seed + step 2), apply the bounded 2-move permutation (≤100/run). ⚠ The old "≤5/run,
//       these surface at ~1/day" was wrong on both halves and cost months: measured 2026-07-31
//       there were 1,441 candidates queued and blocked nfts arriving at ~+8.3/night, so a
//       5/run cap made the backlog DIVERGENT. Keep this limit above the arrival rate.
// Steps 3–4 process what step 2 resolved on PRIOR ticks; the guard converges to 0
// over successive runs. All work is bounded/chunked so a tick fits maxDuration.
//
// Auth: Bearer RPC_ADMIN_TOKEN | INGEST_SECRET_TOKEN | CRON_SECRET, or ?token=.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { verifyAdminRequest, adminUnauthorizedResponse } from "@/lib/admin-auth";

// Raised 300 -> 600 (deep-audit D6). This route went DARK for 9 days: it 504'd
// at its 300s ceiling and, because it only wrote pipeline_runs at the very END,
// a killed tick recorded NOTHING — so detect_stalled_pipelines() saw no failure
// and pipeline_runs_daily simply stopped at 2026-07-31. The route's own header
// claims "all work is bounded/chunked so a tick fits maxDuration"; measured, it
// does not. 600 is well inside the Pro 800s cap. Every step is idempotent and
// cursor-driven, so a longer tick is safe and a re-run is free.
export const maxDuration = 600;
export const dynamic = "force-dynamic";

const PIPELINE = "drain-conflated-subeditions";
const COLLECTION_SLUG = "nba-top-shot";
const SEED_ROUNDS = 4;          // editions batches to seed per tick
const SEED_EDITIONS_PER_ROUND = 60;

function authed(req: NextRequest): boolean {
  if (verifyAdminRequest(req)) return true;
  const hdr = req.headers.get("authorization") ?? "";
  const q = req.nextUrl.searchParams.get("token") ?? "";
  for (const t of [process.env.INGEST_SECRET_TOKEN, process.env.CRON_SECRET, process.env.RPC_ADMIN_TOKEN]) {
    if (t && (hdr === `Bearer ${t}` || q === t)) return true;
  }
  return false;
}

// Fire the on-chain subedition resolver (Supabase edge fn). Fire-and-forget: it
// drains pending targets via getMomentsSubedition under its own EdgeRuntime budget.
async function triggerSubeditionBackfill(): Promise<string> {
  // In the Next app runtime the Supabase URL is NEXT_PUBLIC_SUPABASE_URL; the bare
  // SUPABASE_URL only exists inside the edge-fn runtime (not Vercel). Prefer the
  // public var, fall back to the bare name for safety. (Reading only SUPABASE_URL
  // here made this step return "skipped:no_env" on every Vercel tick.)
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const token = process.env.INGEST_SECRET_TOKEN;
  if (!base || !token) return "skipped:no_env";
  try {
    const res = await fetch(`${base}/functions/v1/backfill-topshot-subeditions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ batch_size: 20000 }),
      signal: AbortSignal.timeout(20000),
    });
    return `${res.status}`;
  } catch (err) {
    return `err:${err instanceof Error ? err.message.slice(0, 80) : "x"}`;
  }
}

async function handle(req: NextRequest): Promise<NextResponse> {
  if (!authed(req)) return adminUnauthorizedResponse();
  const startedAt = Date.now();
  const sb: any = supabaseAdmin;
  const out: Record<string, unknown> = {};

  // Start marker (deep-audit D6). The completion row below is written only if we
  // reach the end, so a maxDuration kill used to leave NO trace at all — the
  // failure mode that hid this route being dead for 9 days. Claim a row up front
  // and update it in place: one row per tick either way, and a tick that never
  // finishes stays ok=false with phase="started", which IS the alarm.
  let runId: number | string | null = null;
  try {
    const { data: startRow } = await sb
      .from("pipeline_runs")
      .insert({
        pipeline: PIPELINE,
        collection_slug: COLLECTION_SLUG,
        started_at: new Date(startedAt).toISOString(),
        // ⚠ finished_at MUST be set explicitly here, to started_at (2026-08-15).
        // `pipeline_runs.duration_ms` is GENERATED ALWAYS AS
        // (finished_at - started_at) and `finished_at` DEFAULTS TO now(), so a
        // marker that omits it publishes the latency of its OWN INSERT as the
        // run's duration. These rows read 147/176/185 ms — and a deep audit
        // took exactly that at face value, concluding the route "writes only
        // the start marker (duration_ms 147-176 ms)" and was dying instantly.
        // It is not: the route runs to its maxDuration (600s since the D6 raise
        // — which did NOT help) and is killed, the pre-existing failure mode
        // that produced the 313s/257s kills on 2026-07-28/29. Pinning
        // finished_at = started_at makes duration_ms 0 — an obvious sentinel
        // that cannot be mistaken for a measurement of the run, which is the
        // whole point of the marker. The real elapsed is written by the
        // completion update below, and only a run that COMPLETED has one.
        finished_at: new Date(startedAt).toISOString(),
        ok: false,
        error: "started (no completion recorded — killed at maxDuration?)",
        extra: { phase: "started" },
      })
      .select("id")
      .single();
    runId = startRow?.id ?? null;
  } catch {
    // Telemetry must never block the drain.
  }

  // Per-step wall-clock, surfaced in pipeline_runs.extra.step_ms. This route runs
  // close to its 300s maxDuration (313s/257s timeouts on 2026-07-28/29) and the only
  // signal on a timeout was a single duration_ms for nine steps — so "it timed out"
  // could not be turned into "which step". Additive: marks only, no step is
  // restructured. If a tick nears the ceiling, read step_ms and bound THAT step.
  //
  // ⚠ THAT INSTRUCTION WAS SELF-DEFEATING UNTIL 2026-08-15: `step_ms` was written
  // ONLY by the completion update at the very end, so on the one outcome it was
  // built for — a maxDuration kill — it was never persisted at all. The route has
  // been killed on every tick since 2026-07-31 and has therefore never once told
  // anyone which step overran. `mark()` now persists progressively, so a kill
  // leaves the completed steps and `last_step` on the marker row: the next tick
  // is diagnosable without waiting for a run that finishes.
  //
  // It never sets `finished_at`, so the marker keeps duration_ms = 0 (see the
  // insert above) and a killed run still reads as unfinished rather than timed.
  const stepMs: Record<string, number> = {};
  let stepT = Date.now();
  const mark = async (k: string) => {
    stepMs[k] = Date.now() - stepT;
    stepT = Date.now();
    if (runId == null) return;
    try {
      await sb
        .from("pipeline_runs")
        .update({ extra: { phase: "started", last_step: k, step_ms: { ...stepMs } } })
        .eq("id", runId);
    } catch {
      // Telemetry must never block the drain.
    }
  };

  // ── Step ORDER and a wall-clock budget guard (deep-audit R7, 2026-08-15) ────
  //
  // MEASURED, not inferred. The 2026-08-15 20:30Z tick was the first to carry the
  // progressive `mark()` from 80e99d4d, and it named the problem outright:
  //
  //   seed_conflated        16,946 ms
  //   seed_miskeyed        120,310 ms
  //   seed_recent          120,326 ms
  //   seed_knot_occupants  120,393 ms   (p_limit 200 — a tiny cap)
  //   onchain_resolve_trigger  430 ms
  //   last_step = onchain_resolve_trigger
  //
  // Three steps at ~120,3xx ms is not work, it is a CEILING: every one of these
  // functions carries `statement_timeout=120s` in its OWN proconfig (verified in
  // pg_proc; service_role's role-level timeout is 30s, so the 120s is the
  // function's). A statement that hits it ROLLS BACK — so those three steps burned
  // 361s of a 600s budget and produced NOTHING, and the route was then killed
  // before it ever reached the steps that do the work.
  //
  // The cost of that ordering was precise and large: `resolve_topshot_subedition_
  // collision_knots` (step 6) has not executed ONCE since 2026-07-31 20:33:53Z —
  // 76 resolutions ever, the newest stamped the exact minute of the last completed
  // run. Knots are the transposed-pair class that split/realign structurally
  // CANNOT fix, and they arrive at ~+8.3/night, so ~124 have accrued undrained.
  //
  // ⚠ The filed fix was "split the 6 steps so each writes its own row and commits
  // per step". That is a large restructure of TopShot keying — the thing every
  // edition-keyed FMV derives from — and it does not address the actual defect,
  // which is that the three steps that time out run FIRST and starve the rest.
  //
  // So: DRAIN before SEED, plus a budget guard.
  //   - The drain steps (3/4/4b/6/5) CONSUME what earlier ticks resolved; the
  //     seeds FEED later ticks. The header has always said so ("Steps 3-4 process
  //     what step 2 resolved on PRIOR ticks"), and step 6 "derives its own
  //     candidates and does not read this queue" (see the 1d note). There is no
  //     intra-tick seed -> drain dependency, so this reorder changes throughput,
  //     never correctness. Every step is idempotent and cursor-driven.
  //   - `knots` moves AHEAD of the conflation guard deliberately. The guard is a
  //     pure re-measurement and so is the cheapest thing to drop under pressure;
  //     leaving knots last is exactly what let 15 days of starvation read as
  //     normal operation. The guard now also re-measures AFTER the knot moves.
  //   - No step may START without room to hit its own 120s ceiling and still let
  //     the completion row be written. A skipped step is recorded in
  //     `extra.skipped_steps`, never dropped silently — this repo has paid for
  //     silent caps before.
  const BUDGET_MS = maxDuration * 1000;
  const TAIL_RESERVE_MS = 8_000;   // completion write + response
  const STEP_WORST_MS = 121_000;   // the functions' own statement_timeout + slack
  const skippedSteps: string[] = [];
  const elapsedMs = () => Date.now() - startedAt;
  const budgetFor = (worstMs: number) => elapsedMs() + worstMs + TAIL_RESERVE_MS <= BUDGET_MS;
  const step = async (name: string, worstMs: number, fn: () => Promise<void>): Promise<void> => {
    if (!budgetFor(worstMs)) { skippedSteps.push(name); return; }
    await fn();
    await mark(name);
  };

  // ── A by-design cutoff is not a failure (2026-08-18) ──────────────────────
  //
  // MEASURED, not inferred. The 08-15 reorder above WORKED: between the
  // diagnosis and 2026-08-17, `topshot_collision_knot_resolutions` went 76 -> 272
  // (196 of them in three days, after none for three weeks) and rows_written per
  // run went 0 -> ~1,000. No instrument could see it, because `ok` below is an
  // AND over EVERY step's error slot and several of these steps are EXPECTED to
  // be cut off at their own 120s `statement_timeout` ceiling — most reliably
  // `seed_recent`, plus `realign`, which is scan-bound and times out at any
  // p_limit. So an error slot was populated on essentially every tick and `ok`
  // was pinned FALSE forever. A pipeline that cannot report success is
  // indistinguishable from a broken one — here that hid a successful repair, and
  // it is what trains an operator to skim.
  //
  // Postgres cancels a statement that hits `statement_timeout` with SQLSTATE
  // 57014 and ROLLS IT BACK, so a truncated step produced nothing and the next
  // tick simply retries it. That is the budget design working, not a fault, and
  // it is recorded as such: named in `extra.truncated_steps`, message kept under
  // `<step>_truncated`, and NOT folded into `ok` — the same contract
  // `skipped_steps` already carries (visible, never silent, never red).
  //
  // ⛔ Do NOT instead drop a slot from the `ok` conjunction. That trades a false
  // negative for a false positive: a genuine seed failure would then report
  // success on the pipeline that keys TopShot editions — the thing every
  // edition-keyed FMV derives from. Only the timeout cancellation is
  // reclassified; every other error still populates its slot and still reds the
  // run, unchanged.
  //
  // ⚠ Read the ERROR STRING, not the duration: the Supabase gateway timeout and
  // this statement timeout are both ~2 minutes and mean different things, so the
  // match is on 57014 / the cancel text and nothing else. A gateway timeout is
  // NOT reclassified.
  //
  // Filed: docs/overnight/inbox/2026-08-17T2345Z-the-conflated-subedition-drain-fix-WORKED-and-its-ok-flag-hides-it.md
  const truncatedSteps: string[] = [];
  const isStatementTimeout = (err: any): boolean =>
    err?.code === "57014" ||
    /canceling statement due to statement timeout/i.test(String(err?.message ?? ""));
  // `errorKey` is passed explicitly rather than derived from `name` — four of the
  // slots (`seed_error`, `guard_error`, `knot_resolve_error`, `seed_knot_error`)
  // do not match their step name, and a derived key would silently write a slot
  // the `ok` conjunction never reads.
  const stepFailed = (name: string, errorKey: string, err: any): void => {
    const msg = err?.message ?? String(err);
    if (isStatementTimeout(err)) {
      truncatedSteps.push(name);
      out[errorKey.replace(/_error$/, "_truncated")] = msg;
      return;
    }
    out[errorKey] = msg;
  };

  try {
    // ── DRAIN ────────────────────────────────────────────────────────────────
    // Consume what step 2 resolved on PRIOR ticks. First, because this is where
    // every user-visible correction actually happens.

    // 3. Catalog base::subID editions for everything resolved so far.
    await step("catalog", STEP_WORST_MS, async () => {
      const { data: cataloged, error: cErr } = await sb.rpc(
        "catalog_topshot_subedition_editions_from_resolved", { p_limit: 1000 });
      if (cErr) stepFailed("catalog", "catalog_error", cErr); else out.cataloged = cataloged;
    });

    // 4. Split resolved parallels off the base onto their ::subID editions.
    //
    // p_limit 8000 -> 1000 (2026-08-15), and the number is MEASURED, not picked.
    // At 8000 this step ran 125,250 ms on the 08-15 tick and was killed at the
    // ceiling, so it ROLLED BACK and did nothing — it had been doing nothing
    // every night while looking like a step that ran. Timed against live data
    // (each probe rolled back so nothing committed):
    //     p_limit  100 -> 13,946 ms
    //     p_limit  500 -> 27,930 ms
    // which fits t(n) ~= 10,450 ms fixed + 34.96 ms/row, i.e. 8000 predicts
    // ~290 s — comfortably past the ceiling, exactly as observed. 1000 predicts
    // ~45 s, ~38% of the 120 s bound, leaving real headroom for the load swings
    // this instance has all day.
    //
    // ⚠ The ceiling is the GLOBAL statement_timeout (120,000 ms, source =
    // configuration file), NOT this function's own declaration. It declares
    // `statement_timeout=300s` in proconfig and died at ~125 s regardless —
    // one more confirmation that a function-level SET cannot raise the calling
    // statement's budget. Do not "fix" a future overrun by raising the proconfig.
    //
    // Walk this up from the observed `extra.step_ms.split`, never by guess, and
    // only with headroom — the same discipline the knots comment below states.
    await step("split", STEP_WORST_MS, async () => {
      const { data: split, error: sErr } = await sb.rpc(
        "remap_topshot_split_resolved_subeditions", { p_limit: 1000 });
      if (sErr) stepFailed("split", "split_error", sErr); else out.split = split;
    });

    // 4b. Inverse/cross realign — the direction the split can't do: re-key
    // moments/sales/wmc that are mis-keyed ONTO a ::N (on-chain says Standard or a
    // DIFFERENT parallel) back onto the correct edition. Collision-safe: a target
    // serial already held by another nft is a conflation knot, left for step 6.
    // Fixes the wrong-circulation moment-page display.
    //
    // ⚠ p_limit STAYS 8000 HERE, AND LOWERING IT WOULD BE THE WRONG DIRECTION.
    // The filed remedy was "drop split and realign 8000 -> ~1000". That is right
    // for split (measured above) and a no-op for this one — measured 2026-08-15:
    // this function TIMES OUT AT p_limit=100, never even building its candidate
    // set. The cancel names the statement, and the shape explains it: the
    // `LIMIT greatest(1, p_limit)` sits AFTER a `SELECT DISTINCT` over a
    // three-way UNION of full TopShot scans (moments ~292k + sales + wmc), so
    // the limit cannot bound the scan — it only trims an already-materialized
    // result. This step is SCAN-dominated, not row-dominated.
    //
    // Which means a smaller p_limit buys the identical cost and LESS work done.
    // Same tell was already visible in the 08-15 payload and was read past:
    // `seed_knot_occupants` hit the same ceiling at a p_limit of 200.
    //
    // ⚠ So do not read a future "realign missing from step_ms" as this fix
    // having failed — split and realign fail for different reasons and only
    // split's is a tuning problem. The real repair is to bound the DRIVING side
    // (drive from topshot_moment_subeditions with the LIMIT applied before the
    // union/joins) — a migration on TopShot keying, which every edition-keyed
    // FMV derives from, so it is deliberately NOT taken here. Filed:
    // docs/overnight/inbox/2026-08-15T2350Z-realign-is-scan-bound-not-row-bound.md
    //
    // It is left in place rather than skipped because it is not permanently
    // broken — it completed on 2026-07-31 with all four keys present, so it
    // succeeds in a quiet window and skipping it would delete a real correction
    // path to save time it only sometimes spends.
    await step("realign", STEP_WORST_MS, async () => {
      const { data: realign, error: rErr } = await sb.rpc(
        "remap_topshot_realign_miskeyed_subeditions", { p_limit: 8000 });
      if (rErr) stepFailed("realign", "realign_error", rErr); else out.realign = realign;
    });

    // 6. Resolve collision knots the realign/split can't (two moments transposed
    // onto each other's slot). Only acts on knots where BOTH nfts are
    // on-chain-resolved and both target editions exist — everything else waits for
    // a later tick. Serials preserved; every move logged to
    // topshot_collision_knot_resolutions.
    //
    // p_limit was 5 from 2026-07-06 (deliberately conservative while the in-place
    // permutation was new). Raised to 100 on 2026-07-31 because 5 is BELOW the
    // arrival rate, which made the blocked queue provably divergent rather than
    // merely slow: realign.collisions_skipped grew 833→840→849→858 over the four
    // retained runs (+8.3/night, monotonic) while this step cleared exactly 5.
    // Measured at the time: 1,441 knot candidates available, so the old cap needed
    // ~288 nights for a pool that was still growing.
    //
    // NOTE the LIMIT binds _knot_cand SELECTION, before the loop — so "resolved 5,
    // skipped 0" meant the cap bound selection at 5 and the defensive re-check
    // rejected none of those 5. It did NOT mean the resolver was uncapped and
    // starved of input by the step-1d seeder (that seeder feeds the on-chain
    // resolve path; this step derives its own candidates from moments +
    // topshot_moment_subeditions directly, and is not gated by it).
    //
    // Cost basis for 100: candidate selection is a FIXED ~1.83s regardless of
    // p_limit (dominated by parallel seq scans over moments ~292k and
    // topshot_moment_subeditions ~352k), and each knot is ~15 indexed single-row
    // statements, so 100 adds only a few seconds. Raise further only after
    // confirming there is still headroom in step_ms.
    await step("knots", STEP_WORST_MS, async () => {
      const { data: knots, error: kErr } = await sb.rpc("resolve_topshot_subedition_collision_knots", { p_limit: 100 });
      if (kErr) stepFailed("knots", "knot_resolve_error", kErr); else out.knots = knots;
    });

    // 5. Re-measure the conflation guard, AFTER the remaps above so it reflects
    // this tick's work rather than the previous one's.
    await step("conflation_guard", STEP_WORST_MS, async () => {
      const { data: guard, error: gErr } = await sb.rpc("refresh_topshot_conflated_editions_detector_only");
      if (gErr) stepFailed("conflation_guard", "guard_error", gErr); else out.conflated_editions_remaining = guard;
    });

    // ── SEED ─────────────────────────────────────────────────────────────────
    // Queue work for LATER ticks. Last, because these are the three that hit
    // their 120s ceiling and roll back: placed first they starved the drain for
    // 15 days; placed here, a seeder that times out costs only itself.

    // 1. Seed conflated-edition moments as pending subedition targets (advance across editions).
    await step("seed_conflated", STEP_WORST_MS, async () => {
      let seeded = 0;
      for (let i = 0; i < SEED_ROUNDS; i++) {
        // Each round can burn the function's full 120s ceiling, so re-check
        // between rounds — this loop's worst case is SEED_ROUNDS x 120s, which on
        // its own exceeds the entire budget.
        if (i > 0 && !budgetFor(STEP_WORST_MS)) { out.seed_rounds_short = i; break; }
        const { data, error } = await sb.rpc("seed_topshot_conflated_subedition_targets", {
          p_max_editions: SEED_EDITIONS_PER_ROUND,
        });
        if (error) { stepFailed("seed_conflated", "seed_error", error); break; }
        const got = typeof data === "number" ? data : 0;
        seeded += got;
        if (got === 0) break; // all editions seeded
      }
      out.seeded = seeded;
    });

    // 1b. Broaden coverage: also queue moments/sales already keyed to a ::N
    // subedition that the on-chain table hasn't resolved yet (their base need not
    // be in the conflation guard — the conflated-only seed above misses these).
    // Without this, a moment mis-keyed onto a ::N on a non-conflated edition never
    // gets on-chain-resolved and its wrong circulation never self-heals.
    await step("seed_miskeyed", STEP_WORST_MS, async () => {
      const { data: seededMis, error: smErr } = await sb.rpc("seed_topshot_miskeyed_subedition_targets", { p_limit: 5000 });
      if (smErr) stepFailed("seed_miskeyed", "seed_miskeyed_error", smErr); else out.seeded_miskeyed = seededMis;
    });

    // 1c. Proactively queue unresolved base nfts in the CURRENT parallel era (auto: newest 2
    // TS series). Closes the set-263 class of gap: a brand-new parallel set satisfies neither
    // seed above (no sales collision surfaced yet + no ::N editions exist), so it would never
    // get resolved on-chain and its parallels stay conflated onto base. This reaches every
    // current/new set without waiting for a collision; bounded + self-terminating.
    await step("seed_recent", STEP_WORST_MS, async () => {
      const { data: seededRecent, error: srErr } = await sb.rpc("seed_topshot_recent_base_subedition_targets", { p_limit: 15000 });
      if (srErr) stepFailed("seed_recent", "seed_recent_error", srErr); else out.seeded_recent = seededRecent;
    });

    // 1d. Queue the OCCUPANTS of collision knots that aren't on-chain-resolved yet.
    // A knot is two moments transposed onto each other's (edition,serial) slot; the
    // realign/split (4b/4) SKIP them because the target slot is held by the other nft.
    // Where the occupant's subedition is UNKNOWN, seed it so step 2 resolves it
    // on-chain and step 6 can permute on a later tick.
    //
    // ⚠ This is NOT the throughput gate for step 6, despite the numbering. Measured
    // 2026-07-31 over the 853 then-blocked nfts: the occupant already had a RESOLVED
    // subedition row in 841 (98.6%), so this seeder correctly skips them via its
    // NOT EXISTS gate and step 6 handles them directly — it derives its own
    // candidates and does not read this queue. Only ~12 were the unknown-occupant
    // case this seeder exists for. Its other two gates (occupant nft_id numeric,
    // occupant base int-keyed) excluded ZERO. So widening this predicate does not
    // move the blocked count; step 6's p_limit does.
    await step("seed_knot_occupants", STEP_WORST_MS, async () => {
      const { data: seededKnots, error: skErr } = await sb.rpc("seed_topshot_collision_knot_targets", { p_limit: 200 });
      if (skErr) stepFailed("seed_knot_occupants", "seed_knot_error", skErr); else out.seeded_knot_occupants = seededKnots;
    });

    // 2. Kick the on-chain subedition resolver for the pending queue. Its own 20s
    // abort bounds it, so it needs far less headroom than an RPC step.
    await step("onchain_resolve_trigger", 25_000, async () => {
      out.subedition_backfill_trigger = await triggerSubeditionBackfill();
    });
  } catch (err) {
    out.fatal = err instanceof Error ? err.message : String(err);
  }

  out.step_ms = stepMs;
  // A step the budget guard declined to start. NOT folded into `ok`: skipping is
  // the guard working as designed, and a chronically-red pipeline trains the
  // operator to skim past it (the cost already paid for with ufc_fmv_stale_hours).
  // But it must be VISIBLE — a silent cap reads as "we did all the work".
  out.skipped_steps = skippedSteps;
  // A step Postgres cancelled at its own statement_timeout. Same contract as
  // skipped_steps: NOT folded into `ok` (it rolled back and the next tick retries
  // it), but never silent — a truncation that vanished would read as "we did all
  // the work", and the count is the signal that says which ceiling to bound next.
  out.truncated_steps = truncatedSteps;
  const ok = !out.fatal && !out.seed_error && !out.seed_miskeyed_error && !out.seed_recent_error && !out.seed_knot_error && !out.catalog_error && !out.split_error && !out.realign_error && !out.guard_error && !out.knot_resolve_error;
  out.duration_ms = Date.now() - startedAt;

  const finishedRow = {
      pipeline: PIPELINE,
      collection_slug: COLLECTION_SLUG,
      started_at: new Date(startedAt).toISOString(),
      finished_at: new Date().toISOString(),
      rows_found: Number(out.seeded ?? 0),
      rows_written: Number((out.split as any)?.sales_split ?? 0) + Number((out.split as any)?.wmc_split ?? 0),
      rows_skipped: 0,
      ok,
      error: (out.fatal ?? out.seed_error ?? out.seed_miskeyed_error ?? out.seed_recent_error ?? out.seed_knot_error ?? out.catalog_error ?? out.split_error ?? out.realign_error ?? out.guard_error ?? out.knot_resolve_error ?? null) as string | null,
      extra: out,
  };
  try {
    // Update the marker when we have one; fall back to an insert if the marker
    // write failed, so a telemetry hiccup cannot lose the run entirely.
    if (runId != null) {
      await sb.from("pipeline_runs").update(finishedRow).eq("id", runId);
    } else {
      await sb.from("pipeline_runs").insert(finishedRow);
    }
  } catch { /* best-effort */ }

  return NextResponse.json({ ok, pipeline: PIPELINE, ...out });
}

export async function GET(req: NextRequest): Promise<NextResponse> { return handle(req); }
export async function POST(req: NextRequest): Promise<NextResponse> { return handle(req); }
