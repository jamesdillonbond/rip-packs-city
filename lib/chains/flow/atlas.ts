// lib/chains/flow/atlas.ts
//
// THE LIVE TOP SHOT SOURCE, from Next.js — via the database, in two phases.
//
// `api.production.atlas.dapperlabs.com` (the Connect-RPC backend nbatopshot.com
// itself calls) answers unauthenticated from Supabase pg_net and is WAF-blocked
// from Vercel and Cloudflare Workers (2026-09-04 audit). So a request that needs
// a live answer inside an API call goes DB-side: a SECURITY DEFINER function
// enqueues the pg_net request and a second one polls `net._http_response`.
//
// ⚠ WHY TWO CALLS, NOT ONE. pg_net only SENDS after the enqueuing transaction
// COMMITS (measured 2026-09-06: a request posted and polled inside one
// transaction is never answered and rolls back with it). A single
// "post-then-poll" RPC is therefore structurally impossible — `*_begin` returns
// the request id and PostgREST commits; `*_collect` runs in the next
// transaction, whose READ COMMITTED poll loop sees the worker's row.
//
// ⚠ BURST-SENSITIVE. Cloudflare in front of Atlas runs a managed challenge on
// this egress IP at a ~5–15 % base rate that climbed to 100 % for ~4 minutes
// after a 60-request burst (09-06). Every failure here is a FAILED READ — the
// caller must say so, never render it as "not found" / "not listed".
//
// Migration: audit_20260906_atlas_market_feed_the_topshot_listing_and_sale_firehose.

export type AtlasDb = {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message?: string } | null }>;
};

export type AtlasFailure = { ok: false; error: string; status: number | null };

export type AtlasUsername =
  | {
      ok: true;
      found: boolean;
      /** 0x-prefixed, lowercase; null when not found. */
      flowAddress: string | null;
      username: string | null;
      profileImageUrl: string | null;
      createdAt: string | null;
    }
  | AtlasFailure;

export type AtlasListing =
  | {
      ok: true;
      /** An OPEN listing by `wallet` (at `priceCents` when given) exists right now. */
      matched: boolean;
      /** Open listings on this nft by ANY seller. */
      openListings: number;
      listedAt: string | null;
      priceCents: number | null;
      serialNumber: number | null;
      listingResourceId: string | null;
    }
  | AtlasFailure;

const DEFAULT_MAX_MS = 8000;

function failure(error: unknown, status: number | null = null): AtlasFailure {
  const msg = error instanceof Error ? error.message : typeof error === "string" ? error : JSON.stringify(error ?? null);
  return { ok: false, error: String(msg).slice(0, 200), status };
}

function isFailure(v: Record<string, unknown> | AtlasFailure): v is AtlasFailure {
  return v.ok === false && typeof v.error === "string";
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

async function begin(db: AtlasDb, fn: string, args: Record<string, unknown>): Promise<number | AtlasFailure> {
  let res: { data: unknown; error: { message?: string } | null };
  try {
    res = await db.rpc(fn, args);
  } catch (e) {
    return failure(e);
  }
  if (res.error) return failure(res.error.message ?? `${fn} failed`);
  const id = typeof res.data === "number" ? res.data : typeof res.data === "string" ? Number(res.data) : NaN;
  if (!Number.isFinite(id) || id <= 0) return failure(`${fn} returned no request id`);
  return id;
}

async function collect(db: AtlasDb, fn: string, args: Record<string, unknown>): Promise<Record<string, unknown> | AtlasFailure> {
  let res: { data: unknown; error: { message?: string } | null };
  try {
    res = await db.rpc(fn, args);
  } catch (e) {
    return failure(e);
  }
  if (res.error) return failure(res.error.message ?? `${fn} failed`);
  const j = asRecord(res.data);
  if (!j) return failure(`${fn} returned no envelope`);
  if (j.ok !== true) {
    return failure(typeof j.error === "string" ? j.error : "atlas_error", typeof j.status === "number" ? j.status : null);
  }
  return j;
}

function normalizeFlow(addr: unknown): string | null {
  if (typeof addr !== "string" || !addr.trim()) return null;
  const raw = addr.trim().toLowerCase();
  const hex = raw.startsWith("0x") ? raw.slice(2) : raw;
  return /^[0-9a-f]{16}$/.test(hex) ? `0x${hex}` : null;
}

/** Top Shot username → Flow address (Dapper's own profile search). Never throws. */
export async function atlasResolveUsername(db: AtlasDb, username: string, maxMs = DEFAULT_MAX_MS): Promise<AtlasUsername> {
  const cleaned = username.trim().replace(/^@+/, "").trim();
  if (!cleaned || cleaned.length > 64) return failure("bad_username");
  const req = await begin(db, "atlas_resolve_username_begin", { p_username: cleaned });
  if (typeof req !== "number") return req;
  const c = await collect(db, "atlas_resolve_username_collect", { p_request_id: req, p_max_ms: maxMs });
  if (isFailure(c)) return c;
  const j = c;
  const found = j.found === true;
  return {
    ok: true,
    found,
    flowAddress: found ? normalizeFlow(j.flow_address) : null,
    username: typeof j.username === "string" ? j.username : null,
    profileImageUrl: typeof j.profile_image_url === "string" ? j.profile_image_url : null,
    createdAt: typeof j.created_at === "string" ? j.created_at : null,
  };
}

/**
 * Is `nftId` listed on the Top Shot marketplace right now — and, when `wallet`
 * is given, by THAT wallet (at `priceCents`, when given)? The
 * verification-by-listing check with no dead host. Never throws.
 */
export async function atlasVerifyListing(
  db: AtlasDb,
  nftId: string,
  wallet: string | null,
  priceCents: number | null,
  maxMs = DEFAULT_MAX_MS,
): Promise<AtlasListing> {
  const id = String(nftId ?? "").trim();
  if (!/^[0-9]{1,12}$/.test(id)) return failure("bad_nft_id");
  const req = await begin(db, "atlas_verify_listing_begin", { p_nft_id: id });
  if (typeof req !== "number") return req;
  const c = await collect(db, "atlas_verify_listing_collect", {
    p_request_id: req,
    p_wallet: wallet ?? "",
    p_price_cents: priceCents == null ? null : Math.round(priceCents),
    p_max_ms: maxMs,
  });
  if (isFailure(c)) return c;
  const j = c;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
  // A missing count is an UNRENDERABLE answer, not zero listings — three states, never two.
  const openListings = num(j.open_listings);
  if (openListings === null) return failure("atlas envelope carried no open_listings count");
  return {
    ok: true,
    matched: j.matched === true,
    openListings,
    listedAt: typeof j.listed_at === "string" ? j.listed_at : null,
    priceCents: num(j.price_cents),
    serialNumber: num(j.serial_number),
    listingResourceId: typeof j.listing_resource_id === "string" ? j.listing_resource_id : null,
  };
}
