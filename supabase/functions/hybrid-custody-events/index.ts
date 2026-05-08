// hybrid-custody-events — recurring (every 20m) ingester for HybridCustody
// AccountUpdated events. Walks the Flow chain in chunks via the
// hybrid-custody-proxy worker, decodes JSON-CDC payloads, and upserts
// (parent, child, relationship, active) tuples into linked_accounts via
// the record_link_state RPC.
//
// Idempotent — record_link_state guards against monotonic regressions, so
// re-running the same window is safe. The worker /events route caps each
// call at 250 blocks; we iterate windows up to MAX_BLOCKS_PER_RUN per
// invocation. Cron at */20 picks up the rest.
//
// Auth: Authorization: Bearer <INGEST_SECRET_TOKEN>. verify_jwt: false
// (configured in supabase/config.toml or via the dashboard).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const INGEST_TOKEN = Deno.env.get("INGEST_SECRET_TOKEN");
if (!INGEST_TOKEN) throw new Error("INGEST_SECRET_TOKEN is required");

const PROXY_URL = Deno.env.get("HYBRID_CUSTODY_PROXY_URL")
  ?? "https://hybrid-custody-proxy.tdillonbond.workers.dev";
const PROXY_SECRET = Deno.env.get("HYBRID_CUSTODY_PROXY_SECRET") ?? INGEST_TOKEN;

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const HC_ADDR = "d8a7e05a7ac670c0";
const EVENT_TYPE = `A.${HC_ADDR}.HybridCustody.AccountUpdated`;
const CURSOR_ID = "hybrid_custody_events";
const PIPELINE_NAME = "hybrid_custody_events";

const CHUNK_SIZE = 250; // Flow REST /v1/events caps each call at 250 blocks
const MAX_BLOCKS_PER_RUN = 5000;
const FINALITY_BUFFER = 5;
const FIRST_RUN_LOOKBACK = 100;
const INTER_CHUNK_DELAY_MS = 50;

// ── Helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function authOk(req: Request): boolean {
  const h = req.headers.get("Authorization") ?? "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  return m[1].trim() === INGEST_TOKEN;
}

