import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ── Pack Distributions seeder ────────────────────────────────────────────────
//
// Walks the Flow PDS contract (0xb6f2481eba4df97b) one distId at a time,
// classifies each distribution by productID / title / metadata, and upserts
// the matching rows into `pack_distributions`.
//
// The same function handles AllDay and Golazos via the `?collection=` param:
//   ?collection=allday   (default) → keeps the "allday" bucket, writes with
//                                    collection_id = AllDay, state id
//                                    `allday_pack_distributions`.
//   ?collection=golazos             → keeps the "golazos" bucket, writes with
//                                    collection_id = Golazos, state id
//                                    `golazos_pack_distributions`.
//
// Other buckets (topshot / other / nulls) are always counted but only ingested
// for the active target. This lets a cron-job.org schedule call once per
// target on separate schedules without the buckets trampling each other.

const INGEST_TOKEN = Deno.env.get("INGEST_SECRET_TOKEN");
if (!INGEST_TOKEN) {
  throw new Error("INGEST_SECRET_TOKEN env var is required");
}
const FLOW_REST = "https://rest-mainnet.onflow.org/v1";
const ALLDAY_COLLECTION_ID = "dee28451-5d62-409e-a1ad-a83f763ac070";
const GOLAZOS_COLLECTION_ID = "06248cc4-b85f-47cd-af67-1855d14acd75";
// PDS nextDistId drifts upward; when the live batch returns zero hits for the
// active target and we pass this ceiling, the seeder marks itself idle.
const MAX_DIST_ID = 7729;
const EMPTY_RUNS_TO_STOP = 3;

type TargetKey = "allday" | "golazos";

interface TargetConfig {
  key: TargetKey;
  collectionId: string;
  stateId: string;
  nftType: string;
  logPrefix: string;
}

const TARGETS: Record<TargetKey, TargetConfig> = {
  allday: {
    key: "allday",
    collectionId: ALLDAY_COLLECTION_ID,
    stateId: "allday_pack_distributions",
    nftType: "AllDay",
    logPrefix: "[pds-seed:allday]",
  },
  golazos: {
    key: "golazos",
    collectionId: GOLAZOS_COLLECTION_ID,
    stateId: "golazos_pack_distributions",
    nftType: "Golazos",
    logPrefix: "[pds-seed:golazos]",
  },
};

function resolveTarget(raw: string | null | undefined): TargetConfig {
  const v = (raw ?? "").toString().trim().toLowerCase();
  if (v === "golazos" || v === "laliga-golazos" || v === "laliga_golazos") return TARGETS.golazos;
  return TARGETS.allday;
}

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

function flowArg(type: string, value: string): string {
  return btoa(JSON.stringify({ type, value }));
}

