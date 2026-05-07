// supabase/functions/enrich-ufc-wallet/index.ts
//
// Enriches wallet_moments_cache rows for a UFC wallet by reading per-moment
// metadata from on-chain Cadence (Display + Editions views), then joining
// against the editions table to backfill set_name + image_url and to
// title-case player_name.
//
// Without the editions JOIN this function wrote 247 rows with NULL set_name
// and ALL-CAPS player_name (e.g. "MAIRON SANTOS ALVES") on every refresh,
// even though editions had clean Title Case values for all UFC moments.
//
// COALESCE rules (mirror the cached_listings parallel fix in commit 7af8efd):
//   - set_name: editions wins (direct overwrite when editions has it)
//   - player_name: editions wins UNLESS editions.player_name looks like a
//     catchphrase string — heuristic: length < 3 or contains "!". For
//     catchphrase moments (e.g. "Shut Up!" — SHUT-UP-20830) editions stores
//     the catchphrase rather than the fighter name, so we keep the wallet's
//     on-chain value and titleCase it.
//   - image_url: existing wallet value wins (already populated by prior
//     backfill / from on-chain Display.thumbnail.uri()), fall back to
//     editions.thumbnail_url.
//   - tier: keep inferTier() — wallet ingestion already populates tier
//     correctly from the on-chain max-circulation value.
//
// Deploy: supabase functions deploy enrich-ufc-wallet --no-verify-jwt

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const UFC_COLLECTION_ID = "9b4824a8-736d-4a96-b450-8dcc0c46b023";
const FLOW_API = "https://rest-mainnet.onflow.org/v1/scripts";

function b64(s: string): string { return btoa(unescape(encodeURIComponent(s))); }
function argB64(obj: any): string { return btoa(JSON.stringify(obj)); }

