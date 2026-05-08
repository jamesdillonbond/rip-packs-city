// hybrid-custody-backfill — one-shot enumerator that reads on-chain
// HybridCustody.Manager state for known addresses (seeded_wallets,
// saved_wallets, recent buyers/sellers from analytics_sales) and seeds
// linked_accounts via record_link_state with source='script'.
//
// Why: the recurring hybrid-custody-events ingester only catches AccountUpdated
// events emitted after we started watching. Account links established before
// that are invisible without reading current storage — which this function does.
//
// Trigger: ad-hoc curl, NOT cron. Returns 202 immediately and runs in
// EdgeRuntime.waitUntil() until completion or the platform deadline.
//
// Idempotency: record_link_state with p_event_block=null only writes when no
// event-based row exists yet (or when the prior row was also script-sourced).
// Re-running the backfill never overrides real chain events with stale script
// reads.

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

const PIPELINE_NAME = "hybrid_custody_backfill";
const SALES_LOOKBACK_DAYS = 90;
const CONCURRENCY = 5;
const PER_CALL_TIMEOUT_MS = 12_000;

// Embedded copy of cadence/scripts/get-hybrid-custody-state.cdc — bundling
// avoids any filesystem questions in the Supabase edge runtime. Keep this
// in sync if the source file changes (no automated check today).
const CADENCE_SCRIPT = `import HybridCustody from 0xd8a7e05a7ac670c0

access(all) struct LinkedAccountState {
    access(all) let address: Address
    access(all) let hasManager: Bool
    access(all) let childAddresses: [Address]
    access(all) let ownedAddresses: [Address]

    init(address: Address, hasManager: Bool, childAddresses: [Address], ownedAddresses: [Address]) {
        self.address = address
        self.hasManager = hasManager
        self.childAddresses = childAddresses
        self.ownedAddresses = ownedAddresses
    }
}

access(all) fun main(addr: Address): LinkedAccountState {
    let acct = getAuthAccount<auth(BorrowValue) &Account>(addr)
    let managerRef = acct.storage.borrow<&HybridCustody.Manager>(
        from: HybridCustody.ManagerStoragePath
    )

    if managerRef == nil {
        return LinkedAccountState(
            address: addr,
            hasManager: false,
            childAddresses: [],
            ownedAddresses: []
        )
    }

    let manager = managerRef!
    return LinkedAccountState(
        address: addr,
        hasManager: true,
        childAddresses: manager.getChildAddresses(),
        ownedAddresses: manager.getOwnedAddresses()
    )
}
`;

const SCRIPT_B64 = btoa(CADENCE_SCRIPT);

// ── Helpers ──────────────────────────────────────────────────────────────────

function authOk(req: Request): boolean {
  const h = req.headers.get("Authorization") ?? "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  return m[1].trim() === INGEST_TOKEN;
}

function encodeAddressArg(addr: string): string {
  return btoa(JSON.stringify({ type: "Address", value: addr }));
}

interface CdcNode {
  type: string;
  value: unknown;
}

// Flow REST /v1/scripts response shape varies — historically it's been
// either a raw base64 string or `{ "value": "<base64>" }`. Handle both.
function extractScriptResultB64(rawText: string): string | null {
  const trimmed = rawText.trim();
  if (!trimmed) return null;
  // Try JSON-wrapped shape first.
  if (trimmed.startsWith("{") || trimmed.startsWith("\"")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === "string") return parsed;
      if (parsed && typeof parsed === "object" && typeof parsed.value === "string") {
        return parsed.value;
      }
      // Unexpected JSON shape — fall through.
      return null;
    } catch {
      // Not JSON. Maybe raw base64.
    }
  }
  // Raw base64.
  return trimmed;
}

function decodeStructResult(b64: string): {
  hasManager: boolean;
  childAddresses: string[];
  ownedAddresses: string[];
} | null {
  try {
    const json = JSON.parse(atob(b64));
    const fields = json?.value?.fields;
    if (!Array.isArray(fields)) return null;
    const byName = new Map<string, CdcNode>();
    for (const f of fields) byName.set(f.name, f.value);

    const hasManagerNode = byName.get("hasManager") as CdcNode | undefined;
    const childArrNode = byName.get("childAddresses") as CdcNode | undefined;
    const ownedArrNode = byName.get("ownedAddresses") as CdcNode | undefined;

    const hasManager = hasManagerNode?.value === true;
    const children = parseAddressArray(childArrNode);
    const owned = parseAddressArray(ownedArrNode);
    return { hasManager, childAddresses: children, ownedAddresses: owned };
  } catch {
    return null;
  }
}

