// app/api/cron/panini-ingest/route.ts
//
// SHIPPED 2026-07-16 as INERT infrastructure — receives nothing until the residential
// runner (scripts/ingest-panini-runner.mjs) runs on Trevor's logged-in box. No cron wired.
// Tables applied via audit_20260716_panini_schema_inert. See docs/strategy/panini-roadmap-2026-07-16.md.
//
// PUSH ingest for Panini Plane-A: receives batches captured by the residential runner
// (docs/drafts/panini/ingest-panini-runner.mjs) and writes panini_editions /
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
import { toEditionRow, toFmvRow, toPackRow, toSerialRow, latestSalesBySku, isStrictIsoUtc } from "@/lib/chains/panini/ingest-normalize";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const PIPELINE = "panini-ingest";
const CHUNK = 500;
// Sale writes are per-sku UPDATEs (no batch form exists for row-varying values), so they run a
// few at a time — enough to keep the after() short, low enough not to crowd the pooler.
const SALES_CONCURRENCY = 8;

async function logRun(startedAtIso: string, found: number, written: number, ok: boolean, error: string | null, extra: any) {
  try {
    await (supabaseAdmin as any).rpc("log_pipeline_run", {
      p_pipeline: PIPELINE, p_started_at: startedAtIso, p_rows_found: found, p_rows_written: written, p_rows_skipped: 0,
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
  if (!found) { await logRun(startedAtIso, 0, 0, true, null, { skip: "empty" }); return NextResponse.json({ accepted: false, skipped: "empty" }, { status: 202 }); }

  after(async () => {
    let written = 0;
    try {
      const nowIso = new Date().toISOString();
      // editions (dedup by external_id within the batch)
      const byKey = new Map<string, any>();
      for (const c of cards) { const r = toEditionRow(c, nowIso); if (r.external_id) byKey.set(r.external_id, r); }
      const editionRows = [...byKey.values()];
      for (let i = 0; i < editionRows.length; i += CHUNK) {
        const { data, error } = await (supabaseAdmin as any).from("panini_editions").upsert(editionRows.slice(i, i + CHUNK), { onConflict: "external_id,collection_id" }).select("id");
        if (error) console.log(`[${PIPELINE}] editions upsert: ${error.message}`); else written += data?.length ?? 0;
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
          if (error) console.log(`[${PIPELINE}] serials upsert: ${error.message}`); else serialsWritten += data?.length ?? 0;
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
          if (error) { console.log(`[${PIPELINE}] sale update ${s.sku}: ${error.message}`); return 0; }
          return data?.length ?? 0;
        }));
        for (const n of applied) { if (n > 0) salesApplied += n; else salesMissed++; }
      }
      await logRun(startedAtIso, found, written, true, null, {
        editions: written, fmv: fmvRows.length, packs: packs.length, serials: serialsWritten,
        sales_seen: sales.length, sales_serials: latestSales.length, sales_applied: salesApplied, sales_missed: salesMissed,
      });
    } catch (e) {
      await logRun(startedAtIso, found, written, false, e instanceof Error ? e.message : String(e), {});
    }
  });
  return NextResponse.json({ accepted: true, cards: cards.length, packs: packs.length, serials: serials.length, sales: sales.length }, { status: 202 });
}
