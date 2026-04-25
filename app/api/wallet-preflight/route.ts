// app/api/wallet-preflight/route.ts
//
// GET /api/wallet-preflight?address=0x...&collection=topshot&count=75
//
// Returns a structured pre-flight diagnostic for whether the given wallet can
// safely bulk-list `count` NFTs from `collection` via Flowty's marketplace
// without hitting a storage capacity panic at execution time.
//
// All work is read-only and on-chain; no DB calls, no auth required.
//
// Example response:
// {
//   "address": "0xbd94cade097e50ac",
//   "collection": "topshot",
//   "collectionPath": "/public/MomentCollection",
//   "requestedCount": 75,
//   "storageUsed": 1234567,
//   "storageCapacity": 2097152,
//   "storageUsedMB": 1.18,
//   "storageCapacityMB": 2.0,
//   "storageHeadroomMB": 0.82,
//   "storageUsedPct": 58.87,
//   "estBytesPerListing": 350,
//   "maxSafeListingCount": 2459,
//   "canFitRequested": true,
//   "readyToList": true,
//   "storefrontInitialized": true,
//   "existingListingCount": 14,
//   "collectionInitialized": true,
//   "collectionItemCount": 312,
//   "ducReceiverPublished": true,
//   "warnings": [],
//   "blockers": [],
//   "fetchedAt": "2026-04-25T18:42:11.123Z"
// }

import { NextRequest, NextResponse } from "next/server";
import { WALLET_PREFLIGHT_CADENCE } from "@/lib/cadence/wallet-preflight";

const FLOW_REST = "https://rest-mainnet.onflow.org/v1";

// Public collection paths per supported collection.
// These are the well-known public capability paths sellers must have published
// on their wallet for Flowty (or any NFTStorefrontV2 frontend) to list NFTs.
//
// IMPORTANT: AllDay / Golazos / UFC paths should be verified against the
// deployed contracts before going live. TopShot is well-known and stable.
const COLLECTION_PATHS: Record<
  string,
  { domain: "public" | "private" | "storage"; identifier: string }
> = {
  topshot: { domain: "public", identifier: "MomentCollection" },
  allday:  { domain: "public", identifier: "AllDayNFTCollection" },
  golazos: { domain: "public", identifier: "GolazosCollection" },
  ufc:     { domain: "public", identifier: "UFC_NFTCollection" },
};

const ADDRESS_RE = /^0x[0-9a-fA-F]{16}$/;
const FETCH_TIMEOUT_MS = 10_000;

