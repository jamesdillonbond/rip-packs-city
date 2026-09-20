// app/api/cron/panini-ingest/route.ts
//
// ⚠ THIS ROUTE IS LIVE AND IS THE WRITE PATH FOR A PUBLIC BOARD — do not read a silence
// here as expected. Its header said "SHIPPED 2026-07-16 as INERT infrastructure — receives
// nothing until the residential runner runs on Trevor's logged-in box. No cron wired." until
// 2026-08-16; that was true at ship and has been false since 2026-07-25, when the Windows
// Task Scheduler job went live. Measured 2026-08-16: 1,030 runs / 0 failures / 2,396 rows
// written, last tick 28 min before this edit, feeding 4,609 panini_editions + 26,990
// panini_fmv_snapshots — and `/insights/panini-squeeze` has been PUBLIC since the 2026-08-01
// PANINI_PUBLIC flip. The stale "inert / no cron wired" claim is exactly what would license a
// future session to dismiss a stall on this pipeline as by-design.
//
// The runner is NOT on a cron in this repo — it is the 5th scheduler (Trevor's residential
// box, every 4h on the hour at 01/05/09/13/17/21 UTC, in ~120-run bursts). So the liveness
// instrument is the `pipeline_cadence_watchlist` row (`panini-ingest`, is_active=true,
// max_silent_minutes=360, severity=info). ⚠ That severity is a KNOWN outstanding item, not an
// oversight to "fix" here: the row's own note says to raise it to medium/high at go-live, that
// was missed on 2026-08-01, and it is deliberately parked at info pending Trevor because the
// box drops ~15% of ticks by design and a chronically-red arm trains operators to skim past it.
//
// Tables applied via audit_20260716_panini_schema_inert. See docs/strategy/panini-roadmap-2026-07-16.md.
//
// PUSH ingest for Panini Plane-A: receives batches captured by the residential runner
// (scripts/ingest-panini-runner.mjs — the LIVE producer; the superseded draft under
// docs/drafts/panini/ carries a stale pack list and a psku format whose last two fields are
// swapped, so do not read the contract off it) and writes panini_editions /
// panini_pack_state / panini_fmv_snapshots. The runner does all auth + signing in a
// real logged-in browser; this route only normalizes + upserts (service-role).
//
// Body shape (all optional arrays):
//   { cards:   [ getCardMarketStats.data, ... ],
//     packs:   [ getPackMarketStats.data, ... ],
//     serials: [ getPskuTotalCardsList ...products, ... ],  // serials -> panini_card_serials (special serials)
//     sales:   [ nftSalesData records, ... ] }              // sales   -> last_sale_usd/_at on existing serials
//
// INERT-safe: empty body → logged no-op. Apply panini-schema.sql first.

import { NextRequest, NextResponse, after } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { writeInvocationHeartbeat } from "@/lib/pipeline/heartbeat";
import { toEditionRow, toFmvRow, toPackRow, toSerialRow, latestSalesBySku, isStrictIsoUtc } from "@/lib/chains/panini/ingest-normalize";
import { fetchAllPaged } from "@/lib/supabase-paginate";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const PIPELINE = "panini-ingest";
// The per-walk enumeration marker is logged under its OWN pipeline name, NEVER under PIPELINE.
// `detect_stalled_pipelines()` keys on `max(started_at) WHERE pipeline = w.pipeline`, and
// `panini-ingest` is on `pipeline_cadence_watchlist` (360 min, calibrated for the home box going
// dark). A marker written under the pipeline's own name refreshes `last_run` at the START of every
// walk, which would silence that arm on exactly the outage it exists to expose — a walk that
// enumerates and then dies captures nothing, yet would still look alive. Separating the names
// keeps the arm honest and gives a truth table: enum row + batch rows = healthy walk; enum row
// alone = enumerated then died; neither = the box never woke.
// Deliberately NOT added to the watchlist itself — it can only fire when the box is awake, so
// `panini-ingest` already covers the box-dark case and a second arm would double-page on it.
const PIPELINE_ENUM = "panini-ingest-enum";
const CHUNK = 500;
// Sale writes are per-sku UPDATEs (no batch form exists for row-varying values), so they run a
// few at a time — enough to keep the after() short, low enough not to crowd the pooler.
const SALES_CONCURRENCY = 8;