function parseAddressArray(node: CdcNode | undefined): string[] {
  if (!node || node.type !== "Array" || !Array.isArray(node.value)) return [];
  const out: string[] = [];
  for (const child of node.value as Array<CdcNode | unknown>) {
    if (child && typeof child === "object" && (child as CdcNode).type === "Address") {
      const v = (child as CdcNode).value;
      if (typeof v === "string") out.push(v);
    }
  }
  return out;
}

interface ProbeResult {
  address: string;
  ok: boolean;
  hasManager: boolean;
  children: string[];
  owned: string[];
  error: string | null;
}

async function probeAddress(addr: string): Promise<ProbeResult> {
  try {
    const res = await fetch(`${PROXY_URL}/script`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${PROXY_SECRET}`,
      },
      body: JSON.stringify({
        script: SCRIPT_B64,
        arguments: [encodeAddressArg(addr)],
      }),
      signal: AbortSignal.timeout(PER_CALL_TIMEOUT_MS),
    });
    if (!res.ok) {
      let body = "";
      try { body = (await res.text()).slice(0, 200); } catch { /* ignore */ }
      return { address: addr, ok: false, hasManager: false, children: [], owned: [], error: `http_${res.status}:${body}` };
    }
    const text = await res.text();
    const b64 = extractScriptResultB64(text);
    if (!b64) {
      return { address: addr, ok: false, hasManager: false, children: [], owned: [], error: `no_result_b64:${text.slice(0, 120)}` };
    }
    const decoded = decodeStructResult(b64);
    if (!decoded) {
      return { address: addr, ok: false, hasManager: false, children: [], owned: [], error: `decode_failed:${b64.slice(0, 120)}` };
    }
    return {
      address: addr,
      ok: true,
      hasManager: decoded.hasManager,
      children: decoded.childAddresses,
      owned: decoded.ownedAddresses,
      error: null,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { address: addr, ok: false, hasManager: false, children: [], owned: [], error: msg.slice(0, 200) };
  }
}

async function recordLink(parent: string, child: string, relationship: "restricted" | "owned"): Promise<boolean> {
  const { error } = await supabase.rpc("record_link_state", {
    p_parent_addr: parent,
    p_child_addr: child,
    p_relationship: relationship,
    p_active: true,
    p_link_uuid: null,
    p_event_tx: null,
    p_event_block: null,
    p_source: "script",
  });
  if (error) {
    console.log(`[hybrid-custody-backfill] record_link_state failed parent=${parent} child=${child}: ${error.message?.slice(0, 200)}`);
    return false;
  }
  return true;
}

async function buildCandidates(): Promise<string[]> {
  const set = new Set<string>();

  // seeded_wallets active
  const seeded = await supabase
    .from("seeded_wallets")
    .select("wallet_address")
    .eq("is_active", true);
  if (seeded.error) throw new Error(`seeded_wallets read: ${seeded.error.message}`);
  for (const r of (seeded.data ?? [])) {
    if (r?.wallet_address) set.add(String(r.wallet_address));
  }

  // saved_wallets (note column is wallet_addr, not wallet_address)
  const saved = await supabase
    .from("saved_wallets")
    .select("wallet_addr");
  if (saved.error) throw new Error(`saved_wallets read: ${saved.error.message}`);
  for (const r of (saved.data ?? [])) {
    if (r?.wallet_addr) set.add(String(r.wallet_addr));
  }

  // distinct buyers + sellers from analytics_sales over the lookback window —
  // two narrow queries (no generic exec RPC available; one each is faster
  // than a UNION across the whole view).
  const sinceIso = new Date(Date.now() - SALES_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  // analytics_sales is a view → safe to .select(); .neq filters out null buyers.
  const buyers = await supabase
    .from("analytics_sales")
    .select("buyer_address")
    .gte("sold_at", sinceIso)
    .not("buyer_address", "is", null)
    .limit(50000);
  if (!buyers.error) {
    for (const r of (buyers.data ?? [])) {
      if (r?.buyer_address) set.add(String(r.buyer_address));
    }
  } else {
    console.log(`[hybrid-custody-backfill] analytics_sales buyers read warning: ${buyers.error.message?.slice(0, 200)}`);
  }
  const sellers = await supabase
    .from("analytics_sales")
    .select("seller_address")
    .gte("sold_at", sinceIso)
    .not("seller_address", "is", null)
    .limit(50000);
  if (!sellers.error) {
    for (const r of (sellers.data ?? [])) {
      if (r?.seller_address) set.add(String(r.seller_address));
    }
  } else {
    console.log(`[hybrid-custody-backfill] analytics_sales sellers read warning: ${sellers.error.message?.slice(0, 200)}`);
  }

  return [...set];
}

async function processWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners: Promise<void>[] = [];
  for (let k = 0; k < concurrency; k++) {
    runners.push((async () => {
      while (true) {
        const i = cursor++;
        if (i >= items.length) return;
        try { await worker(items[i]); } catch (err) {
          console.log(`[hybrid-custody-backfill] worker error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    })());
  }
  await Promise.allSettled(runners);
}

