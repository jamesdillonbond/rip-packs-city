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
import { toEditionRow, toFmvRow, toFmvRowV11, toFmvRowV12, toPackRow, toSerialRow, latestSalesBySku, isStrictIsoUtc, pskuSetId } from "@/lib/chains/panini/ingest-normalize";
import { fetchAllPaged } from "@/lib/supabase-paginate";
import { parseStall } from "@/lib/chains/panini/stall-report";

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
// One panini_sales_ingest call per this many raw sale records (one set-based statement each).
const SALES_HISTORY_CHUNK = 2000;

type RecentFmvRpc = {
  rpc: (fn: "panini_recent_sales_fmv", args: { p_edition_ids: string[] }) => Promise<{
    data: Array<{ edition_id: string; fmv_usd: number | string; n_recent: number }> | null;
    error: { message?: string } | null;
  }>;
};
type LastFmvRpc = {
  rpc: (fn: "panini_last_sales_fmv", args: { p_edition_ids: string[] }) => Promise<{
    data: Array<{ edition_id: string; fmv_usd: number | string; n_sales: number }> | null;
    error: { message?: string } | null;
  }>;
};

// ── MULTI-PRODUCT (2026-09-28) ────────────────────────────────────────────────────────────────
// Panini sells many card products; until today this plane walked ONE (WC Prizm, setId 2332) and
// every board assumed it. `panini_products` is the registry: the runner reports every setId its
// grid walks see (POST `products`), and `walk_cards=true` is what admits a product's cards to
// panini_editions / _card_serials / _fmv_snapshots. Phase 1 admits only 2332, because every Panini
// board and the pack-EV model still read those tables as "the WC catalogue" — a WNBA card written
// there today would be averaged into WC's pack EV and listed on WC's boards. Product scoping of those
// readers is Phase 2; flipping walk_cards before it lands is the substitution defect by another door.
//
// ⚠ FAIL CLOSED TO THE HISTORICAL SCOPE. If the registry read fails, only 2332 is admitted (what
// this route has always written) and the run reports `products_error` — never "admit everything".
const PANINI_LEGACY_SET_ID = 2332;
const PANINI_BOOTSTRAP_HOURS = 12;
// AGED PRIORITY (2026-10-03): catalogue editions not walked for this long are served in
// `priority_pskus` (stalest first, at most PANINI_AGED_PRIORITY_CAP per run). See the GET below.
const PANINI_AGED_PRIORITY_DAYS = 5;
const PANINI_AGED_PRIORITY_CAP = 300;

