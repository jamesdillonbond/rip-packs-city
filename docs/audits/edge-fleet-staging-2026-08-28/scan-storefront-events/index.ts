import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const INGEST_SECRET = Deno.env.get("INGEST_SECRET_TOKEN");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const SPORK_PROXY_SECRET = Deno.env.get("INGEST_SECRET_TOKEN");
const SPORK_PROXY_URL = "https://spork-proxy.tdillonbond.workers.dev";
const CURRENT_ACCESS = "https://rest-mainnet.onflow.org";
const CURRENT_SPORK_ROOT = 137_390_146;
const EVENT_TYPE = "A.4eb8a10cb9f87357.NFTStorefrontV2.ListingAvailable";
const CHUNK_SIZE = 249;
const MAX_CHUNKS = 20; // 4,980 blocks/run — conservative, ~20s worst case
const HISTORICAL_TIMEOUT_MS = 5000; // 5s per chunk max — 20 chunks x 5s = 100s worst case
const CURRENT_TIMEOUT_MS = 12000;
const CHECKPOINT_KEY = "storefront_audit";

async function fetchEventsChunk(startHeight: number, endHeight: number): Promise<any[]> {
  const isHistorical = startHeight < CURRENT_SPORK_ROOT;
  const timeoutMs = isHistorical ? HISTORICAL_TIMEOUT_MS : CURRENT_TIMEOUT_MS;

  const url = isHistorical
    ? `${SPORK_PROXY_URL}?event_type=${encodeURIComponent(EVENT_TYPE)}&start_height=${startHeight}&end_height=${endHeight}`
    : `${CURRENT_ACCESS}/v1/events?type=${encodeURIComponent(EVENT_TYPE)}&start_height=${startHeight}&end_height=${endHeight}`;

  const headers: Record<string, string> = isHistorical
    ? { "Authorization": `Bearer ${SPORK_PROXY_SECRET}` }
    : {};

  try {
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!resp.ok) {
      console.log(`[scan] HTTP ${resp.status} ${startHeight}-${endHeight}`);
      return [];
    }
    return await resp.json();
  } catch (e: any) {
    const reason = (e.name === "TimeoutError" || e.name === "AbortError") ? `timeout(${timeoutMs}ms)` : e.message;
    console.log(`[scan] ${startHeight}-${endHeight}: ${reason}`);
    return [];
  }
}

Deno.serve(async (req: Request) => {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${INGEST_SECRET}`) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_KEY!);
  const body = await req.json().catch(() => ({}));

  let startHeight: number = body.start_height;
  if (!startHeight) {
    const { data } = await supabase
      .from("scan_checkpoint")
      .select("block_height")
      .eq("key", CHECKPOINT_KEY)
      .single();
    startHeight = data?.block_height ?? 85_000_000;
  }

  let endHeight: number = body.end_height;
  if (!endHeight) {
    try {
      const resp = await fetch(`${CURRENT_ACCESS}/v1/blocks?height=sealed`, { signal: AbortSignal.timeout(10000) });
      if (resp.ok) {
        const blocks = await resp.json();
        endHeight = parseInt(blocks[0]?.header?.height ?? "0") - 50;
      }
    } catch (_) {}
    if (!endHeight) {
      return new Response(JSON.stringify({ error: "Could not determine chain tip" }), { status: 500 });
    }
  }

  if (startHeight >= endHeight) {
    return new Response(JSON.stringify({ ok: true, message: "At chain tip", block_height: startHeight }));
  }

  const addresses = new Set<string>();
  let chunksProcessed = 0;
  let timeouts = 0;
  let currentStart = startHeight;

  while (currentStart <= endHeight && chunksProcessed < MAX_CHUNKS) {
    let currentEnd = Math.min(currentStart + CHUNK_SIZE - 1, endHeight);
    if (currentStart < CURRENT_SPORK_ROOT && currentEnd >= CURRENT_SPORK_ROOT) {
      currentEnd = CURRENT_SPORK_ROOT - 1;
    }

    const blocks = await fetchEventsChunk(currentStart, currentEnd);
    if (blocks.length === 0 && currentStart < CURRENT_SPORK_ROOT) timeouts++;

    for (const block of blocks) {
      for (const event of (block.events || [])) {
        try {
          const payload = JSON.parse(atob(event.payload));
          const addrField = (payload?.value?.fields || []).find((f: any) => f.name === "storefrontAddress");
          if (addrField?.value?.value) addresses.add(addrField.value.value);
        } catch (_) {}
      }
    }

    currentStart = currentEnd + 1;
    chunksProcessed++;
    await new Promise(r => setTimeout(r, 50));
  }

  const scannedThrough = currentStart - 1;

  await supabase
    .from("scan_checkpoint")
    .upsert({ key: CHECKPOINT_KEY, block_height: scannedThrough, updated_at: new Date().toISOString() });

  let upserted = 0;
  if (addresses.size > 0) {
    const rows = Array.from(addresses).map(addr => ({
      address: addr,
      source_block_min: startHeight,
      source_block_max: scannedThrough,
    }));
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await supabase
        .from("storefront_audit_wallets")
        .upsert(rows.slice(i, i + 500), { onConflict: "address", ignoreDuplicates: true });
      if (error) console.log("[scan] Upsert error:", error.message);
      else upserted += rows.slice(i, i + 500).length;
    }
  }

  const progressPct = Math.round(((scannedThrough - 85_000_000) / (endHeight - 85_000_000)) * 100);

  return new Response(JSON.stringify({
    ok: true,
    addresses_found: addresses.size,
    upserted,
    chunks_processed: chunksProcessed,
    timeouts,
    scanned_through: scannedThrough,
    chain_tip: endHeight,
    progress_pct: progressPct,
    historical: startHeight < CURRENT_SPORK_ROOT,
    done: scannedThrough >= endHeight,
  }), { headers: { "Content-Type": "application/json" } });
});