async function writePipelineRun(args: {
  startedAt: string;
  rowsFound: number;
  rowsWritten: number;
  rowsSkipped: number;
  ok: boolean;
  error: string | null;
  extra: Record<string, unknown>;
}): Promise<void> {
  const { error } = await supabase.from("pipeline_runs").insert({
    pipeline: PIPELINE_NAME,
    started_at: args.startedAt,
    finished_at: new Date().toISOString(),
    rows_found: args.rowsFound,
    rows_written: args.rowsWritten,
    rows_skipped: args.rowsSkipped,
    ok: args.ok,
    error: args.error,
    extra: args.extra,
  });
  if (error) {
    console.log(`[hybrid-custody-backfill] pipeline_runs insert error: ${error.message?.slice(0, 200)}`);
  }
}

async function run(startedAtIso: string): Promise<void> {
  const startMs = Date.now();
  let candidates: string[];
  try {
    candidates = await buildCandidates();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await writePipelineRun({
      startedAt: startedAtIso,
      rowsFound: 0,
      rowsWritten: 0,
      rowsSkipped: 0,
      ok: false,
      error: `build_candidates: ${msg.slice(0, 400)}`,
      extra: { phase: "build_candidates", elapsed_ms: Date.now() - startMs },
    });
    return;
  }

  console.log(`[hybrid-custody-backfill] candidate set size=${candidates.length}`);

  let parentsFound = 0;
  let pairsWritten = 0;
  let pairsFailed = 0;
  let probeErrors = 0;
  const errorSamples: string[] = [];

  await processWithConcurrency(candidates, CONCURRENCY, async (addr) => {
    const r = await probeAddress(addr);
    if (!r.ok) {
      probeErrors++;
      if (errorSamples.length < 10 && r.error) errorSamples.push(`${addr}:${r.error.slice(0, 120)}`);
      return;
    }
    if (!r.hasManager) return;
    parentsFound++;
    for (const c of r.children) {
      const ok = await recordLink(addr, c, "restricted");
      if (ok) pairsWritten++; else pairsFailed++;
    }
    for (const o of r.owned) {
      const ok = await recordLink(addr, o, "owned");
      if (ok) pairsWritten++; else pairsFailed++;
    }
  });

  await writePipelineRun({
    startedAt: startedAtIso,
    rowsFound: parentsFound,
    rowsWritten: pairsWritten,
    rowsSkipped: pairsFailed,
    ok: true,
    error: probeErrors > 0 ? `probe_errors=${probeErrors}` : null,
    extra: {
      candidates: candidates.length,
      parents_found: parentsFound,
      pairs_written: pairsWritten,
      pairs_failed: pairsFailed,
      probe_errors: probeErrors,
      error_samples: errorSamples,
      elapsed_ms: Date.now() - startMs,
    },
  });

  console.log(`[hybrid-custody-backfill] done candidates=${candidates.length} parents=${parentsFound} pairs=${pairsWritten} probe_errors=${probeErrors} elapsed_ms=${Date.now() - startMs}`);
}

Deno.serve(async (req: Request) => {
  if (!authOk(req)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const startedAtIso = new Date().toISOString();
  const work = run(startedAtIso).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[hybrid-custody-backfill] fatal: ${msg.slice(0, 400)}`);
  });

  // deno-lint-ignore no-explicit-any
  const er = (globalThis as any).EdgeRuntime;
  if (er && typeof er.waitUntil === "function") er.waitUntil(work);
  // If EdgeRuntime is missing (local dev with `supabase functions serve`),
  // fire-and-forget so the response still returns quickly.

  return new Response(JSON.stringify({
    status: "accepted",
    started_at: startedAtIso,
    note: "Tail pipeline_runs WHERE pipeline='hybrid_custody_backfill' for completion.",
  }), { status: 202, headers: { "Content-Type": "application/json" } });
});