// The marketplace grid is filtered by `?sport=<value>` and the runner enumerates each value below.
// "Soccer" is the only value verified live (2026-07-16). The others are the marketplace's sport
// names as best known; a value the site does not recognise shows up as grid_items=0 (or the
// unfiltered grid) in that sport's `panini-ingest-enum` marker — read it before assuming coverage.
// Override without a code change: PANINI_DISCOVERY_SPORTS="Soccer,Basketball,…" on Vercel.
// "WNBA" was tried 2026-09-29 and removed the same day: the 10:10 AM PT walk's "WNBA" grid served
// the same setIds as Basketball (the filter value is not recognised), so it only cost 3 minutes.
// "Womens Basketball" added 2026-09-29 PT: Panini's own packDetails tags the WNBA packs (1055/1056)
// sport "WOMENS BASKETBALL", the way the WC packs are "SOCCER" ↔ the verified "Soccer" filter. If
// its grid serves the Basketball setIds too (~55+), the value is not recognised either — remove it.
const PANINI_DISCOVERY_SPORTS = ["Soccer", "Basketball", "Womens Basketball", "Football", "Baseball"];
function discoverySports(): string[] {
  const env = (process.env.PANINI_DISCOVERY_SPORTS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return env.length ? env : PANINI_DISCOVERY_SPORTS;
}

type ProductRow = {
  set_id: number; name: string | null; walk_cards: boolean; last_grid_sport?: string | null;
  last_grid_items?: number | null; walk_cards_since?: string | null;
};
async function readProducts(): Promise<{ rows: ProductRow[]; error: string | null }> {
  try {
    const { data, error } = await (supabaseAdmin as any).from("panini_products").select("set_id,name,walk_cards,last_grid_sport,last_grid_items,walk_cards_since");
    if (error) return { rows: [], error: error.message ?? String(error) };
    return { rows: (data ?? []) as ProductRow[], error: null };
  } catch (e) {
    return { rows: [], error: e instanceof Error ? e.message : String(e) };
  }
}

const PANINI_HOST = "https://nft.paniniamerica.net/";
// Diagnostic JSON from the runner is stored as-is only while small: a runaway payload is replaced by
// a marker saying it was dropped, never truncated into something that parses as a smaller truth.
function boundedJson(v: unknown, maxChars: number): unknown {
  try { return JSON.stringify(v).length <= maxChars ? v : { dropped: "over size bound", max_chars: maxChars }; }
  catch { return { dropped: "not serialisable" }; }
}
// A pack page URL is only ever a Panini URL. The runner harvests links from pages it visits, so the
// host check is what keeps an off-site link from becoming a page the next walk navigates to.
function packPageUrl(u: unknown): string | null {
  if (typeof u !== "string") return null;
  const s = u.trim().split("#")[0];
  return s.startsWith(PANINI_HOST) && s.length <= 500 ? s : null;
}

// products: [{ set_id, sport, grid_items }] — one per setId a sport's grid served this walk.
// pack_pages: [{ url, discovered?, walked?, captured?, pack_id? }].
// New products land with walk_cards=false (the column default) — discovery never admits a product.
// An existing product's name / walk_cards / note are never touched here; only the sighting fields.
async function upsertRegistry(products: any[], packPages: any[], nowIso: string) {
  const errors: string[] = [];
  let written = 0;
  const extra: Record<string, unknown> = {};
  const db = supabaseAdmin as any;

  const prodRows = new Map<number, Record<string, unknown>>();
  for (const p of products) {
    const sid = Number(p?.set_id);
    if (!Number.isInteger(sid) || sid <= 0) continue;
    const prev = prodRows.get(sid);
    const items = Number.isFinite(+p?.grid_items) ? +p.grid_items : null;
    // One setId can appear under two sports' grids; keep the sighting with more items.
    if (prev && (prev.last_grid_items as number | null ?? -1) >= (items ?? -1)) continue;
    const row: Record<string, unknown> = { set_id: sid, last_seen_at: nowIso, last_grid_items: items, last_grid_sport: typeof p?.sport === "string" ? p.sport.slice(0, 40) : null };
    // Identification evidence (panini_products.sample). Only a small plain object is kept; anything
    // else is dropped rather than stored, and an absent sample never erases the previous one.
    if (p?.sample && typeof p.sample === "object" && !Array.isArray(p.sample)) row.sample = boundedJson(p.sample, 2000);
    prodRows.set(sid, row);
  }
  if (prodRows.size) {
    const { data, error } = await db.from("panini_products").upsert([...prodRows.values()], { onConflict: "set_id" }).select("set_id");
    if (error) errors.push(`products: ${error.message}`);
    else { written += data?.length ?? 0; extra.products = data?.length ?? 0; }
  }
  extra.products_offered = prodRows.size;

  const discovered = new Set<string>();
  const results: { url: string; walked: boolean; captured: boolean; pack_id: string | null; ops: unknown; pack_like: unknown }[] = [];
  for (const pg of packPages) {
    const url = packPageUrl(pg?.url);
    if (!url) continue;
    if (pg?.discovered) discovered.add(url);
    if (pg?.walked) results.push({
      url, walked: true, captured: pg?.captured === true, pack_id: typeof pg?.pack_id === "string" ? pg.pack_id.slice(0, 120) : null,
      ops: pg?.ops && typeof pg.ops === "object" && !Array.isArray(pg.ops) ? boundedJson(pg.ops, 4000) : undefined,
      pack_like: pg?.pack_like && typeof pg.pack_like === "object" && !Array.isArray(pg.pack_like) ? boundedJson(pg.pack_like, 4000) : pg?.pack_like === null ? null : undefined,
    });
  }
  if (discovered.size) {
    // ignoreDuplicates: a discovered link never overwrites a seeded/manual row's source or enabled flag.
    const { data, error } = await db.from("panini_pack_pages")
      .upsert([...discovered].map((url) => ({ url, source: "discovered" })), { onConflict: "url", ignoreDuplicates: true })
      .select("url");
    if (error) errors.push(`pack_pages discovered: ${error.message}`);
    else { written += data?.length ?? 0; extra.pack_pages_new = data?.length ?? 0; }
  }
  extra.pack_pages_discovered = discovered.size;
  let walkedWritten = 0;
  for (const r of results) {
    const patch: Record<string, unknown> = { last_walked_at: nowIso };
    // Visit evidence (what the page fired; the first pack-shaped object from any op). Written only
    // when the runner sent it, so an older runner never blanks the last reading.
    if (r.ops !== undefined) patch.last_ops = r.ops;
    if (r.pack_like !== undefined) patch.last_pack_like = r.pack_like;
    if (r.captured) { patch.last_captured_at = nowIso; if (r.pack_id) patch.last_pack_id = r.pack_id; }
    const { data, error } = await db.from("panini_pack_pages").update(patch).eq("url", r.url).select("url");
    if (error) { errors.push(`pack_pages walked: ${error.message}`); break; }
    walkedWritten += data?.length ?? 0;
  }
  written += walkedWritten;
  extra.pack_pages_walked = results.length;
  extra.pack_pages_captured = results.filter((r) => r.captured).length;
  extra.pack_pages_walk_written = walkedWritten;
  return { written, errors, extra };
}

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
  // Multi-product discovery (2026-09-28): the setIds each sport's grid served, and the pack pages
  // the walk found or visited. Both are registry upkeep, not ingested rows, so they stay out of
  // `found` — same reasoning as `enum` below.
  const products: any[] = Array.isArray(body.products) ? body.products : [];
  const packPages: any[] = Array.isArray(body.pack_pages) ? body.pack_pages : [];
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
  // Registry upkeep runs inline (two small writes) and reports under PIPELINE_ENUM, the walk's
  // telemetry pipeline — a discovery payload is not an ingest tick and must not refresh
  // `panini-ingest`'s liveness arm (see PIPELINE_ENUM above).
  // Runner watchdog report (2026-10-03, scripts/panini-stall-watchdog.mjs). "stall" = the runner
  // hung (ticks on time, no progress) and is exiting: a failed walk, so ok=false with the phase it
  // hung in. "slept" = the PC's clock jumped mid-run; the walk carries on, so it is recorded, not
  // failed. Without this the two are indistinguishable from here — both are just silence.
  const stall = parseStall(body.stall);
  if (stall) {
    const where = `phase=${stall.phase}${stall.detail ? ` (${stall.detail})` : ""}`;
    await logRun(startedAtIso, 0, 0, stall.kind !== "stall",
      stall.kind === "stall" ? `runner hung: no progress for ${stall.minutes} min in ${where}; exited` : null,
      { stall }, PIPELINE_ENUM);
  }
  if (products.length || packPages.length) {
    const reg = await upsertRegistry(products, packPages, startedAtIso);
    await logRun(startedAtIso, products.length + packPages.length, reg.written, reg.errors.length === 0,
      reg.errors.length ? reg.errors.join(" | ") : null, { registry: reg.extra }, PIPELINE_ENUM);
  }
  if (!found) {
    if (enumStats || stall || products.length || packPages.length) return NextResponse.json({ accepted: true, logged: "discovery" }, { status: 202 });
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
    let fmvError: string | null = null;
    let fmvWritten = 0;
    let packsError: string | null = null;
    let productsError: string | null = null;
    let packIdMapError: string | null = null;
    try {
      const nowIso = new Date().toISOString();
      // PRODUCT GATE (see MULTI-PRODUCT above). Resolve which setIds may be written, and the
      // pack-name -> setId map, once per batch.
      const prod = await readProducts();
      productsError = prod.error;
      const admitted = new Set<number>(prod.error ? [PANINI_LEGACY_SET_ID] : prod.rows.filter((r) => r.walk_cards).map((r) => Number(r.set_id)));
      const setIdByName = new Map<string, number>();
      for (const r of prod.rows) if (r.name) setIdByName.set(r.name.trim().toLowerCase(), Number(r.set_id));
      const skippedBySet: Record<string, number> = {};
      const admit = (key: unknown) => {
        const sid = pskuSetId(key);
        if (sid !== null && admitted.has(sid)) return true;
        const k = sid === null ? "unparsed" : String(sid);
        skippedBySet[k] = (skippedBySet[k] || 0) + 1;
        return false;
      };
      const cardsIn = cards.filter((c) => admit(c?.psku ?? c?.sku));
      const serialsIn = serials.filter((s) => admit(s?.psku ?? s?.sku ?? s?.url_key));
      const salesIn = sales.filter((s) => admit(s?.url_key ?? s?.sku));
      // editions (dedup by external_id within the batch)
      const byKey = new Map<string, any>();
      for (const c of cardsIn) { const r = toEditionRow(c, nowIso); if (r.external_id) byKey.set(r.external_id, r); }
      const editionRows = [...byKey.values()];
      for (let i = 0; i < editionRows.length; i += CHUNK) {
        const { data, error } = await (supabaseAdmin as any).from("panini_editions").upsert(editionRows.slice(i, i + CHUNK), { onConflict: "external_id,collection_id" }).select("id");
        if (error) { editionsError = editionsError ?? error.message; console.log(`[${PIPELINE}] editions upsert: ${error.message}`); } else written += data?.length ?? 0;
      }
      // pack state. R120 second pass: this was the last write in the function with NO error
      // binding at all — `await …upsert(...)` with nothing destructured, so the failure was
      // unreadable by construction rather than merely unlogged, and `packs` published
      // packs.length (rows OFFERED) beside three counts that had just been made honest.
      let packsWritten = 0;
      if (packs.length) {
        // product_set_id from the registry by the pack's published product name. When the registry
        // read FAILED the key is dropped from the row rather than written null: a null would flip a
        // modeled pack (WC 1038/1039) to "not modeled" on the strength of a read error.
        // ONE PRODUCT, ONE ROW. The same pack can be captured from a marketplace-details subpack
        // page (id = the numeric pack id in its URL, e.g. 1038) and from a /pack-<name>.html page
        // (no numeric id -> pack_sku). Without this a second row would appear on the Packs tab for
        // the same product. An existing row with the same raw.pack_sku keeps its id.
        const idBySku = new Map<string, string>();
        {
          const { data: ex, error: exErr } = await (supabaseAdmin as any).from("panini_pack_state").select("id,pack_sku:raw->>pack_sku");
          if (exErr) { packIdMapError = exErr.message; console.log(`[${PIPELINE}] pack id map read: ${exErr.message}`); }
          for (const e of (ex ?? []) as { id: string; pack_sku: string | null }[]) if (e.pack_sku) idBySku.set(String(e.pack_sku), String(e.id));
        }
        const packRowsAll = packs.map((p) => {
          const name = typeof p?.collection_name === "string" ? p.collection_name.trim().toLowerCase() : "";
          const row: Record<string, unknown> = toPackRow(p, nowIso, setIdByName.get(name) ?? null);
          if (prod.error) delete row.product_set_id;
          const existing = typeof p?.pack_sku === "string" ? idBySku.get(p.pack_sku) : undefined;
          if (existing && existing !== row.id) row.id = existing;
          return row;
        });
        // One row per id (the latest capture wins): an upsert may not touch the same row twice.
        const packRows = [...new Map(packRowsAll.map((r) => [String(r.id), r])).values()];
        const { data, error } = await (supabaseAdmin as any).from("panini_pack_state").upsert(packRows, { onConflict: "id" }).select("id");
        if (error) { packsError = error.message; console.log(`[${PIPELINE}] pack state upsert: ${error.message}`); } else packsWritten += data?.length ?? 0;
      }
      // serials -> panini_card_serials (dedup by sku within the batch; upsert on sku)
      let serialsWritten = 0;
      if (serialsIn.length) {
        const bySku = new Map<string, any>();
        for (const sp of serialsIn) { const r = toSerialRow(sp, nowIso); if (r.sku && r.edition_external_id) bySku.set(r.sku, r); }
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
      const latestSales = [...latestSalesBySku(salesIn).values()];
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
      // sales -> panini_sales, EVERY record (2026-09-28, migration 20260929020655). The block above
      // keeps only the newest sale per card; this keeps the history — the Top-20 and Recent-20 lists
      // the runner reads per edition — deduplicated on (sku, sold_at). Records the runner tagged
      // with the list they came from (`__list`, `__page_size`) also move each edition's coverage
      // (panini_sales_reads.complete_since). Counts are what the RPC says it WROTE.
      let salesHistNew = 0, salesHistRefreshed = 0, salesHistReads = 0, salesHistGaps = 0, salesHistValid = 0;
      let salesHistError: string | null = null;
      for (let i = 0; i < salesIn.length; i += SALES_HISTORY_CHUNK) {
        const { data, error } = await (supabaseAdmin as any).rpc("panini_sales_ingest", { p_records: salesIn.slice(i, i + SALES_HISTORY_CHUNK) });
        const d = (data ?? null) as Record<string, unknown> | null;
        if (error || !d || typeof d.stored_new !== "number") {
          salesHistError = salesHistError ?? (error?.message ?? "panini_sales_ingest returned no write count");
          console.log(`[${PIPELINE}] sales history: ${salesHistError}`);
          continue;
        }
        salesHistNew += Number(d.stored_new) || 0;
        salesHistRefreshed += Number(d.refreshed) || 0;
        salesHistReads += Number(d.recent_reads) || 0;
        salesHistGaps += Number(d.gaps_now) || 0;
        salesHistValid += Number(d.valid) || 0;
      }
      // fmv snapshots (delete-then-insert per edition; daily history intentional).
      // R120: `fmv` used to report fmvRows.length — rows OFFERED, reported under a name that
      // reads as rows written — and NEITHER the delete nor the insert had its error read at all.
      // `edition_id` is the same upstream sku that keys panini_editions, so these writes sit
      // behind the same FK that was aborting the editions upsert; a count that cannot go down
      // when the write fails is not a measurement. `fmv` is now WRITTEN, `fmv_offered` is the
      // batch size, and their disagreement is itself readable.
      // FMV ENGINE (2026-09-24): panini-1.1.0 prices from the edition's own RECENT realized sales
      // (panini_recent_sales_fmv; see toFmvRowV11 for the measured case), so this block now runs AFTER
      // the sales writes above — this batch's sales count. PANINI_FMV_ENGINE=1.0 reverts to the
      // lifetime-average toFmvRow. If the recent-sales read fails the batch falls back to 1.0.0 rows,
      // which say so in algo_version, AND the run reports fmv_recent_error (ok=false): a silent
      // engine downgrade is exactly the failure a reader of these prices could not see.
      // FMV ENGINE 1.2 (2026-09-30, Trevor approved): the LOW tier (sales exist, none in 30 d) prices
      // at the median of the edition's last <=3 sales at ANY age (panini_last_sales_fmv), read only
      // for editions the 30-day read did not price. PANINI_FMV_ENGINE=1.1 or =1.0 are kill switches.
      // A failed last-sales read falls back to 1.1.0 rows (which say so) AND fails the run.
      const FMV_ENGINE = process.env.PANINI_FMV_ENGINE === "1.0" ? "1.0" : process.env.PANINI_FMV_ENGINE === "1.1" ? "1.1" : "1.2";
      let fmvRecentError: string | null = null;
      let fmvLastError: string | null = null;
      const recentByEdition = new Map<string, { fmv_usd: number; n_recent: number }>();
      const lastByEdition = new Map<string, { fmv_usd: number; n_sales: number }>();
      if (FMV_ENGINE !== "1.0" && cardsIn.length) {
        const ids = [...new Set(cardsIn.map((c) => String(c?.sku ?? c?.psku ?? "")).filter(Boolean))];
        const { data: rec, error: recErr } = await (supabaseAdmin as unknown as RecentFmvRpc).rpc("panini_recent_sales_fmv", { p_edition_ids: ids });
        if (recErr) { fmvRecentError = recErr.message ?? String(recErr); console.log(`[${PIPELINE}] recent-sales fmv: ${fmvRecentError}`); }
        else for (const r of rec ?? []) recentByEdition.set(String(r.edition_id), { fmv_usd: Number(r.fmv_usd), n_recent: Number(r.n_recent) });
        const lowIds = ids.filter((id) => !recentByEdition.has(id));
        if (FMV_ENGINE === "1.2" && !fmvRecentError && lowIds.length) {
          const { data: last, error: lastErr } = await (supabaseAdmin as unknown as LastFmvRpc).rpc("panini_last_sales_fmv", { p_edition_ids: lowIds });
          if (lastErr) { fmvLastError = lastErr.message ?? String(lastErr); console.log(`[${PIPELINE}] last-sales fmv: ${fmvLastError}`); }
          else for (const r of last ?? []) lastByEdition.set(String(r.edition_id), { fmv_usd: Number(r.fmv_usd), n_sales: Number(r.n_sales) });
        }
      }
      const useV11 = FMV_ENGINE !== "1.0" && !fmvRecentError;
      const useV12 = useV11 && FMV_ENGINE === "1.2" && !fmvLastError;
      // ONE row per edition per batch (2026-09-30). A card can arrive twice in one walk batch (the
      // multi-product walk serves the same psku from the held queue AND the grid); each copy became
      // its own row with the same computed_at, which the supersede-delete (computed_at < nowIso)
      // cannot remove — 2 such duplicate pairs in panini_fmv_snapshots 09-29/30. Last copy wins,
      // matching the editions upsert's byKey above.
      const fmvRows = [...new Map((cardsIn
        .map((c) => {
          const k = String(c?.sku ?? c?.psku ?? "");
          if (useV12) return toFmvRowV12(c, nowIso, recentByEdition.get(k), lastByEdition.get(k));
          return useV11 ? toFmvRowV11(c, nowIso, recentByEdition.get(k)) : toFmvRow(c, nowIso);
        })
        .filter(Boolean) as any[]).map((r) => [String(r.edition_id), r])).values()];
      // INSERT FIRST, then delete the SAME-DAY rows this insert supersedes (computed_at < nowIso; the
      // new rows carry computed_at = nowIso exactly). Until 2026-09-25 this was delete-then-insert,
      // and a batch whose insert failed ("TypeError: fetch failed", 6:36 AM PT) had already deleted
      // today's rows — two editions silently fell back to a 3-day-old panini-1.0.0 price. A failed
      // insert now deletes nothing. A failed delete leaves an OLDER same-day row beside the new one —
      // harmless to latest-per-edition readers. Only a later SAME-DAY walk of that edition removes it
      // (the delete is bounded to [today, nowIso)); otherwise it stays as history, and fmv_error says so.
      if (fmvRows.length) {
        for (let i = 0; i < fmvRows.length; i += CHUNK) {
          const chunk = fmvRows.slice(i, i + CHUNK);
          const { data, error } = await (supabaseAdmin as any).from("panini_fmv_snapshots").insert(chunk).select("id");
          if (error) { fmvError = fmvError ?? error.message; console.log(`[${PIPELINE}] fmv insert: ${error.message}`); continue; }
          fmvWritten += data?.length ?? 0;
          const ids = [...new Set(chunk.map((f) => f.edition_id))];
          const { error: delErr } = await (supabaseAdmin as any).from("panini_fmv_snapshots").delete().in("edition_id", ids).gte("computed_at", nowIso.slice(0, 10)).lt("computed_at", nowIso);
          if (delErr) { fmvError = fmvError ?? `delete: ${delErr.message}`; console.log(`[${PIPELINE}] fmv delete: ${delErr.message}`); }
        }
      }
      // ok is now DERIVED from whether the writes actually landed, never asserted.
      // Each count is paired with its own _error field so a zero is readable: 0 with a
      // null error is "nothing to write", 0 with an error is "the write was rejected".
      const writeErrors = [
        editionsError ? `editions: ${editionsError}` : null,
        serialsError ? `serials: ${serialsError}` : null,
        fmvError ? `fmv: ${fmvError}` : null,
        fmvRecentError ? `fmv_recent: ${fmvRecentError}` : null,
        fmvLastError ? `fmv_last: ${fmvLastError}` : null,
        packsError ? `packs: ${packsError}` : null,
        packIdMapError ? `pack id map (a pack seen under a new page may have written a duplicate row): ${packIdMapError}` : null,
        productsError ? `products (gate fell back to ${PANINI_LEGACY_SET_ID} only): ${productsError}` : null,
        salesError ? `sales: ${salesError}` : null,
        salesHistError ? `sales_history: ${salesHistError}` : null,
      ].filter(Boolean) as string[];
      await logRun(startedAtIso, found, written, writeErrors.length === 0, writeErrors.length ? writeErrors.join(" | ") : null, {
        editions: written, editions_error: editionsError,
        fmv: fmvWritten, fmv_offered: fmvRows.length, fmv_error: fmvError,
        fmv_engine: useV12 ? "panini-1.2.0" : useV11 ? "panini-1.1.0" : "panini-1.0.0", fmv_recent_error: fmvRecentError, fmv_recent_hits: recentByEdition.size,
        fmv_last_error: fmvLastError, fmv_last_hits: lastByEdition.size,
        packs: packsWritten, packs_offered: packs.length, packs_error: packsError,
        serials: serialsWritten, serials_error: serialsError,
        // Rows held back by the product gate, by setId: a non-empty map is a product the grid is
        // serving whose cards are not admitted yet (walk_cards=false), never a failure.
        packs_id_map_error: packIdMapError,
        products_error: productsError, admitted_set_ids: [...admitted], skipped_by_set: skippedBySet,
        sales_seen: sales.length, sales_serials: latestSales.length, sales_applied: salesApplied,
        sales_missed: salesMissed, sales_errors: salesErrors, sales_error: salesError,
        sales_history_valid: salesHistValid, sales_history_new: salesHistNew, sales_history_refreshed: salesHistRefreshed,
        sales_history_recent_reads: salesHistReads, sales_history_gaps: salesHistGaps, sales_history_error: salesHistError,
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

  // MULTI-PRODUCT: which products the runner walks cards for, which sports it enumerates for
  // discovery, and which pack pages it opens. Both reads fail SOFT to the historical WC scope —
  // the runner keeps its old behaviour — and say so in *_error, so a registry outage can narrow a
  // walk but never widen one.
  const [prod, pagesRes] = await Promise.all([
    readProducts(),
    (async () => {
      try {
        // Stalest walk first (never-walked first of all): the runner opens at most PANINI_PACK_PAGES_MAX
        // pages a run, and the secondary-market pack grid (2026-10-03) can register more pages than
        // that. Ordered by url, the pages past the cap would never be opened.
        const { data, error } = await (supabaseAdmin as any).from("panini_pack_pages").select("url").eq("enabled", true)
          .order("last_walked_at", { ascending: true, nullsFirst: true }).order("url", { ascending: true });
        return error ? { urls: null as string[] | null, error: error.message as string } : { urls: ((data ?? []) as { url: string }[]).map((r) => r.url), error: null };
      } catch (e) { return { urls: null as string[] | null, error: e instanceof Error ? e.message : String(e) }; }
    })(),
  ]);
  const admittedIds = prod.error ? [PANINI_LEGACY_SET_ID] : prod.rows.filter((r) => r.walk_cards).map((r) => Number(r.set_id)).sort((a, b) => a - b);
  // BOOTSTRAP (2026-09-30). A newly admitted product has no catalogue rows, so every one of its
  // cards is a fresh grid discovery — and the runner walks fresh discoveries only AFTER the held
  // priority list (1,183 on 09-30) and in enumeration order behind every other sport's new cards,
  // at ~660 cards a run. Measured: 2420 (2026 Prizm WNBA) admitted 8:30 AM PT, 0 cards written by
  // 11:40 AM PT. So while an admitted product has ZERO catalogue rows, is on the grid, and was
  // admitted < PANINI_BOOTSTRAP_HOURS ago, the walk is narrowed to it: the runner filters `pskus`
  // and `priority_pskus` by walk_set_ids, so that run walks only the new product's cards. It ends
  // by itself — the first run writes rows (count > 0) — and the age bound means a product whose
  // cards cannot be walked narrows at most a few runs, never starves the rest indefinitely.
  // Only on a COMPLETE catalogue read: a truncated one cannot prove a count of zero.
  const catCount = new Map<number, number>();
  for (const r of paged.rows) { const sid = pskuSetId(r.external_id); if (sid !== null) catCount.set(sid, (catCount.get(sid) ?? 0) + 1); }
  const nowMs = Date.now();
  const bootstrapIds = prod.error || paged.truncated ? [] : prod.rows
    .filter((r) => {
      if (!r.walk_cards || !((r.last_grid_items ?? 0) > 0) || (catCount.get(Number(r.set_id)) ?? 0) > 0) return false;
      const since = r.walk_cards_since ? Date.parse(r.walk_cards_since) : NaN;
      return Number.isFinite(since) && nowMs - since < PANINI_BOOTSTRAP_HOURS * 3_600_000;
    })
    .map((r) => Number(r.set_id)).sort((a, b) => a - b);
  const walkSetIds = bootstrapIds.length ? bootstrapIds : admittedIds;
  const walkSet = new Set(walkSetIds);
  // A catalogue row of a product that has since been switched off leaves the walk list; the row
  // itself stays (its history is real).
  const inScope = paged.rows.filter((r) => { const sid = pskuSetId(r.external_id); return sid !== null && walkSet.has(sid); });

  // HELD-BUT-UNCATALOGUED editions (2026-09-29). The runner walks two sources: this catalogue and
  // what the marketplace GRID lists. A card nobody has listed is on neither, so an edition a
  // collector HOLDS in an admitted product was never walked, never catalogued, never priced —
  // measured: 135 of 135 of the linked founder's editions in his 29 admitted products, while the
  // walk had already catalogued 332 other editions of those same products. The collector walk
  // (panini_user_holdings) records the psku of every held card, and the runner navigates straight
  // to /marketplace-details/<psku> for any psku it is handed (it never needed the grid for that),
  // so these go at the FRONT: an edition with no row at all is maximally stale.
  // Fails SOFT: a failed read serves the catalogue alone (the walk it always had) and says so.
  const catalogued = new Set(paged.rows.map((r) => r.external_id));
  const heldRes = await fetchAllPaged<{ psku: string | null }>(
    (from, to) =>
      (supabaseAdmin as any)
        .from("panini_user_holdings")
        .select("psku")
        .order("username", { ascending: true })
        .order("url_key", { ascending: true })
        .range(from, to),
    { pageSize: 1000, maxPages: 20, label: `${PIPELINE}/walk-order-held` },
  );
  const heldNew: string[] = [];
  if (!heldRes.error) {
    const seenHeld = new Set<string>();
    for (const r of heldRes.rows) {
      const ps = typeof r.psku === "string" ? r.psku : null;
      if (!ps || seenHeld.has(ps) || catalogued.has(ps)) continue;
      const sid = pskuSetId(ps);
      if (sid === null || !walkSet.has(sid)) continue;
      seenHeld.add(ps);
      heldNew.push(ps);
    }
  } else {
    console.error(`[${PIPELINE}] walk-order held read failed: ${heldRes.error}`);
  }

  // AGED PRIORITY (2026-10-03). Runners from before the 10-02 walk-order interleave walk EVERY fresh
  // grid discovery before ANY known edition; after admitting 22 products that was 3,681-5,245 new
  // pskus per run at ~600 walked, so the known catalogue stopped refreshing (514 editions > 6 days old
  // on 10-03 8:45 AM PT, crossing 7 days within a day) and the runner box had not pulled the fix.
  // Every runner since 09-29 walks `priority_pskus` FIRST, so the stalest editions past the age line
  // go there too (after the held ones), capped so discovery still gets most of the run. Works for old
  // and new runners alike; a no-op while nothing is that old. `inScope` is already stalest-first.
  const agedCutoff = Date.now() - PANINI_AGED_PRIORITY_DAYS * 86_400_000;
  const heldSet = new Set(heldNew);
  const agedPriority: string[] = [];
  for (const r of inScope) {
    if (agedPriority.length >= PANINI_AGED_PRIORITY_CAP) break;
    const seen = r.last_seen_at ? Date.parse(r.last_seen_at) : NaN;
    if (Number.isFinite(seen) && seen >= agedCutoff) break; // stalest-first: everything after is fresher
    if (!heldSet.has(r.external_id)) agedPriority.push(r.external_id);
  }
  const priority = [...heldNew, ...agedPriority];

  const rows = trim ? inScope.slice(0, trim) : inScope;
  const pskus = trim ? [...heldNew, ...rows.map((r) => r.external_id)].slice(0, trim) : [...heldNew, ...rows.map((r) => r.external_id)];
  return NextResponse.json({
    walk_set_ids: walkSetIds,
    // Non-empty = this run is narrowed to newly admitted products with no catalogue yet (above).
    bootstrap_set_ids: bootstrapIds,
    products_error: prod.error,
    discovery_sports: discoverySports(),
    // Sports whose grid gets the FULL enumeration budget (discovery of walked products' new
    // editions); every other sport gets a short discovery pass that only has to see its setIds.
    // Soccer always (the WC walk predates the registry); plus the sport each walked product was
    // last sighted in.
    full_enum_sports: [...new Set(["Soccer", ...(prod.error ? [] : prod.rows.filter((r) => r.walk_cards && r.last_grid_sport).map((r) => String(r.last_grid_sport)))])],
    // null (not []) when the read failed: the runner then keeps its built-in pack list.
    pack_urls: pagesRes.urls,
    pack_urls_error: pagesRes.error,
    as_of: new Date().toISOString(),
    order: "last_seen_at_asc",
    count: pskus.length,
    // Held by a walked collector, in an admitted product, with no catalogue row yet — queued first.
    held_uncatalogued: heldNew.length,
    // Catalogue editions older than PANINI_AGED_PRIORITY_DAYS served in priority_pskus (after the held).
    aged_priority: agedPriority.length,
    // The same held pskus as their OWN list (2026-09-29). Being at the front of `pskus` was not
    // enough: the runner walks brand-new GRID discoveries before the known list (1,464–3,900 per
    // run vs ~660 walked), and it derives "new" as grid minus `pskus`, so it cannot tell the held
    // ones apart from the list alone. A runner that reads this walks them before discoveries; an
    // older runner ignores it and keeps the prepend. Trimmed with the list so ?limit stays a bound.
    priority_pskus: trim ? priority.slice(0, trim) : priority,
    held_error: heldRes.error ?? null,
    // ⚠ Load-bearing for correctness, not diagnostics: the runner may only treat "absent from
    // pskus" as "brand new" when this is false AND nothing was trimmed. See the note above.
    // (A truncated HELD read only loses queue entries; it cannot make a catalogued edition look
    // absent, so it does not touch `complete`.)
    complete: !paged.truncated && !trim,
    truncated: paged.truncated,
    // The age of the two ends, so a reader of this response can tell a healthy rotation from a
    // stalled one without a second query.
    oldest_last_seen_at: rows[0]?.last_seen_at ?? null,
    newest_returned_last_seen_at: rows[rows.length - 1]?.last_seen_at ?? null,
    pskus,
  });
}
