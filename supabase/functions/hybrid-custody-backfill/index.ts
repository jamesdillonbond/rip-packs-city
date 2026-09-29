// hybrid-custody-backfill — enumerator that reads on-chain HybridCustody state
// for known addresses (seeded_wallets, saved_wallets, recent buyers/sellers
// from analytics_sales) and seeds linked_accounts via record_link_state with
// source='script'.
//
// Why: the recurring hybrid-custody-events ingester only catches AccountUpdated
// events emitted after we started watching (block 151,110,101, 2026-05-10).
// Account links established before that are invisible without reading current
// storage — which this function does.
//
// ⚠ It reads BOTH sides of every candidate (2026-09-29). Until then it asked
// only "does this address hold a Manager?" — but candidates are Dapper
// addresses, i.e. CHILDREN, and their Flow Wallet parents are in no candidate
// list. That run wrote 6 pairs; an on-chain census found 140 of 147 redeemed
// links on saved+seeded wallets (and 65 of 67 on a 400-trader sample) absent.
// The child side (OwnedAccount redeemed parents) closes it.
//
// Trigger: ad-hoc POST, NOT cron. Returns 202 immediately and runs in
// EdgeRuntime.waitUntil() until completion or the platform deadline. The full
// candidate set (~6.8k) outruns one invocation, so page it:
//   body {"scope":"wallets"}                 saved+seeded only
//   body {"scope":"all","offset":0,"limit":1500}  the RPC set, one page
// extra.next_offset in pipeline_runs names the next page (null = done).
//
// Idempotency: record_link_state with p_event_block=null only writes when no
// event-based row exists yet (or when the prior row was also script-sourced).
// Re-running the backfill never overrides real chain events with stale script
// reads.

import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";

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
// One page must finish inside the edge wall clock (~400 s); ~20 probes/s at
// CONCURRENCY 5 makes 1500 a safe page.
const DEFAULT_LIMIT = 1500;
const MAX_LIMIT = 3000;

