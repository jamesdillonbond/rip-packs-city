// app/api/admin/backfill-pinnacle-catalog/route.ts
//
// Keeps public.pinnacle_catalog (render_id-keyed) fresh from Dapper's ATLAS API
// (2026-11-18, #218). Until 11-17 this paged the studio-platform GraphQL, which
// has answered HTTP 530 / "error code: 1033" since 11-17 ~4:23 PM PT; Dapper's
// own sites moved to Atlas. Atlas is read THROUGH THE DATABASE (pg_net) because
// its WAF blocks Vercel's fetch — see lib/pinnacle/atlas-disney.ts for the
// transport and the field mapping (2,970 of 2,970 live catalog rows reproduced
// on render_id + every scalar column, measured 11-18).
//
// Every row is keyed on the EDITION's renderId — the true per-pin identity (the
// legacy pinnacle_editions.edition_key and Atlas's set.renderId are set-level).
//
// Phases:
//   1.  SearchEditions sweep → catalog upsert (full mode only). The same pages
//       carry Dapper's per-edition lowAskCents, which feed the floor phase.
//   1b. mint-gap check + 1c. chain fill (unchanged; full mode only).
//   2.  Floors = Dapper's lowAskCents per render, written only from a COMPLETE
//       edition sweep (pinnacle_catalog_set_floor_asks NULLs every render absent
//       from the map, so a partial sweep would erase real floors).
//   3.  Live listings = every OPEN listing (SearchMarketplaceTransactions
//       completed:false), REPLACED only from a complete sweep (R123).
//
// Auth: Bearer RPC_ADMIN_TOKEN (admin/cron-job.org; ?token= retired) OR Bearer
// INGEST_SECRET_TOKEN (GitHub Actions) OR Bearer CRON_SECRET (Vercel cron).
// Methods: GET or POST.
// Crons: daily full backfill (cron-job.org + Vercel 37 21 * * *) + intraday
// floor-only refresh (Vercel cron, ?floors_only=1). Initial bulk load was
// scripts/seed-pinnacle-catalog.mjs.

import { NextRequest, NextResponse, after as scheduleAfter } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { verifyAdminRequest, adminUnauthorizedResponse } from "@/lib/admin-auth";
import { bearerMatches } from "@/lib/auth/bearer-secret";
import { fetchChainCatalogRows, fetchChainMintedCounts } from "@/lib/pinnacle/chain-catalog";
import {
  atlasEditionToCatalogRow,
  atlasLowAskCents,
  atlasMintedCounts,
  mintedCountRaises,
  dbAtlasDisneyCall,
  sweepAtlasEditions,
  sweepAtlasOpenListings,
  type AtlasCatalogRow,
} from "@/lib/pinnacle/atlas-disney";

// ~30 edition pages + ~50 listing pages through pg_net, 4 in flight: ~1–2 min
// measured shape; 300 s leaves room for Cloudflare-challenge retries.
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const PIPELINE_NAME = "pinnacle-catalog-backfill";
const UPSERT_CHUNK = 500;
// floors_only: catalog rows read per .in() call, and the most total_minted raises written per run.
const MINTED_READ_CHUNK = 300;
const MINTED_RAISE_MAX = 500;
// Renders read from the chain per run when the search lacks them (newest first).
const CHAIN_FILL_MAX = 60;

// Accept the admin token (Bearer; ?token= retired), the GitHub-Actions ingest token,
// or the Vercel-cron secret — mirrors the drain-topshot-misattribution route so
// the intraday floor refresh can be driven by a Vercel cron (which sends only
// Bearer CRON_SECRET). All three are equivalent-trust server secrets.
function authed(req: NextRequest): boolean {
  if (verifyAdminRequest(req)) return true;
  const header = req.headers.get("authorization") ?? "";
  const ingest = process.env.INGEST_SECRET_TOKEN;
  const cron = process.env.CRON_SECRET;
  if (ingest && bearerMatches(header, "INGEST_SECRET_TOKEN")) return true;
  if (cron && bearerMatches(header, "CRON_SECRET")) return true;
  return false;
}

/**
 * edition_type NAME → limited_edition, as the catalog already records it. Atlas
 * carries no such flag. A type the catalog holds with BOTH values, or never, maps
 * to null (unknown, not a guess). A failed count read is an ERROR — the caller
 * must not write rows whose flag it could not establish.
 */