async function runScript(script: string, args: string[]): Promise<any> {
  const res = await fetch(`${FLOW_API}?block_height=final`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ script: b64(script), arguments: args }),
  });
  if (!res.ok) { const t = await res.text(); throw new Error(`${res.status}: ${t.substring(0, 200)}`); }
  const raw = await res.text();
  return JSON.parse(atob(raw.replace(/[\r\n"]/g, "")));
}

const GET_META = `
import NonFungibleToken from 0x1d7e57aa55817448
import MetadataViews from 0x1d7e57aa55817448
import UFC_NFT from 0x329feb3ab062d289

access(all) fun main(addr: Address, id: UInt64): {String: String} {
  let acct = getAccount(addr)
  let ref = acct.capabilities.borrow<&{NonFungibleToken.CollectionPublic}>(UFC_NFT.CollectionPublicPath)!
  let nft = ref.borrowNFT(id)!
  let result: {String: String} = {"nftID": id.toString()}

  if let display = nft.resolveView(Type<MetadataViews.Display>()) {
    let d = display as! MetadataViews.Display
    result["name"] = d.name
    result["description"] = d.description
    result["thumbnail"] = d.thumbnail.uri()
  }
  if let editions = nft.resolveView(Type<MetadataViews.Editions>()) {
    let e = editions as! MetadataViews.Editions
    if e.infoList.length > 0 {
      result["editionName"] = e.infoList[0].name ?? ""
      result["serial"] = e.infoList[0].number.toString()
      result["max"] = e.infoList[0].max?.toString() ?? ""
    }
  }
  return result
}
`;

function inferTier(max: number | null): string {
  if (!max || max === 0) return "FANDOM";
  if (max <= 10) return "ULTIMATE";
  if (max <= 99) return "CHAMPION";
  if (max <= 999) return "CHALLENGER";
  if (max <= 25000) return "CONTENDER";
  return "FANDOM";
}
function makeEditionKey(name: string, max: number | null): string {
  return name.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") + "-" + (max ?? 0);
}
function parseResult(raw: any): Record<string, string> {
  const f: Record<string, string> = {};
  if (raw?.value) for (const e of raw.value) f[e.key.value] = e.value.value;
  return f;
}
function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(/\s+/)
    .map(w => (w.length > 0 ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

type EditionEnrichment = {
  player_name: string | null;
  set_name: string | null;
  thumbnail_url: string | null;
};

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const wallet = url.searchParams.get("wallet");
  const token = url.searchParams.get("token") || "";
  const startIdx = parseInt(url.searchParams.get("start") || "0");
  const authToken = Deno.env.get("INGEST_SECRET_TOKEN") || "";
  if (authToken && token !== authToken) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  if (!wallet) return new Response(JSON.stringify({ error: "wallet required" }), { status: 400 });

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // Pull existing wallet rows including image_url so the COALESCE can prefer
  // an already-populated thumbnail over editions.thumbnail_url.
  const { data: moments } = await supabase.from("wallet_moments_cache")
    .select("moment_id, image_url")
    .eq("wallet_address", wallet)
    .eq("collection_id", UFC_COLLECTION_ID)
    .order("moment_id");
  const allMoments = (moments ?? []) as Array<{ moment_id: string; image_url: string | null }>;
  if (!allMoments.length) return new Response(JSON.stringify({ ok: true, message: "No moments" }));
  const allIds = allMoments.map(m => m.moment_id);
  const existingImageMap = new Map<string, string | null>();
  for (const m of allMoments) existingImageMap.set(m.moment_id, m.image_url);

  // Load all UFC editions (~247 rows total) into a Map keyed on external_id
  // (which equals the wallet's edition_key under the same makeEditionKey()
  // slug rules). Loaded once per invocation; small enough to keep in memory.
  const editionMap = new Map<string, EditionEnrichment>();
  const editionIdMap = new Map<string, string>(); // external_id → internal uuid
  const { data: edRows, error: edErr } = await supabase.from("editions")
    .select("id, external_id, player_name, set_name, thumbnail_url")
    .eq("collection_id", UFC_COLLECTION_ID);
  if (edErr) console.warn(`[enrich-ufc-wallet] editions lookup error: ${edErr.message}`);
  for (const r of (edRows ?? []) as Array<Record<string, unknown>>) {
    const ext = r.external_id as string | null;
    if (!ext) continue;
    editionMap.set(ext, {
      player_name: (r.player_name as string | null) ?? null,
      set_name: (r.set_name as string | null) ?? null,
      thumbnail_url: (r.thumbnail_url as string | null) ?? null,
    });
    const uuid = r.id as string | null;
    if (uuid) editionIdMap.set(ext, uuid);
  }

  // Load latest fmv_snapshots for these editions so the upsert below can
  // populate wmc.fmv_usd in the same pass. Defensive ceiling: cap at $10K
  // unless HIGH confidence with sales_count_30d >= 3 (guards known FMV
  // pipeline outliers).
  const fmvByExt = new Map<string, number | null>();
  const internalEditionIds = [...new Set(editionIdMap.values())];
  if (internalEditionIds.length > 0) {
    const fmvByInternal = new Map<string, { fmv_usd: number | null; confidence: string | null; sales_count_30d: number | null }>();
    for (let i = 0; i < internalEditionIds.length; i += 200) {
      const slice = internalEditionIds.slice(i, i + 200);
      const { data: snaps } = await supabase
        .from("fmv_snapshots")
        .select("edition_id, fmv_usd, confidence, sales_count_30d, computed_at")
        .in("edition_id", slice)
        .order("computed_at", { ascending: false });
      for (const s of (snaps ?? []) as Array<Record<string, unknown>>) {
        const eid = s.edition_id as string;
        if (fmvByInternal.has(eid)) continue;
        fmvByInternal.set(eid, {
          fmv_usd: s.fmv_usd != null ? Number(s.fmv_usd) : null,
          confidence: (s.confidence as string | null) ?? null,
          sales_count_30d: s.sales_count_30d != null ? Number(s.sales_count_30d) : null,
        });
      }
    }
    for (const [extId, internalId] of editionIdMap) {
      const snap = fmvByInternal.get(internalId);
      if (!snap || snap.fmv_usd == null || !Number.isFinite(snap.fmv_usd)) {
        fmvByExt.set(extId, null);
        continue;
      }
      const v = snap.fmv_usd;
      if (v <= 10000) { fmvByExt.set(extId, v); continue; }
      const isHigh = String(snap.confidence ?? "").toUpperCase() === "HIGH";
      const c = Number(snap.sales_count_30d ?? 0);
      fmvByExt.set(extId, isHigh && c >= 3 ? v : null);
    }
  }

  const CHUNK = 100, CONC = 5;
  const endIdx = Math.min(startIdx + CHUNK, allIds.length);
  const batch = allIds.slice(startIdx, endIdx);
  let enriched = 0, errCount = 0;
  const updates: any[] = [];
  const sampleErrors: string[] = [];
  const sampleData: any[] = [];

  for (let i = 0; i < batch.length; i += CONC) {
    const group = batch.slice(i, i + CONC);
    const results = await Promise.allSettled(group.map(async (id: string) => {
      const r = await runScript(GET_META, [argB64({type:"Address",value:wallet}), argB64({type:"UInt64",value:id})]);
      return { id, fields: parseResult(r) };
    }));
    for (const res of results) {
      if (res.status === "fulfilled") {
        const { id, fields } = res.value;
        const edName = fields.editionName || fields.name || "";
        const serial = parseInt(fields.serial || "0") || null;
        const max = parseInt(fields.max || "0") || null;
        const walletFighter = edName.includes("|") ? edName.split("|")[0].trim() : edName;
        if (edName) {
          enriched++;
          const editionKey = makeEditionKey(edName, max);
          const ed = editionMap.get(editionKey);

          // editions wins for player_name unless it looks like a catchphrase
          // string (length < 3 or contains "!"); in that case fall back to
          // titleCase of the on-chain ALL-CAPS Display value.
          const editionsPlayerOk =
            !!ed?.player_name && ed.player_name.length >= 3 && !ed.player_name.includes("!");
          const player_name = editionsPlayerOk ? ed!.player_name! : titleCase(walletFighter);

          // editions wins for set_name (direct overwrite).
          const set_name = ed?.set_name ?? null;

          // existing wallet image_url wins; editions.thumbnail_url is the fallback.
          const image_url = existingImageMap.get(id) ?? ed?.thumbnail_url ?? null;

          const fmvForRow = fmvByExt.get(editionKey) ?? null;
          updates.push({
            moment_id: id,
            wallet_address: wallet,
            collection_id: UFC_COLLECTION_ID,
            edition_key: editionKey,
            serial_number: serial,
            player_name,
            set_name,
            image_url,
            tier: inferTier(max),
            is_locked: false,
            fmv_usd: fmvForRow,
            last_seen_at: new Date().toISOString(),
          });
          if (sampleData.length < 3) {
            sampleData.push({
              id, player_name, set_name, serial, max,
              tier: inferTier(max),
              image_url: image_url?.substring(0, 60),
              edSource: editionsPlayerOk ? "editions" : "wallet-titleCase",
            });
          }
        }
      } else {
        errCount++;
        if (sampleErrors.length < 3) sampleErrors.push(res.reason?.message?.substring(0, 120) ?? "unknown");
      }
    }
    if (i + CONC < batch.length) await sleep(200);
  }

  let upserted = 0;
  for (let i = 0; i < updates.length; i += 50) {
    const b = updates.slice(i, i + 50);
    // The wallet_moments_cache UNIQUE constraint was migrated to
     // (wallet_address, collection_id, moment_id) on 2026-05-06 to support
     // cross-collection moment-id collisions. Using the old 2-column
     // onConflict silently no-ops every upsert and the function reports
     // upserted: 0 even when sampleData looks correct.
    const { error } = await supabase.from("wallet_moments_cache").upsert(b, { onConflict: "wallet_address,collection_id,moment_id" });
    if (!error) upserted += b.length; else sampleErrors.push(`upsert: ${error.message}`);
  }

  return new Response(JSON.stringify({
    ok: true,
    done: endIdx >= allIds.length,
    startIdx,
    nextStart: endIdx >= allIds.length ? null : endIdx,
    totalMoments: allIds.length,
    processed: batch.length,
    enriched,
    upserted,
    editionsLoaded: editionMap.size,
    errors: errCount,
    sampleErrors,
    sampleData,
  }), { headers: { "Content-Type": "application/json" } });
});