async function logRun(startedAtIso: string, found: number, written: number, ok: boolean, error: string | null, extra: any, pipeline: string = PIPELINE) {
  try {
    await (supabaseAdmin as any).rpc("log_pipeline_run", {
      p_pipeline: pipeline, p_started_at: startedAtIso, p_rows_found: found, p_rows_written: written, p_rows_skipped: 0,
      p_ok: ok, p_error: error, p_collection_slug: "panini_blockchain", p_cursor_before: null, p_cursor_after: null, p_extra: extra,
    });
  } catch (e) { console.log(`[${PIPELINE}] log failed: ${e instanceof Error ? e.message : String(e)}`); }
}

export async function POST(req: NextRequest) {
  // Accept either the INGEST or CRON secret (same dual-token posture as proxy.ts) so the
  // residential runner works whichever value the operator has on hand.
  const auth = req.headers.get("authorization") || "";
  const ingest = process.env.INGEST_SECRET_TOKEN;
  const cron = process.env.CRON_SECRET;
  const ok = (ingest && auth === `Bearer ${ingest}`) || (cron && auth === `Bearer ${cron}`);
  if (!ok) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const startedAtIso = new Date().toISOString();
  let body: any = {};
  try { body = await req.json(); } catch {}
  const cards: any[] = Array.isArray(body.cards) ? body.cards : [];
  const packs: any[] = Array.isArray(body.packs) ? body.packs : [];
  const serials: any[] = Array.isArray(body.serials) ? body.serials : [];
  const sales: any[] = Array.isArray(body.sales) ? body.sales : [];
  const found = cards.length + packs.length + serials.length + sales.length;
  // Per-walk enumeration telemetry (2026-08-15). The runner posts this ONCE per walk, before the
  // per-card walk, and it is the only DB-visible record of how much of the grid was enumerated.
  // Kept out of `found` deliberately: it describes the walk, it is not a row that was ingested,
  // and counting it would inflate rows_found on a payload that wrote nothing.
  const enumStats = body.enum && typeof body.enum === "object" && !Array.isArray(body.enum) ? body.enum : null;
  // The marker lands under PIPELINE_ENUM whether or not this payload also carries rows, so there
  // is exactly ONE place to query walk enumeration. Attaching it to the ingest row instead when
  // rows happen to be present would split the same telemetry across two pipelines, and a later
  // reader would have to know to union them.
  if (enumStats) await logRun(startedAtIso, 0, 0, true, null, { enum: enumStats }, PIPELINE_ENUM);
  if (!found) {
    if (enumStats) return NextResponse.json({ accepted: true, logged: "enum" }, { status: 202 });
    await logRun(startedAtIso, 0, 0, true, null, { skip: "empty" });
    return NextResponse.json({ accepted: false, skipped: "empty" }, { status: 202 });
  }

  after(async () => {
    // ⚠ THE INVOCATION MARKER, and this route is the fleet's worst remaining
    // margin: max(duration_ms) is 40,097 ms against a 60,000 ms wall — 67% —
    // over 3,501 runs in the 73 h `pipeline_runs` retains (measured 2026-09-02).
    // `try/catch` cannot catch a `maxDuration` kill, so without this row a tick
    // that crosses the wall is indistinguishable from the residential runner
    // never posting. ⚠ And the recorded 40 s max is CENSORED BY CONSTRUCTION: a
    // tick that crossed 60 s wrote nothing, so it is absent from the
    // distribution rather than at the top of it.
    //
    // Written INSIDE after(), not above it: the pre-`after` section is body
    // parsing only, and the empty-payload path returns early with its own
    // terminal row — a marker there would be an invocation that did no work.
    await writeInvocationHeartbeat({
      pipeline: PIPELINE,
      startedAtMs: Date.parse(startedAtIso),
      extra: { found, cards: cards.length, packs: packs.length, serials: serials.length, sales: sales.length },
    });
    let written = 0;
    // A failed WRITE must not render as a successful run (R120). These carried the
    // first error of each batch out to the pipeline_runs row: before 2026-09-20 a
    // rejected editions upsert was console.log-ged and the run still reported
    // ok=true, which is how a PK rewrite blocked by an FK ran unseen for 66 days
    // while silently discarding ~5% of the day's edition-walk records.
    let editionsError: string | null = null;
    let serialsError: string | null = null;
    let salesError: string | null = null;
    let salesErrors = 0;
    try {
      const nowIso = new Date().toISOString();
      // editions (dedup by external_id within the batch)
      const byKey = new Map<string, any>();
      for (const c of cards) { const r = toEditionRow(c, nowIso); if (r.external_id) byKey.set(r.external_id, r); }
      const editionRows = [...byKey.values()];
      for (let i = 0; i < editionRows.length; i += CHUNK) {
        const { data, error } = await (supabaseAdmin as any).from("panini_editions").upsert(editionRows.slice(i, i + CHUNK), { onConflict: "external_id,collection_id" }).select("id");
        if (error) { editionsError = editionsError ?? error.message; console.log(`[${PIPELINE}] editions upsert: ${error.message}`); } else written += data?.length ?? 0;
      }
      // fmv snapshots (delete-then-insert per edition; daily history intentional)
      const fmvRows = cards.map((c) => toFmvRow(c, nowIso)).filter(Boolean) as any[];
      if (fmvRows.length) {
        const ids = [...new Set(fmvRows.map((f) => f.edition_id))];
        for (let i = 0; i < ids.length; i += CHUNK) await (supabaseAdmin as any).from("panini_fmv_snapshots").delete().in("edition_id", ids.slice(i, i + CHUNK)).gte("computed_at", nowIso.slice(0, 10));
        for (let i = 0; i < fmvRows.length; i += CHUNK) await (supabaseAdmin as any).from("panini_fmv_snapshots").insert(fmvRows.slice(i, i + CHUNK));
      }
      // pack state
      if (packs.length) {
        const packRows = packs.map((p) => toPackRow(p, nowIso));
        await (supabaseAdmin as any).from("panini_pack_state").upsert(packRows, { onConflict: "id" });
      }
      // serials -> panini_card_serials (dedup by sku within the batch; upsert on sku)
      let serialsWritten = 0;
      if (serials.length) {
        const bySku = new Map<string, any>();
        for (const sp of serials) { const r = toSerialRow(sp, nowIso); if (r.sku && r.edition_external_id) bySku.set(r.sku, r); }
        const serialRows = [...bySku.values()];
        for (let i = 0; i < serialRows.length; i += CHUNK) {
          const { data, error } = await (supabaseAdmin as any).from("panini_card_serials").upsert(serialRows.slice(i, i + CHUNK), { onConflict: "sku" }).select("id");
          if (error) { serialsError = serialsError ?? error.message; console.log(`[${PIPELINE}] serials upsert: ${error.message}`); } else serialsWritten += data?.length ?? 0;
        }
      }
      // sales -> realized prices onto EXISTING serial rows (nftSalesData; see ingest-normalize).
      // UPDATE, never upsert: a sale record carries no edition_external_id/collection_id, so an
      // upsert on an unknown sku would fail the NOT NULLs (or worse, half-create a serial row).
      // A miss therefore means "we have not walked that serial yet", which sales_missed reports.
      let salesApplied = 0, salesMissed = 0;
      const latestSales = [...latestSalesBySku(sales).values()];
      for (let i = 0; i < latestSales.length; i += SALES_CONCURRENCY) {
        const slice = latestSales.slice(i, i + SALES_CONCURRENCY);
        const applied = await Promise.all(slice.map(async (s) => {
          const patch: Record<string, any> = { last_sale_usd: s.amount_usd };
          if (s.sold_at) patch.last_sale_at = s.sold_at;
          let q = (supabaseAdmin as any).from("panini_card_serials").update(patch).eq("sku", s.sku);
          // Monotonic guard: never walk a stored price BACKWARDS. nftSalesData pagination depth is
          // unmeasured, so an older page must not overwrite a newer sale. Only a strict ISO-UTC
          // stamp is interpolated into the .or() (isStrictIsoUtc); anything else writes uncondit-
          // ionally rather than shaping a filter from upstream text.
          if (isStrictIsoUtc(s.sold_at)) q = q.or(`last_sale_at.is.null,last_sale_at.lte.${s.sold_at}`);
          const { data, error } = await q.select("id");
          if (error) { salesErrors++; salesError = salesError ?? error.message; console.log(`[${PIPELINE}] sale update ${s.sku}: ${error.message}`); return -1; }
          return data?.length ?? 0;
        }));
        for (const n of applied) { if (n > 0) salesApplied += n; else if (n === 0) salesMissed++; }
      }
      // ok is now DERIVED from whether the writes actually landed, never asserted.
      // Each count is paired with its own _error field so a zero is readable: 0 with a
      // null error is "nothing to write", 0 with an error is "the write was rejected".
      const writeErrors = [
        editionsError ? `editions: ${editionsError}` : null,
        serialsError ? `serials: ${serialsError}` : null,
        salesError ? `sales: ${salesError}` : null,
      ].filter(Boolean) as string[];
      await logRun(startedAtIso, found, written, writeErrors.length === 0, writeErrors.length ? writeErrors.join(" | ") : null, {
        editions: written, editions_error: editionsError,
        fmv: fmvRows.length, packs: packs.length,
        serials: serialsWritten, serials_error: serialsError,
        sales_seen: sales.length, sales_serials: latestSales.length, sales_applied: salesApplied,
        sales_missed: salesMissed, sales_errors: salesErrors, sales_error: salesError,
      });
    } catch (e) {
      await logRun(startedAtIso, found, written, false, e instanceof Error ? e.message : String(e), {});
    }
  });
  return NextResponse.json({ accepted: true, cards: cards.length, packs: packs.length, serials: serials.length, sales: sales.length }, { status: 202 });
}