async function limitedByTypeFromCatalog(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  types: string[],
): Promise<{ map: Map<string, boolean | null>; error: string | null }> {
  const map = new Map<string, boolean | null>();
  for (const t of types) {
    const count = async (flag: boolean) => {
      const { count: n, error } = await supabase
        .from("pinnacle_catalog")
        .select("render_id", { count: "exact", head: true })
        .eq("edition_type", t)
        .eq("limited_edition", flag);
      if (error) throw new Error(error.message ?? String(error));
      if (typeof n !== "number") throw new Error("count missing from the response");
      return n;
    };
    try {
      const [nTrue, nFalse] = await Promise.all([count(true), count(false)]);
      map.set(t, nTrue > 0 && nFalse === 0 ? true : nFalse > 0 && nTrue === 0 ? false : null);
    } catch (e) {
      return { map, error: `limited_edition lookup for "${t}": ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  return { map, error: null };
}

async function handle(req: NextRequest): Promise<NextResponse> {
  if (!authed(req)) return adminUnauthorizedResponse();

  // floors_only=1: skip the catalog upsert and run only the floor + live-listing
  // phases, so an intraday Vercel cron keeps the public render floor
  // (pinnacle_catalog.floor_ask) fresh. Same source + same RPCs as the daily run.
  const floorsOnly = req.nextUrl.searchParams.get("floors_only") === "1";

  // 202 + after(): the sweep pages ~80 Atlas calls and exceeds cron-job.org's 30s
  // client cap; auth stays sync, everything else (incl. log_pipeline_run) runs in
  // after(), and pipeline_runs carries the outcome.
  scheduleAfter(async () => {
  const startedAt = Date.now();
  const startedAtIso = new Date(startedAt).toISOString();
  const supabase: any = supabaseAdmin;
  const atlas = dbAtlasDisneyCall(supabase);
  const errors: string[] = [];

  // ── Phase 1: the edition sweep (both modes — it also carries the floors) ──
  const sweep = await sweepAtlasEditions(atlas);
  const total = sweep.totalCount ?? 0;
  const nowIso = new Date().toISOString();
  if (sweep.errors.length) errors.push(`editions: ${sweep.errors[0]}`);
  // edition id → render id, for the live-listing phase (listings carry editionId only).
  const renderByEdition = new Map<string, string>();
  for (const e of sweep.editions) {
    const r = e as { id?: unknown; renderId?: unknown };
    if (r?.id != null && typeof r.renderId === "string" && r.renderId) renderByEdition.set(String(r.id), r.renderId);
  }

  let upserted = 0;
  let unkeyed = 0;
  let limitedError: string | null = null;
  if (!floorsOnly && sweep.editions.length > 0) {
    const types = [...new Set(sweep.editions.map((e) => (e as { editionTemplate?: { editionType?: unknown } })?.editionTemplate?.editionType).filter((t): t is string => typeof t === "string" && t !== ""))];
    const limited = await limitedByTypeFromCatalog(supabase, types);
    limitedError = limited.error;
    if (limitedError) {
      errors.push(`catalog upsert skipped: ${limitedError}`);
    } else {
      const rows: AtlasCatalogRow[] = [];
      for (const e of sweep.editions) {
        const row = atlasEditionToCatalogRow(e, nowIso, limited.map);
        if (row) rows.push(row);
        else unkeyed++;
      }
      for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
        const chunk = rows.slice(i, i + UPSERT_CHUNK);
        const { error } = await supabase.from("pinnacle_catalog").upsert(chunk, { onConflict: "render_id" });
        if (error) errors.push(`catalog upsert: ${error.message}`);
        else upserted += chunk.length;
      }
    }
  }

  // ── Phase 1a (2026-11-25): keep total_minted at the chain's count ──
  // The 6-hourly floors_only run holds every edition's live numMinted from the sweep above, but only the daily full
  // run wrote it. And Atlas's numMinted itself runs BELOW the contract's own Edition.numberMinted (42 renders / 436
  // pins on 11-25, 12 of them quiet 14+ days — not lag; the chain count equals RPC's pinnacle_mint_events count).
  // So, in BOTH modes (after the full run's upsert has written Atlas's value): raise total_minted to the higher of
  // Atlas's numMinted and the chain's numberMinted. Raise-only (mintedCountRaises): a lower value is never written,
  // and a failed chain batch is simply absent. A failed catalog read/write fails the run.
  let mintedRaised = 0;
  let mintedRaiseCandidates = 0;
  let mintedChainEditions = 0;
  const mintedChainErrors: string[] = [];
  if (sweep.editions.length > 0) {
    const live = atlasMintedCounts(sweep.editions);
    const ids = [...live.keys()];
    const current: Array<{ render_id: string; edition_id: string | null; total_minted: number | null }> = [];
    let readOk = true;
    for (let i = 0; i < ids.length; i += MINTED_READ_CHUNK) {
      const { data, error } = await supabase
        .from("pinnacle_catalog")
        .select("render_id, edition_id, total_minted")
        .in("render_id", ids.slice(i, i + MINTED_READ_CHUNK));
      if (error) {
        errors.push(`total_minted read: ${error.message}`);
        readOk = false;
        break;
      }
      current.push(...((data ?? []) as Array<{ render_id: string; edition_id: string | null; total_minted: number | null }>));
    }
    if (readOk) {
      const editionOf = new Map<string, number>();
      for (const c of current) {
        const e = Number(c.edition_id);
        if (c.edition_id != null && Number.isInteger(e) && e > 0) editionOf.set(c.render_id, e);
      }
      const chain = await fetchChainMintedCounts([...editionOf.values()]);
      mintedChainEditions = chain.counts.size;
      mintedChainErrors.push(...chain.errors);
      for (const [renderId, e] of editionOf) {
        const n = chain.counts.get(e);
        if (n != null && n > (live.get(renderId) ?? -1)) live.set(renderId, n);
      }
      const raises = mintedCountRaises(live, current);
      mintedRaiseCandidates = raises.length;
      for (const r of raises.slice(0, MINTED_RAISE_MAX)) {
        const { error } = await supabase
          .from("pinnacle_catalog")
          .update({ total_minted: r.total_minted })
          .eq("render_id", r.render_id);
        if (error) {
          errors.push(`total_minted update ${r.render_id}: ${error.message}`);
          break;
        }
        mintedRaised++;
      }
    }
  }

  // ── Phase 1b (2026-11-08, handoff pinnacle-wmc-render-gap): is the SOURCE behind the chain? ──
  // A pin the chain minted whose render_id this search never returned has no catalog row, so its
  // name / set / image cannot be derived — and nothing said so. Compare against RPC's own mint
  // records after every full sweep: all-time gaps are reported; a RECENT gap (first minted within
  // 14 days) fails the run, because that is the source falling behind, not a standing orphan.
  let mintGap: { missing_renders?: number; missing_pins?: number; missing_recent_renders?: number; sample?: unknown[] } | null = null;
  let mintGapError: string | null = null;
  // Phase 1c (2026-11-09): a render the search lacks is read from the Pinnacle contract itself
  // (lib/pinnacle/chain-catalog.ts) and inserted FILL-ONLY, tagged source 'flow-chain'. Dapper's
  // row replaces it on the first sweep that returns it. The run fails only on what is STILL
  // missing after that — e.g. the chain read failed, or a render has no on-chain edition id.
  let chainFilled = 0;
  let chainFilledRecent = 0;
  let chainDerived = 0;
  const chainErrors: string[] = [];
  if (!floorsOnly) {
    try {
      const { data: gap, error: gapErr } = await supabase.rpc("pinnacle_minted_renders_missing_from_catalog", { p_sample: CHAIN_FILL_MAX, p_recent_days: 14 });
      if (gapErr) mintGapError = gapErr.message;
      else mintGap = gap && typeof gap === "object" ? gap : null;
    } catch (e) {
      mintGapError = e instanceof Error ? e.message : String(e);
    }
    const missingSample = (Array.isArray(mintGap?.sample) ? mintGap!.sample : []) as Array<{ render_id?: string; first_minted_at?: string }>;
    if (!mintGapError && missingSample.length > 0) {
      try {
        const editionByRender = new Map<string, number>();
        const renderIds = missingSample.map((s) => s.render_id).filter((r): r is string => !!r);
        for (let i = 0; i < renderIds.length; i += 10) {
          await Promise.all(
            renderIds.slice(i, i + 10).map(async (rid) => {
              const { data, error } = await supabase
                .from("pinnacle_mint_events")
                .select("edition_id")
                .eq("render_id", rid)
                .not("edition_id", "is", null)
                .limit(1)
                .maybeSingle();
              if (error) chainErrors.push(`edition id for ${rid}: ${error.message}`);
              const ed = Number((data as { edition_id?: unknown } | null)?.edition_id);
              if (Number.isInteger(ed) && ed > 0) editionByRender.set(rid, ed);
            }),
          );
        }
        if (editionByRender.size > 0) {
          const { rows: chainRows, errors: readErrors } = await fetchChainCatalogRows([...editionByRender.values()]);
          chainErrors.push(...readErrors);
          // Only rows for renders that were actually missing — never a render the search already wrote.
          const wanted = chainRows.filter((r) => editionByRender.has(r.render_id));
          if (wanted.length > 0) {
            const { data: ins, error: insErr } = await supabase
              .from("pinnacle_catalog")
              .upsert(wanted, { onConflict: "render_id", ignoreDuplicates: true })
              .select("render_id");
            if (insErr) chainErrors.push(`chain rows insert: ${insErr.message}`);
            else {
              const filled = new Set(((ins as Array<{ render_id: string }> | null) ?? []).map((r) => r.render_id));
              chainFilled = filled.size;
              const recentCut = Date.now() - 14 * 86_400_000;
              chainFilledRecent = missingSample.filter(
                (s) => s.render_id && filled.has(s.render_id) && s.first_minted_at && Date.parse(s.first_minted_at) > recentCut,
              ).length;
            }
          }
        }
      } catch (e) {
        chainErrors.push(e instanceof Error ? e.message : String(e));
      }
      if (chainFilled > 0) {
        console.warn(`[${PIPELINE_NAME}] filled ${chainFilled} catalog row(s) from the chain`);
        // Name the wallet pins now. The wmc render-id lane derives only in an hour that resolved
        // NEW render ids, so pins whose render_id landed BEFORE their catalog row existed (the
        // whole 11-08 drop: 961 rows) were never re-derived. The derive is fill/refresh-only.
        try {
          const { data: der, error: derErr } = await supabase.rpc("derive_pinnacle_wmc_from_catalog");
          if (derErr) chainErrors.push(`wmc derive: ${derErr.message}`);
          else chainDerived = typeof der === "number" ? der : 0;
        } catch (e) {
          chainErrors.push(`wmc derive: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    const recentStillMissing = Math.max(0, Number(mintGap?.missing_recent_renders ?? 0) - chainFilledRecent);
    if (mintGapError) errors.push(`mint gap check: ${mintGapError}`);
    else if (mintGap && recentStillMissing > 0) {
      errors.push(
        `catalog behind mints: ${recentStillMissing} render(s) minted in the last 14 days have no catalog row (${mintGap.missing_renders} all-time, ${mintGap.missing_pins} pins; ${chainFilled} filled from chain${chainErrors.length ? `; chain: ${chainErrors[0]}` : ""})`,
      );
    }
    if (mintGap && Number(mintGap.missing_renders ?? 0) > 0) {
      console.warn(`[${PIPELINE_NAME}] ${mintGap.missing_renders} minted render(s) not in the catalog (${mintGap.missing_recent_renders} recent)`);
    }
  }

  // ── Phase 2: floors — Dapper's own lowAskCents per render ──
  // Measured 11-18 against the listing sweep's per-edition minimum: equal on 2,709
  // of 2,711 listed editions (the other 2 moved in the ~1 h between the reads).
  // lowAskCents is chosen because it needs no second sweep to be complete: a
  // PRICE-sorted listing sweep duplicated 276 rows (so skipped as many) and missed
  // 48 listed editions; floor_agrees_with_listings in extra keeps the cross-check live.
  let floorListed = 0;     // distinct render_ids with a live floor
  let floorRows = 0;       // catalog rows the RPC set non-null
  const floorByRender = new Map<string, number>(); // render_id → cents
  for (const e of sweep.editions) {
    const rid = (e as { renderId?: unknown })?.renderId;
    const cents = atlasLowAskCents(e);
    if (typeof rid === "string" && rid && cents != null) floorByRender.set(rid, cents);
  }
  floorListed = floorByRender.size;
  if (!sweep.complete) {
    errors.push(`floors: edition sweep incomplete after ${sweep.pages} pages — floors left as they were`);
  } else if (floorListed === 0 && sweep.editions.length > 0) {
    // Thousands of editions and not one low ask is an UNRENDERABLE answer (a renamed
    // field, a changed shape), not an empty market — writing it would NULL every floor.
    errors.push(`floors: ${sweep.editions.length} editions carried no lowAskCents — floors left as they were`);
  } else {
    // pinnacle_catalog_set_floor_asks takes raw UFix64 (dollars × 1e8) and divides
    // by 1e8; cents × 1e6 is that unit exactly.
    const map = Object.fromEntries([...floorByRender].map(([rid, cents]) => [rid, cents * 1e6]));
    const { data: cnt, error: floorErr } = await supabase.rpc("pinnacle_catalog_set_floor_asks", {
      p_map: map,
      p_checked_at: startedAtIso,
    });
    if (floorErr) errors.push(`floor set: ${floorErr.message}`);
    else floorRows = typeof cnt === "number" ? cnt : 0;
  }

  // ── Phase 3: the live-listing set (pinnacle_live_listings) ──
  let floorPages = 0;
  let floorTotal = 0;      // usable open listings the sweep kept
  let floorComplete = false;
  let liveWritten = 0;
  let liveDeleted = 0;
  let liveUnmapped = 0;
  let liveDuplicates = 0;
  let floorAgreesWithListings = 0;
  const liveListings: Array<{ nft_id: string; render_id: string; serial_number: number | null; price_usd: number }> = [];
  try {
    const ls = await sweepAtlasOpenListings(atlas);
    floorPages = ls.pages;
    floorTotal = ls.listings.length;
    liveDuplicates = ls.duplicates;
    floorComplete = ls.complete;
    if (ls.errors.length) errors.push(`live listings: ${ls.errors[0]}`);
    const minByRender = new Map<string, number>();
    for (const l of ls.listings) {
      const rid = renderByEdition.get(l.edition_id);
      if (!rid) {
        liveUnmapped++;
        continue;
      }
      liveListings.push({ nft_id: l.nft_id, render_id: rid, serial_number: l.serial_number, price_usd: l.price_cents / 100 });
      const m = minByRender.get(rid);
      if (m == null || l.price_cents < m) minByRender.set(rid, l.price_cents);
    }
    for (const [rid, cents] of floorByRender) if (minByRender.get(rid) === cents) floorAgreesWithListings++;
    // REPLACED only from a COMPLETE sweep whose every listing could be named: a
    // partial one would retire listings it never reached (CLAUDE.md, R123). The RPC
    // upserts first and deletes only what this sweep did not write.
    if (!floorComplete) {
      errors.push(`live listings: sweep incomplete after ${floorPages} pages — live set left as it was`);
    } else if (!sweep.complete || liveUnmapped > 0) {
      errors.push(`live listings: ${liveUnmapped} listing(s) on editions the edition sweep did not return — live set left as it was`);
    } else if (liveListings.length > 0) {
      const { data: live, error: liveErr } = await supabase.rpc("pinnacle_live_listings_replace", {
        p_rows: liveListings,
        p_seen_at: startedAtIso,
      });
      if (liveErr) errors.push(`live listings: ${liveErr.message}`);
      else {
        liveWritten = Number(live?.written ?? 0);
        liveDeleted = Number(live?.deleted ?? 0);
      }
    }
  } catch (e) {
    errors.push(`live listings: ${e instanceof Error ? e.message : String(e)}`);
  }

  const durationMs = Date.now() - startedAt;
  const ok = errors.length === 0;
  try {
    await supabase.rpc("log_pipeline_run", {
      p_pipeline: floorsOnly ? "pinnacle-catalog-floor-refresh" : PIPELINE_NAME,
      p_started_at: startedAtIso,
      p_rows_found: total,
      p_rows_written: floorsOnly ? floorRows : upserted,
      p_rows_skipped: 0,
      p_ok: ok,
      p_error: errors[0] ?? null,
      p_collection_slug: "disney_pinnacle",
      p_cursor_before: null,
      p_cursor_after: null,
      p_extra: { source: "atlas", floors_only: floorsOnly, pages: sweep.pages, total_count: total, editions_seen: sweep.editions.length, editions_complete: sweep.complete, upserted, unkeyed, limited_error: limitedError, floor_listed: floorListed, floor_rows: floorRows, floor_pages: floorPages, floor_total: floorTotal, floor_complete: floorComplete, floor_agrees_with_listings: floorAgreesWithListings, live_listings_seen: liveListings.length, live_unmapped: liveUnmapped, live_duplicates: liveDuplicates, live_written: liveWritten, live_deleted: liveDeleted, minted_raised: mintedRaised, minted_raise_candidates: mintedRaiseCandidates, minted_chain_editions: mintedChainEditions, minted_chain_errors: mintedChainErrors.slice(0, 3), minted_renders_missing: mintGap?.missing_renders ?? null, minted_pins_missing: mintGap?.missing_pins ?? null, minted_renders_missing_recent: mintGap?.missing_recent_renders ?? null, minted_missing_sample: Array.isArray(mintGap?.sample) ? mintGap!.sample.slice(0, 10) : null, mint_gap_error: mintGapError, chain_filled: chainFilled, chain_filled_recent: chainFilledRecent, chain_wmc_derived: chainDerived, chain_errors: chainErrors.slice(0, 3), duration_ms: durationMs, errors: errors.slice(0, 5) },
    });
  } catch {
    // best-effort observability
  }

  });

  return NextResponse.json(
    { ok: true, accepted: true, pipeline: floorsOnly ? "pinnacle-catalog-floor-refresh" : PIPELINE_NAME, floors_only: floorsOnly },
    { status: 202 }
  );
}

export async function GET(req: NextRequest) { return handle(req); }
export async function POST(req: NextRequest) { return handle(req); }