export async function GET(req: NextRequest) {
  const url = new URL(req.url);

  // ── Validate inputs ────────────────────────────────────────────────────
  const rawAddress = (url.searchParams.get("address") ?? "").trim().toLowerCase();
  if (!ADDRESS_RE.test(rawAddress)) {
    return NextResponse.json(
      { error: "Missing or invalid 'address' (expected 0x-prefixed 16 hex chars)" },
      { status: 400 }
    );
  }

  const collection = (url.searchParams.get("collection") ?? "topshot").toLowerCase();
  const path = COLLECTION_PATHS[collection];
  if (!path) {
    return NextResponse.json(
      {
        error: `Unknown 'collection' value '${collection}'`,
        supported: Object.keys(COLLECTION_PATHS),
      },
      { status: 400 }
    );
  }

  const countRaw = url.searchParams.get("count") ?? "1";
  const count = parseInt(countRaw, 10);
  if (!Number.isFinite(count) || count < 1 || count > 1000) {
    return NextResponse.json(
      { error: "'count' must be an integer between 1 and 1000" },
      { status: 400 }
    );
  }

  // ── Build JSON-Cadence arguments ───────────────────────────────────────
  // Each argument is base64-encoded JSON per the JSON-Cadence Data Interchange
  // Format. See: https://developers.flow.com/build/cadence/json-cadence-spec
  const args = [
    { type: "Address", value: rawAddress },
    { type: "Path", value: { domain: path.domain, identifier: path.identifier } },
    { type: "UInt32", value: String(count) },
  ];

  const body = {
    script: btoa(WALLET_PREFLIGHT_CADENCE),
    arguments: args.map((a) => btoa(JSON.stringify(a))),
  };

  // ── Execute script against latest sealed block ─────────────────────────
  let res: Response;
  try {
    res = await fetch(`${FLOW_REST}/scripts?block_height=sealed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: "Flow REST request failed",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 502 }
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return NextResponse.json(
      {
        error: `Flow REST returned HTTP ${res.status}`,
        detail: text.slice(0, 500),
      },
      { status: 502 }
    );
  }

  // ── Decode & flatten JSON-Cadence response ─────────────────────────────
  const raw = await res.text();
  let decoded: string;
  try {
    decoded = atob(raw.trim().replace(/^"|"$/g, ""));
  } catch {
    return NextResponse.json(
      { error: "Failed to base64-decode Flow response", detail: raw.slice(0, 200) },
      { status: 502 }
    );
  }

  let cadenceJson: unknown;
  try {
    cadenceJson = JSON.parse(decoded);
  } catch {
    return NextResponse.json(
      { error: "Failed to parse Flow response as JSON", detail: decoded.slice(0, 200) },
      { status: 502 }
    );
  }

  const flat = flattenJsonCadence(cadenceJson);
  if (!flat || typeof flat !== "object") {
    return NextResponse.json(
      { error: "Unexpected JSON-Cadence shape", detail: JSON.stringify(cadenceJson).slice(0, 300) },
      { status: 502 }
    );
  }

  // ── Augment with derived display fields ────────────────────────────────
  const f = flat as Record<string, unknown>;
  const used = Number(f.storageUsed ?? 0);
  const cap = Number(f.storageCapacity ?? 0);
  const head = Number(f.storageHeadroom ?? 0);

  const response = {
    address: rawAddress,
    collection,
    collectionPath: `/${path.domain}/${path.identifier}`,
    ...f,
    storageUsedMB: round2(used / 1_048_576),
    storageCapacityMB: round2(cap / 1_048_576),
    storageHeadroomMB: round2(head / 1_048_576),
    fetchedAt: new Date().toISOString(),
  };

  return NextResponse.json(response, {
    headers: {
      // Storage values move slowly; 30s edge cache is safe and saves Flow REST load.
      "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60",
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────
// JSON-Cadence flattener
// Converts the typed JSON-Cadence wire format into plain JS values.
// Handles primitives, Optional, Array, Dictionary, Struct, Resource, Event.
// ─────────────────────────────────────────────────────────────────────────
function flattenJsonCadence(node: unknown): unknown {
  if (node === null || node === undefined) return null;
  if (typeof node !== "object") return node;

  const n = node as { type?: string; value?: unknown };
  const t = n.type;
  const v = n.value;

  switch (t) {
    case "Bool":
      return v;
    case "String":
      return v;
    case "Address":
      return v;
    case "UInt8":
    case "UInt16":
    case "UInt32":
    case "Int8":
    case "Int16":
    case "Int32": {
      const num = Number(v);
      return Number.isFinite(num) ? num : v;
    }
    case "UInt64":
    case "UInt128":
    case "UInt256":
    case "Int":
    case "Int64":
    case "Int128":
    case "Int256": {
      // Could exceed JS safe integer range — return number when safe, string otherwise
      const num = Number(v);
      return Number.isSafeInteger(num) ? num : String(v);
    }
    case "UFix64":
    case "Fix64":
      return parseFloat(String(v));
    case "Path": {
      const p = v as { domain?: string; identifier?: string } | undefined;
      return p ? `/${p.domain}/${p.identifier}` : null;
    }
    case "Optional":
      return v === null || v === undefined ? null : flattenJsonCadence(v);
    case "Array":
      return Array.isArray(v) ? v.map(flattenJsonCadence) : [];
    case "Dictionary": {
      const out: Record<string, unknown> = {};
      if (Array.isArray(v)) {
        for (const pair of v as Array<{ key: unknown; value: unknown }>) {
          const k = (pair.key as { value?: unknown })?.value;
          out[String(k)] = flattenJsonCadence(pair.value);
        }
      }
      return out;
    }
    case "Struct":
    case "Resource":
    case "Event": {
      const out: Record<string, unknown> = {};
      const composite = v as { fields?: Array<{ name: string; value: unknown }> } | undefined;
      if (composite?.fields) {
        for (const f of composite.fields) {
          out[f.name] = flattenJsonCadence(f.value);
        }
      }
      return out;
    }
    default:
      return v;
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
