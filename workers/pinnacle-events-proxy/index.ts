// Pinnacle chain-events proxy. Thin pass-through to rest-mainnet.onflow.org
// /v1/events that consolidates rate-limit + auth so the Vercel cron caller
// doesn't have to re-implement either.
//
// Auth: Authorization: Bearer <INGEST_SECRET_TOKEN>
// Request: POST /events with body { startHeight, endHeight, eventType? }
// Response: { events: [...], cursor: nextHeight, complete: boolean }
//
// ── Pushback on Round 10 Item 2A's premise ────────────────────────────────
//
// The prompt expected eventType = "A.edf9df96c92f4595.Pinnacle.NFTListed".
// That event does not exist on-chain (verified 2026-05-12 against the
// deployed PinnacleTrade + Pinnacle contracts at 0xedf9df96c92f4595).
// PinnacleTrade emits NFT-for-NFT trade-proposal events (no price field).
// Pinnacle emits Purchased (primary release sales), PinNFTMinted, Withdraw,
// Deposit. None of these are cash-listing events for the secondary market.
//
// Pinnacle's actual cash-listing flow is on Dapper's NFTStorefrontV2 at
// 0x4eb8a10cb9f87357 (same pattern as Top Shot). The right event to walk
// is A.4eb8a10cb9f87357.NFTStorefrontV2.ListingAvailable with downstream
// filtering on nftType.staticType.typeID = A.edf9df96c92f4595.Pinnacle.NFT.
// This is what `app/api/allday-listings-indexer/route.ts` already does
// for AllDay (modulo a different storefront fork at 0x3cdbb3d569211ff3).
//
// DEFAULT_EVENT_TYPE below reflects on-chain reality. Override via the
// request body when needed.

interface Env {
  INGEST_SECRET_TOKEN: string;
}

const FLOW_REST = "https://rest-mainnet.onflow.org";
const DEFAULT_EVENT_TYPE = "A.4eb8a10cb9f87357.NFTStorefrontV2.ListingAvailable";
const CHUNK_SIZE = 250;          // Flow REST events /v1/events range limit
const MAX_RANGE_BLOCKS = 50_000; // force callers to paginate above this
const INTER_REQUEST_DELAY_MS = 67; // ~15 req/s, under Flow's 20 req/s
const REQUEST_TIMEOUT_MS = 20_000;

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function jsonError(status: number, error: string, extra?: Record<string, unknown>) {
  return new Response(
    JSON.stringify({ error, ...extra }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

// Health check, intentionally unauthenticated so we can confirm the Worker
// is reachable without shipping the secret.
function healthOk() {
  return new Response(
    JSON.stringify({
      ok: true,
      worker: "pinnacle-events-proxy",
      default_event_type: DEFAULT_EVENT_TYPE,
      max_range_blocks: MAX_RANGE_BLOCKS,
      chunk_size: CHUNK_SIZE,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

interface FlowEventBlock {
  block_height: string;
  block_timestamp: string;
  events?: Array<{ payload: string; transaction_id: string; event_index: number; type: string }>;
}

async function fetchEventChunk(eventType: string, start: number, end: number): Promise<FlowEventBlock[]> {
  const url = `${FLOW_REST}/v1/events?type=${encodeURIComponent(eventType)}&start_height=${start}&end_height=${end}`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`flow rest HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const json = (await res.json()) as FlowEventBlock[];
  return Array.isArray(json) ? json : [];
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);

      // GET / = health check.
      if (request.method === "GET") {
        return healthOk();
      }
      // Only POST /events past this point.
      if (request.method !== "POST" || url.pathname !== "/events") {
        return jsonError(405, "method_or_path_not_allowed", {
          hint: "POST /events with body {startHeight, endHeight, eventType?}",
        });
      }

      const auth = request.headers.get("Authorization") ?? "";
      const expected = `Bearer ${env.INGEST_SECRET_TOKEN}`;
      if (!env.INGEST_SECRET_TOKEN || auth !== expected) {
        return jsonError(401, "unauthorized");
      }

      let body: { startHeight?: number; endHeight?: number; eventType?: string };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return jsonError(400, "invalid_json_body");
      }

      const startHeight = Number(body.startHeight);
      const endHeight = Number(body.endHeight);
      const eventType = (body.eventType ?? DEFAULT_EVENT_TYPE).trim();

      if (!Number.isFinite(startHeight) || !Number.isFinite(endHeight)) {
        return jsonError(400, "invalid_height_args", {
          hint: "startHeight and endHeight must be integers",
        });
      }
      if (startHeight > endHeight) {
        return jsonError(400, "invalid_range", {
          hint: "startHeight must be <= endHeight",
        });
      }
      const rangeSize = endHeight - startHeight + 1;
      if (rangeSize > MAX_RANGE_BLOCKS) {
        return jsonError(400, "range_too_large", {
          hint: `request <= ${MAX_RANGE_BLOCKS} blocks per call; got ${rangeSize}`,
          max_range_blocks: MAX_RANGE_BLOCKS,
        });
      }

      // Walk in CHUNK_SIZE-block chunks. ~15 req/s.
      const allEvents: Array<Record<string, unknown>> = [];
      for (let s = startHeight; s <= endHeight; s += CHUNK_SIZE) {
        const e = Math.min(s + CHUNK_SIZE - 1, endHeight);
        try {
          const blocks = await fetchEventChunk(eventType, s, e);
          for (const blk of blocks) {
            const bh = Number(blk.block_height);
            const bts = blk.block_timestamp;
            for (const evt of blk.events ?? []) {
              allEvents.push({
                block_height: bh,
                block_timestamp: bts,
                transaction_id: evt.transaction_id,
                event_index: evt.event_index,
                type: evt.type,
                payload: evt.payload,
              });
            }
          }
        } catch (chunkErr) {
          return jsonError(502, "upstream_chunk_failed", {
            chunk_start: s,
            chunk_end: e,
            detail: chunkErr instanceof Error ? chunkErr.message : String(chunkErr),
            events_so_far: allEvents.length,
          });
        }
        if (s + CHUNK_SIZE <= endHeight) await delay(INTER_REQUEST_DELAY_MS);
      }

      return new Response(
        JSON.stringify({
          events: allEvents,
          cursor: endHeight + 1,
          complete: true,
          event_type: eventType,
          blocks_scanned: rangeSize,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    } catch (err) {
      const e = err as Error;
      return jsonError(500, "internal", {
        message: e?.message ?? String(err),
      });
    }
  },
};