async function runScript(cadence: string, args: string[] = []): Promise<{ parsed: any; error: string | null }> {
  let res: Response;
  try {
    res = await fetch(`${FLOW_REST}/scripts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ script: btoa(cadence), arguments: args }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) { return { parsed: null, error: `fetch: ${e}` }; }
  const raw = await res.text();
  if (!res.ok) return { parsed: null, error: `HTTP ${res.status}: ${raw.slice(0,300)}` };
  try {
    return { parsed: JSON.parse(atob(raw.trim().replace(/^"|"$/g, ""))), error: null };
  } catch (e) { return { parsed: null, error: `decode: ${e}` }; }
}

function parseCadence(v: any): any {
  if (!v) return null;
  const { type, value } = v;
  if (type === "Optional") return value != null ? parseCadence(value) : null;
  if (["UInt64","UInt32","UInt8","Int"].includes(type)) return parseInt(value);
  if (["String","Bool","Address"].includes(type)) return value;
  if (type === "Array") return (value as any[]).map(parseCadence);
  if (type === "Dictionary") {
    const obj: Record<string,any> = {};
    for (const { key, value: val } of (value as any[])) obj[parseCadence(key)] = parseCadence(val);
    return obj;
  }
  if (["Struct","Resource","Event","Enum"].includes(type)) {
    const obj: Record<string,any> = {};
    for (const { name, value: val } of ((value as any)?.fields ?? [])) obj[name] = parseCadence(val);
    return obj;
  }
  return value;
}

const GET_DIST_SCRIPT = `
import PDS from 0xb6f2481eba4df97b
access(all) fun main(distId: UInt64): {String: String}? {
  if let info = PDS.getDistInfo(distId: distId) {
    var result: {String: String} = {
      "title": info.title,
      "state": info.state.rawValue.toString()
    }
    for key in info.metadata.keys {
      result["meta_".concat(key)] = info.metadata[key]!
    }
    return result
  }
  return nil
}`;

function classifyDist(data: Record<string,string>): "allday" | "golazos" | "topshot" | "other" {
  const productId = (data.meta_productID ?? data.meta_productId ?? "").toLowerCase();
  const title = (data.title ?? "").toLowerCase();
  const allVals = Object.values(data).join(" ").toLowerCase();

  if (productId === "golazos" || productId.includes("golazos")) return "golazos";
  if (productId === "topshot" || productId.includes("topshot") || productId.includes("top_shot")) return "topshot";
  if (productId.includes("all_day") || productId.includes("allday") || productId.includes("nfl")) return "allday";

  if (title.includes("golazos") || title.includes("jornada") || allVals.includes("golazos")) return "golazos";
  if (title.includes("top shot") || title.includes("topshot")) return "topshot";
  if (title.includes("all day") || title.includes("allday") || title.includes(" nfl ") || allVals.includes("nfl_all_day")) return "allday";

  if (allVals.includes("nbatopshot")) return "topshot";
  if (allVals.includes("nflallday") || allVals.includes("allday")) return "allday";

  return "other";
}

async function readBody(req: Request): Promise<Record<string, any>> {
  if (req.method !== "POST") return {};
  try {
    const text = await req.text();
    if (!text.trim()) return {};
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function loadState(stateId: string): Promise<{ cursor: number; totalIngested: number; notes: string | null }> {
  const { data } = await supabase
    .from("backfill_state")
    .select("cursor, total_ingested, notes")
    .eq("id", stateId)
    .maybeSingle();
  return {
    cursor: data?.cursor ? parseInt(String(data.cursor)) : 1,
    totalIngested: data?.total_ingested ?? 0,
    notes: data?.notes ?? null,
  };
}

async function saveState(stateId: string, cursor: number, totalIngested: number, status: string, notes: string | null) {
  const { error } = await supabase
    .from("backfill_state")
    .upsert({
      id: stateId,
      cursor: String(cursor),
      total_ingested: totalIngested,
      last_run_at: new Date().toISOString(),
      status,
      notes,
    });
  if (error) console.log(`[pds-seed] saveState err: ${error.message}`);
}

Deno.serve(async (req: Request) => {
  const auth = req.headers.get("Authorization") ?? "";
  const url = new URL(req.url);
  const token = url.searchParams.get("token") ?? "";
  if (!auth.includes(INGEST_TOKEN) && token !== INGEST_TOKEN) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }
  const respond = (data: any) =>
    new Response(JSON.stringify(data, null, 2), { headers: { "Content-Type": "application/json" } });

  const body = await readBody(req);
  const target = resolveTarget(url.searchParams.get("collection") ?? body.collection);

  // ── Test single dist ─────────────────────────────────────────────────
  const testDistId = url.searchParams.get("testDist") ?? body.testDist;
  if (testDistId) {
    const id = parseInt(String(testDistId));
    const result = await runScript(GET_DIST_SCRIPT, [flowArg("UInt64", String(id))]);
    const data = result.parsed ? parseCadence(result.parsed) : null;
    return respond({
      distId: id,
      target: target.key,
      error: result.error,
      data,
      classification: data ? classifyDist(data) : "null",
    });
  }

  // ── Batch seeder / scanner ───────────────────────────────────────────
  const state = await loadState(target.stateId);
  const startIdOverride = url.searchParams.get("startId") ?? body.startId;
  const batchSizeParam = url.searchParams.get("batchSize") ?? body.batchSize;
  const resetParam = url.searchParams.get("reset") ?? body.reset;
  const scanOnly = (url.searchParams.get("scanOnly") ?? String(body.scanOnly)) === "true";

  if (resetParam === "true") {
    await saveState(target.stateId, 1, 0, "running", "manually reset");
    return respond({ ok: true, target: target.key, message: "state reset to cursor=1" });
  }

  const startId = startIdOverride != null ? parseInt(String(startIdOverride)) : state.cursor;
  const batchSize = batchSizeParam != null ? parseInt(String(batchSizeParam)) : 50;

  const startTime = Date.now();
  const stats = {
    scanned: 0, allday: 0, golazos: 0, topshot: 0, other: 0, nulls: 0, upserted: 0,
    errors: [] as string[],
    unknown_samples: [] as any[],
  };
  const rows: any[] = [];

  for (let distId = startId; distId < startId + batchSize && distId <= MAX_DIST_ID; distId++) {
    stats.scanned++;
    const result = await runScript(GET_DIST_SCRIPT, [flowArg("UInt64", String(distId))]);
    if (result.error) { stats.errors.push(`dist ${distId}: ${result.error.slice(0,80)}`); continue; }
    const data = parseCadence(result.parsed) as Record<string,string> | null;
    if (!data) { stats.nulls++; continue; }

    const classification = classifyDist(data);
    const title: string = data.title ?? "";
    const productID = data.meta_productID ?? data.meta_productId ?? "";
    const allMeta: Record<string,string> = {};
    for (const [k,v] of Object.entries(data)) {
      if (k.startsWith("meta_")) allMeta[k.slice(5)] = String(v);
    }

    // Count every bucket for observability, but only ingest rows that match
    // the active target. Non-target buckets are no-ops for this invocation.
    if (classification === "golazos") stats.golazos++;
    else if (classification === "topshot") stats.topshot++;
    else if (classification === "allday") stats.allday++;
    else {
      stats.other++;
      if (stats.unknown_samples.length < 5) stats.unknown_samples.push({ distId, title, productID, meta: allMeta });
    }

    if (classification !== target.key) continue;
    if (scanOnly) continue;

    rows.push({
      collection_id: target.collectionId,
      dist_id: String(distId),
      title,
      nft_type: productID || target.nftType,
      total_minted: 0,
      total_opened: 0,
      metadata: allMeta,
      updated_at: new Date().toISOString(),
    });
  }

  if (!scanOnly && rows.length > 0) {
    const { error } = await supabase
      .from("pack_distributions")
      .upsert(rows, { onConflict: "dist_id,collection_id" });
    if (error) stats.errors.push(`upsert: ${error.message}`);
    else stats.upserted = rows.length;
  }

  const elapsed = Date.now() - startTime;
  const endId = Math.min(startId + batchSize - 1, MAX_DIST_ID);
  const nextStart = endId < MAX_DIST_ID ? endId + 1 : null;

  // Track consecutive-empty-batch count in notes for the stop-after-ceiling rule.
  // "Empty" here means zero hits for the active target, not zero rows overall.
  let noteEmpty = 0;
  if (state.notes) {
    const m = state.notes.match(/empty_runs=(\d+)/);
    if (m) noteEmpty = parseInt(m[1]);
  }
  const hitsForTarget = target.key === "allday" ? stats.allday : stats.golazos;
  if (hitsForTarget === 0) noteEmpty++;
  else noteEmpty = 0;

  let newCursor: number;
  let newStatus: string;
  let newNotes: string | null = `empty_runs=${noteEmpty}`;
  if (nextStart === null) {
    newCursor = MAX_DIST_ID + 1;
    newStatus = "completed";
    newNotes = `reached MAX_DIST_ID=${MAX_DIST_ID}; empty_runs=${noteEmpty}`;
  } else if (noteEmpty >= EMPTY_RUNS_TO_STOP && startId > MAX_DIST_ID) {
    newCursor = startId;
    newStatus = "idle";
    newNotes = `paused after ${noteEmpty} empty runs past ceiling`;
  } else {
    newCursor = nextStart;
    newStatus = "running";
  }

  const newTotal = state.totalIngested + stats.upserted;
  if (startIdOverride == null) {
    // Only persist state when using state-driven progression (not manual override).
    await saveState(target.stateId, newCursor, newTotal, newStatus, newNotes);
  }

  console.log(`${target.logPrefix} scanned=${stats.scanned} target=${target.key} hits=${hitsForTarget} allday=${stats.allday} golazos=${stats.golazos} topshot=${stats.topshot} other=${stats.other} nulls=${stats.nulls} upserted=${stats.upserted} cursor=${startId}->${newCursor} status=${newStatus} elapsed=${elapsed}ms`);
  return respond({ ok: true, target: target.key, ...stats, startId, endId, nextStart, cursor: newCursor, status: newStatus, empty_runs: noteEmpty, elapsed });
});