// ---------------------------------------------------------------------------------------------
// GET — the walk ORDER the residential runner should use. Added 2026-09-19 (Cowork cloud).
//
// WHY THIS EXISTS. scripts/ingest-panini-runner.mjs shuffled its enumerated psku list
// (Fisher-Yates) on every run and stopped at a 50-minute wall-clock budget, so each walk was an
// INDEPENDENT UNIFORM SAMPLE of the catalogue. That is a coupon-collector draw, and its tail is
// not a bug that fires — it is a set of editions that keep losing the lottery. Measured live
// 2026-09-19 with the pipeline at 2,103 runs / 0 failures over 72 h:
//
//   1,265 of 5,071 editions (24.9%) last walked 45+ days ago · p50 age 276 h · p90 1,384 h
//   only 1,671 (32.9%) walked at all in the last 7 days
//   ~1,300–2,000 edition-WRITES per day against ~686 DISTINCT editions — i.e. ~2–3x re-walk
//
// A green pipeline whose work silently never reaches a quarter of its population is this repo's
// documented silent-failure shape (docs/reference/known-issues.md), and it is why Panini coverage
// has fallen 37.9% -> 36.2% -> 35.3% trustworthy while nothing failed.
//
// THE FIX IS THE ORDER, NOT THE THROUGHPUT. Walking oldest-first spends the SAME budget on
// DISTINCT editions instead of re-drawing fresh ones, which turns an unbounded random tail into a
// bounded round-robin: at today's ~1,300–2,000 writes/day the whole catalogue is covered in ~3
// days. The shuffle's stated purpose — "if a run stalls partway, successive runs cover DIFFERENT
// subsets" — is something staleness order gives for free and strictly better: a stalled run
// leaves the STALEST editions un-walked, so the next run resumes exactly there.
//
// ⚠ The runner FALLS BACK to its old shuffle if this endpoint is unreachable. That is deliberate:
// degrading to today's behaviour is acceptable, degrading to a fixed enumeration order would be
// worse than what we have.
//
// ⚠ THIS RETURNS THE WHOLE CATALOGUE, AND THE FIRST VERSION RETURNING ONLY THE STALEST 1,000
// WAS WRONG IN A WAY THAT WOULD HAVE BLUNTED THE FIX IT SHIPPED FOR. The runner classifies an
// enumerated psku as a BRAND-NEW discovery when it is absent from this response, and walks those
// first (a card with no row has no price at all). With a truncated list, every edition that is in
// our catalogue but NOT among the stalest 1,000 — i.e. every RECENTLY WALKED one — reads as
// "brand new" and gets promoted to the FRONT of the queue. The grid surfaces the most actively
// listed cards, which are exactly the ones walked most recently, so that misclassification would
// have put hundreds of already-fresh editions ahead of the stale backlog. ⭐ The lesson: an
// "absent from the list" test is only as good as the list's COMPLETENESS, and a bound chosen for
// the reader's convenience silently redefines what absence means.
//
// PostgREST CLAMPS any .limit() above 1,000 with no error (known-issues #71), so completeness
// here requires paging — `fetchAllPaged` is the one place that workaround lives. `truncated` is
// forwarded rather than swallowed, and the runner degrades to a safe ordering when it is true.
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") || "";
  const ingest = process.env.INGEST_SECRET_TOKEN;
  const cron = process.env.CRON_SECRET;
  const authed = (ingest && auth === `Bearer ${ingest}`) || (cron && auth === `Bearer ${cron}`);
  if (!authed) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const sp = new URL(req.url).searchParams;
  // Optional trim for a probe (`?limit=5`). Omitted = the whole catalogue, which is what the
  // runner must have; see the completeness note above before reintroducing a default bound.
  const trim = Number(sp.get("limit")) > 0 ? Number(sp.get("limit")) : null;

  // nullsFirst: an edition row with a NULL last_seen_at has never been recorded as walked, so it
  // is maximally stale, not minimally. The .order() is also what makes paging safe — an unordered
  // paged read can duplicate a row on one page and drop it from another.
  const paged = await fetchAllPaged<{ external_id: string; last_seen_at: string | null }>(
    (from, to) =>
      (supabaseAdmin as any)
        .from("panini_editions")
        .select("external_id,last_seen_at")
        .order("last_seen_at", { ascending: true, nullsFirst: true })
        .order("external_id", { ascending: true })
        .range(from, to),
    { pageSize: 1000, maxPages: 20, label: `${PIPELINE}/walk-order` },
  );

  if (paged.error) {
    // Fail LOUD but non-fatal: the runner treats any non-200 as "use the shuffle".
    console.error(`[${PIPELINE}] walk-order read failed: ${paged.error}`);
    return NextResponse.json({ error: "walk_order_unavailable" }, { status: 503 });
  }

  const rows = trim ? paged.rows.slice(0, trim) : paged.rows;
  return NextResponse.json({
    as_of: new Date().toISOString(),
    order: "last_seen_at_asc",
    count: rows.length,
    // ⚠ Load-bearing for correctness, not diagnostics: the runner may only treat "absent from
    // pskus" as "brand new" when this is false AND nothing was trimmed. See the note above.
    complete: !paged.truncated && !trim,
    truncated: paged.truncated,
    // The age of the two ends, so a reader of this response can tell a healthy rotation from a
    // stalled one without a second query.
    oldest_last_seen_at: rows[0]?.last_seen_at ?? null,
    newest_returned_last_seen_at: rows[rows.length - 1]?.last_seen_at ?? null,
    pskus: rows.map((r) => r.external_id),
  });
}