async function proxyHead(): Promise<number> {
  const res = await fetch(`${PROXY_URL}/head`, {
    method: "GET",
    headers: { "Authorization": `Bearer ${PROXY_SECRET}` },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`proxy /head http_${res.status}`);
  const json = await res.json();
  const h = Number(json?.height);
  if (!Number.isFinite(h) || h <= 0) throw new Error(`proxy /head bad payload: ${JSON.stringify(json).slice(0, 200)}`);
  return h;
}

interface FlowEventBlock {
  block_id: string;
  block_height: string;
  block_timestamp: string;
  events?: FlowEvent[];
}

interface FlowEvent {
  type: string;
  transaction_id: string;
  transaction_index: string;
  event_index: string;
  payload: string;
}

async function fetchEventsWindow(start: number, end: number): Promise<FlowEventBlock[]> {
  const res = await fetch(`${PROXY_URL}/events`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${PROXY_SECRET}`,
    },
    body: JSON.stringify({ type: EVENT_TYPE, start_height: start, end_height: end }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    let bodySnippet = "";
    try { bodySnippet = (await res.text()).slice(0, 200); } catch { /* ignore */ }
    throw new Error(`proxy /events http_${res.status} ${bodySnippet}`);
  }
  const json = await res.json();
  if (!Array.isArray(json)) {
    throw new Error(`proxy /events bad payload type=${typeof json}`);
  }
  return json as FlowEventBlock[];
}

// JSON-CDC payload walker. Each event payload is base64-encoded JSON of shape:
//   { "type": "Event", "value": { "id": "<full type>", "fields": [{name, value}, ...] } }
// where each field's value is itself a typed JSON-CDC node:
//   { "type": "Optional", "value": { "type": "UInt64", "value": "123" } | null }
//   { "type": "Address", "value": "0x..." }
//   { "type": "Bool",    "value": true }
//
// We don't depend on field ordering — keyed lookup by name.
interface CdcNode {
  type: string;
  value: unknown;
}

function decodeBase64Json(b64: string): unknown {
  const decoded = atob(b64);
  return JSON.parse(decoded);
}

function unwrap(node: CdcNode | null | undefined): unknown {
  if (!node || typeof node !== "object") return null;
  if (node.type === "Optional") {
    if (node.value === null || node.value === undefined) return null;
    return unwrap(node.value as CdcNode);
  }
  return node.value;
}

interface ParsedAccountUpdated {
  id: bigint | null;
  child: string;
  parent: string;
  active: boolean;
}

function parseAccountUpdatedPayload(b64: string): ParsedAccountUpdated | null {
  try {
    const root = decodeBase64Json(b64) as { value?: { fields?: Array<{ name: string; value: CdcNode }> } };
    const fields = root?.value?.fields;
    if (!Array.isArray(fields)) return null;
    const byName = new Map<string, CdcNode>();
    for (const f of fields) byName.set(f.name, f.value);

    const idNode = byName.get("id");
    const childNode = byName.get("child");
    const parentNode = byName.get("parent");
    const activeNode = byName.get("active");

    const childRaw = unwrap(childNode);
    const parentRaw = unwrap(parentNode);
    const activeRaw = unwrap(activeNode);
    const idRaw = unwrap(idNode);

    if (typeof childRaw !== "string" || typeof parentRaw !== "string") return null;
    if (typeof activeRaw !== "boolean") return null;

    let id: bigint | null = null;
    if (idRaw != null) {
      try { id = BigInt(String(idRaw)); } catch { id = null; }
    }

    return {
      id,
      child: childRaw,
      parent: parentRaw,
      active: activeRaw,
    };
  } catch {
    return null;
  }
}

// ── pipeline_runs writer ─────────────────────────────────────────────────────

interface PipelineRunArgs {
  startedAt: string;
  rowsFound: number;
  rowsWritten: number;
  rowsSkipped: number;
  ok: boolean;
  error: string | null;
  cursorBefore: number | null;
  cursorAfter: number | null;
  extra: Record<string, unknown>;
}

async function writePipelineRun(args: PipelineRunArgs): Promise<void> {
  const { error } = await supabase.from("pipeline_runs").insert({
    pipeline: PIPELINE_NAME,
    started_at: args.startedAt,
    finished_at: new Date().toISOString(),
    rows_found: args.rowsFound,
    rows_written: args.rowsWritten,
    rows_skipped: args.rowsSkipped,
    cursor_before: args.cursorBefore != null ? String(args.cursorBefore) : null,
    cursor_after: args.cursorAfter != null ? String(args.cursorAfter) : null,
    ok: args.ok,
    error: args.error,
    extra: args.extra,
  });
  if (error) {
    console.log(`[hybrid-custody-events] pipeline_runs insert error: ${error.message?.slice(0, 200)}`);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function run(startedAtIso: string): Promise<{
  cursorBefore: number;
  cursorAfter: number;
  blocksScanned: number;
  eventsFound: number;
  rowsWritten: number;
  rowsSkipped: number;
  errors: string[];
}> {
  const errors: string[] = [];

  // Step 1: read cursor (initialise to head - FIRST_RUN_LOOKBACK if sentinel 0)
  const { data: cursorRow, error: cursorErr } = await supabase
    .from("event_cursor")
    .select("last_processed_block")
    .eq("id", CURSOR_ID)
    .single();
  if (cursorErr) throw new Error(`cursor read: ${cursorErr.message}`);

  let lastBlock = Number(cursorRow?.last_processed_block ?? 0);
  const head = await proxyHead();

  if (lastBlock === 0) {
    lastBlock = Math.max(0, head - FIRST_RUN_LOOKBACK);
    console.log(`[hybrid-custody-events] first run, initialising cursor at ${lastBlock} (head ${head})`);
  }

  // Step 2: compute scan range
  const start = lastBlock + 1;
  const targetEnd = Math.min(lastBlock + MAX_BLOCKS_PER_RUN, head - FINALITY_BUFFER);
  if (targetEnd < start) {
    console.log(`[hybrid-custody-events] up to date — cursor=${lastBlock}, head=${head}`);
    return {
      cursorBefore: lastBlock,
      cursorAfter: lastBlock,
      blocksScanned: 0,
      eventsFound: 0,
      rowsWritten: 0,
      rowsSkipped: 0,
      errors,
    };
  }

  console.log(`[hybrid-custody-events] scanning ${start}..${targetEnd} (${targetEnd - start + 1} blocks, head=${head})`);

  // Step 3: walk windows of CHUNK_SIZE
  let eventsFound = 0;
  let rowsWritten = 0;
  let rowsSkipped = 0;

  let furthestProcessed = lastBlock;

  for (let s = start; s <= targetEnd; s += CHUNK_SIZE) {
    const e = Math.min(s + CHUNK_SIZE - 1, targetEnd);
    let blocks: FlowEventBlock[];
    try {
      blocks = await fetchEventsWindow(s, e);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${s}-${e}: ${msg.slice(0, 200)}`);
      console.log(`[hybrid-custody-events] window ${s}-${e} fetch failed: ${msg.slice(0, 200)}`);
      // Stop advancing the cursor past the last successful window — leaves
      // unscanned chunks for the next cron pass.
      break;
    }

    for (const blk of blocks) {
      const blockHeight = Number(blk.block_height);
      const events = blk.events ?? [];
      for (const evt of events) {
        eventsFound++;
        const parsed = parseAccountUpdatedPayload(evt.payload);
        if (!parsed) {
          rowsSkipped++;
          console.log(`[hybrid-custody-events] payload parse failed tx=${evt.transaction_id}`);
          continue;
        }
        const { error: rpcErr } = await supabase.rpc("record_link_state", {
          p_parent_addr: parsed.parent,
          p_child_addr: parsed.child,
          p_relationship: "restricted",
          p_active: parsed.active,
          p_link_uuid: parsed.id != null ? Number(parsed.id) : null,
          p_event_tx: evt.transaction_id ?? null,
          p_event_block: Number.isFinite(blockHeight) ? blockHeight : null,
          p_source: "event",
        });
        if (rpcErr) {
          rowsSkipped++;
          console.log(`[hybrid-custody-events] record_link_state failed parent=${parsed.parent} child=${parsed.child}: ${rpcErr.message?.slice(0, 200)}`);
        } else {
          rowsWritten++;
        }
      }
    }

    furthestProcessed = e;
    if (e < targetEnd) await sleep(INTER_CHUNK_DELAY_MS);
  }

  // Step 4: advance cursor to furthestProcessed (might be < targetEnd if we
  // bailed out mid-window).
  if (furthestProcessed > lastBlock) {
    const { error: updErr } = await supabase
      .from("event_cursor")
      .update({ last_processed_block: furthestProcessed, updated_at: new Date().toISOString() })
      .eq("id", CURSOR_ID);
    if (updErr) throw new Error(`cursor write: ${updErr.message}`);
  }

  return {
    cursorBefore: lastBlock,
    cursorAfter: furthestProcessed,
    blocksScanned: furthestProcessed - lastBlock,
    eventsFound,
    rowsWritten,
    rowsSkipped,
    errors,
  };
}