// Embedded copy of cadence/scripts/get-hybrid-custody-state.cdc — bundling
// avoids any filesystem questions in the Supabase edge runtime. Keep this
// in sync if the source file changes (no automated check today).
const CADENCE_SCRIPT = `// HybridCustody state probe — reads BOTH sides of the link for one address.
//
//   Parent side: whether the address has a HybridCustody.Manager in storage
//   and, if so, its child + owned accounts.
//   Child side:  whether the address is itself a HybridCustody OwnedAccount
//   and, if so, which parents have REDEEMED it (pending, unredeemed parents
//   are excluded — they hold no capability yet).
//
// Used by the hybrid-custody-backfill edge function to enumerate account-
// linking state across known addresses (seeded_wallets, saved_wallets, recent
// buyers/sellers) since the event ingester only sees links made after its
// cursor started (block 151,110,101, 2026-05-10).
//
// ⚠ Why the child side exists (2026-09-29): the candidate set is almost all
// Dapper addresses, which are CHILDREN. Their parents are Flow Wallet
// addresses that are in no candidate list, so a parent-side-only probe found
// 6 pairs in total and linked_accounts missed 140 of 147 redeemed links held
// by saved+seeded wallets (0xbd94cade097e50ac among them).
//
// Resilience:
//   - Uses authAccount.storage.borrow so we read storage directly without
//     depending on a public capability being published.
//   - Returns a fully-populated empty struct when neither resource exists
//     (rather than panicking) so the caller can mark the address as scanned.

import HybridCustody from 0xd8a7e05a7ac670c0

access(all) struct LinkedAccountState {
    access(all) let address: Address
    access(all) let hasManager: Bool
    access(all) let childAddresses: [Address]
    access(all) let ownedAddresses: [Address]
    access(all) let isOwnedAccount: Bool
    access(all) let redeemedParents: [Address]

    init(
        address: Address,
        hasManager: Bool,
        childAddresses: [Address],
        ownedAddresses: [Address],
        isOwnedAccount: Bool,
        redeemedParents: [Address]
    ) {
        self.address = address
        self.hasManager = hasManager
        self.childAddresses = childAddresses
        self.ownedAddresses = ownedAddresses
        self.isOwnedAccount = isOwnedAccount
        self.redeemedParents = redeemedParents
    }
}

access(all) fun main(addr: Address): LinkedAccountState {
    let acct = getAuthAccount<auth(BorrowValue) &Account>(addr)

    var hasManager = false
    var children: [Address] = []
    var owned: [Address] = []
    if let manager = acct.storage.borrow<&HybridCustody.Manager>(from: HybridCustody.ManagerStoragePath) {
        hasManager = true
        children = manager.getChildAddresses()
        owned = manager.getOwnedAddresses()
    }

    var isOwnedAccount = false
    let redeemed: [Address] = []
    if let ownedAcct = acct.storage.borrow<&HybridCustody.OwnedAccount>(from: HybridCustody.OwnedAccountStoragePath) {
        isOwnedAccount = true
        for parent in ownedAcct.getParentStatuses().keys {
            if ownedAcct.getRedeemedStatus(addr: parent) == true {
                redeemed.append(parent)
            }
        }
    }

    return LinkedAccountState(
        address: addr,
        hasManager: hasManager,
        childAddresses: children,
        ownedAddresses: owned,
        isOwnedAccount: isOwnedAccount,
        redeemedParents: redeemed
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
  redeemedParents: string[];
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
    const parentsArrNode = byName.get("redeemedParents") as CdcNode | undefined;
    // A reply without the child-side field is the OLD script (or a shape we do
    // not understand) — refuse it rather than read "no parents" out of absence.
    if (!parentsArrNode) return null;

    const hasManager = hasManagerNode?.value === true;
    const children = parseAddressArray(childArrNode);
    const owned = parseAddressArray(ownedArrNode);
    const redeemedParents = parseAddressArray(parentsArrNode);
    return { hasManager, childAddresses: children, ownedAddresses: owned, redeemedParents };
  } catch {
    return null;
  }
}

interface LinkPair {
  parent: string
  child: string
  relationship: "restricted" | "owned"
}

// Inline copy of the shared probe-decode mirror (drift-guarded).
function linkPairsFromProbe(addr: string, probe: { children: string[]; owned: string[]; redeemedParents: string[] }): LinkPair[] {
  const out: LinkPair[] = [];
  const seen = new Set<string>();
  const add = (parent: string, child: string, relationship: "restricted" | "owned") => {
    const k = `${parent}|${child}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ parent, child, relationship });
  };
  for (const c of probe.children) add(addr, c, "restricted");
  for (const o of probe.owned) add(addr, o, "owned");
  for (const p of probe.redeemedParents) add(p, addr, "restricted");
  return out;
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
  redeemedParents: string[];
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
      return { address: addr, ok: false, hasManager: false, children: [], owned: [], redeemedParents: [], error: `http_${res.status}:${body}` };
    }
    const text = await res.text();
    const b64 = extractScriptResultB64(text);
    if (!b64) {
      return { address: addr, ok: false, hasManager: false, children: [], owned: [], redeemedParents: [], error: `no_result_b64:${text.slice(0, 120)}` };
    }
    const decoded = decodeStructResult(b64);
    if (!decoded) {
      return { address: addr, ok: false, hasManager: false, children: [], owned: [], redeemedParents: [], error: `decode_failed:${b64.slice(0, 120)}` };
    }
    return {
      address: addr,
      ok: true,
      hasManager: decoded.hasManager,
      children: decoded.childAddresses,
      owned: decoded.ownedAddresses,
      redeemedParents: decoded.redeemedParents,
      error: null,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { address: addr, ok: false, hasManager: false, children: [], owned: [], redeemedParents: [], error: msg.slice(0, 200) };
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

type Scope = "all" | "wallets";

async function buildCandidates(scope: Scope): Promise<string[]> {
  const out = new Set<string>();
  if (scope === "wallets") {
    // saved_wallets + active seeded_wallets only — small (~0.3k), one page.
    // A page that comes back FULL may be truncated by the 1000-row cap, so it
    // throws rather than probing a partial list as if it were the whole set.
    const [saved, seeded] = await Promise.all([
      supabase.from("saved_wallets").select("wallet_addr").limit(1000),
      supabase.from("seeded_wallets").select("wallet_address").eq("is_active", true).limit(1000),
    ]);
    if (saved.error) throw new Error(`saved_wallets: ${saved.error.message}`);
    if (seeded.error) throw new Error(`seeded_wallets: ${seeded.error.message}`);
    if ((saved.data ?? []).length >= 1000 || (seeded.data ?? []).length >= 1000) {
      throw new Error("wallet list hit the 1000-row cap — would probe a partial set");
    }
    for (const r of saved.data ?? []) if (typeof r.wallet_addr === "string" && r.wallet_addr) out.add(r.wallet_addr);
    for (const r of seeded.data ?? []) if (typeof r.wallet_address === "string" && r.wallet_address) out.add(r.wallet_address);
  } else {
    // Server-side dedup via RPC. The RPC returns text[] (a scalar) rather than
    // SETOF/TABLE — PostgREST applies its db-max-rows=1000 cap to row-returning
    // RPCs but lets scalar arrays through whole, so a 1.6k-element array survives.
    const { data, error } = await supabase.rpc("get_hybrid_custody_candidates", {
      p_days: SALES_LOOKBACK_DAYS,
    });
    if (error) throw new Error(`get_hybrid_custody_candidates: ${error.message}`);
    const arr = (data ?? []) as unknown;
    if (Array.isArray(arr)) {
      for (const a of arr) {
        if (typeof a === "string" && a) out.add(a);
      }
    }
  }
  // Flow addresses only (a non-Flow key cannot hold a HybridCustody account),
  // sorted so offset/limit pages are stable across invocations.
  return [...out].filter((a) => /^0x[0-9a-fA-F]{16}$/.test(a)).sort();
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

interface RunOpts {
  scope: Scope;
  offset: number;
  limit: number;
}

async function run(startedAtIso: string, opts: RunOpts): Promise<void> {
  const startMs = Date.now();
  let candidates: string[];
  let total = 0;
  try {
    const all = await buildCandidates(opts.scope);
    total = all.length;
    candidates = all.slice(opts.offset, opts.offset + opts.limit);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await writePipelineRun({
      startedAt: startedAtIso,
      rowsFound: 0,
      rowsWritten: 0,
      rowsSkipped: 0,
      ok: false,
      error: `build_candidates: ${msg.slice(0, 400)}`,
      extra: { phase: "build_candidates", scope: opts.scope, elapsed_ms: Date.now() - startMs },
    });
    return;
  }

  console.log(`[hybrid-custody-backfill] candidate set size=${candidates.length}`);

  let parentsFound = 0;
  let childrenFound = 0;
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
    if (r.hasManager) parentsFound++;
    if (r.redeemedParents.length > 0) childrenFound++;
    for (const pair of linkPairsFromProbe(addr, r)) {
      const ok = await recordLink(pair.parent, pair.child, pair.relationship);
      if (ok) pairsWritten++; else pairsFailed++;
    }
  });

  const nextOffset = opts.offset + candidates.length < total ? opts.offset + candidates.length : null;
  // ok means every probe was read AND every link it proved was written — a run
  // with probe errors or failed writes has left links out and must not read green.
  const ok = probeErrors === 0 && pairsFailed === 0;

  await writePipelineRun({
    startedAt: startedAtIso,
    rowsFound: pairsWritten + pairsFailed,
    rowsWritten: pairsWritten,
    rowsSkipped: pairsFailed,
    ok,
    error: ok ? null : `probe_errors=${probeErrors} pairs_failed=${pairsFailed}`,
    extra: {
      scope: opts.scope,
      offset: opts.offset,
      limit: opts.limit,
      candidates_total: total,
      candidates: candidates.length,
      next_offset: nextOffset,
      parents_found: parentsFound,
      children_found: childrenFound,
      pairs_written: pairsWritten,
      pairs_failed: pairsFailed,
      probe_errors: probeErrors,
      error_samples: errorSamples,
      elapsed_ms: Date.now() - startMs,
    },
  });

  console.log(`[hybrid-custody-backfill] done candidates=${candidates.length}/${total} parents=${parentsFound} children=${childrenFound} pairs=${pairsWritten} probe_errors=${probeErrors} elapsed_ms=${Date.now() - startMs}`);
}

Deno.serve(async (req: Request) => {
  if (!authOk(req)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body: Record<string, unknown> = {};
  try {
    const text = await req.text();
    if (text.trim()) body = JSON.parse(text);
  } catch {
    return new Response(JSON.stringify({ error: "body must be JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  const scope: Scope = body.scope === "wallets" ? "wallets" : "all";
  const offset = Math.max(0, Math.floor(Number(body.offset ?? 0)) || 0);
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(Number(body.limit ?? DEFAULT_LIMIT)) || DEFAULT_LIMIT));

  const startedAtIso = new Date().toISOString();
  const work = run(startedAtIso, { scope, offset, limit }).catch((err) => {
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
    scope,
    offset,
    limit,
    note: "Tail pipeline_runs WHERE pipeline='hybrid_custody_backfill' for completion.",
  }), { status: 202, headers: { "Content-Type": "application/json" } });
});