Deno.serve(async (req: Request) => {
  if (!authOk(req)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const startedAtIso = new Date().toISOString();
  const startMs = Date.now();
  try {
    const r = await run(startedAtIso);
    await writePipelineRun({
      startedAt: startedAtIso,
      rowsFound: r.eventsFound,
      rowsWritten: r.rowsWritten,
      rowsSkipped: r.rowsSkipped,
      ok: r.errors.length === 0,
      error: r.errors.length === 0 ? null : r.errors.join(" | ").slice(0, 500),
      cursorBefore: r.cursorBefore,
      cursorAfter: r.cursorAfter,
      extra: {
        blocks_scanned: r.blocksScanned,
        elapsed_ms: Date.now() - startMs,
        errors: r.errors,
      },
    });
    return new Response(JSON.stringify({
      ok: r.errors.length === 0,
      blocks_scanned: r.blocksScanned,
      events_found: r.eventsFound,
      rows_written: r.rowsWritten,
      rows_skipped: r.rowsSkipped,
      cursor_before: r.cursorBefore,
      cursor_after: r.cursorAfter,
      elapsed_ms: Date.now() - startMs,
      errors: r.errors,
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[hybrid-custody-events] fatal: ${msg.slice(0, 400)}`);
    await writePipelineRun({
      startedAt: startedAtIso,
      rowsFound: 0,
      rowsWritten: 0,
      rowsSkipped: 0,
      ok: false,
      error: msg.slice(0, 500),
      cursorBefore: null,
      cursorAfter: null,
      extra: { fatal: true, elapsed_ms: Date.now() - startMs },
    });
    return new Response(JSON.stringify({ ok: false, error: msg.slice(0, 500) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
