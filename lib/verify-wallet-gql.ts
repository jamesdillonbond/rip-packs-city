// lib/verify-wallet-gql.ts
//
// Shared Top Shot GQL helper for the wallet-verification listing challenge.
// Both the mint route (picks a target, confirms it's unlocked + unlisted) and
// the check route (confirms the target is now listed at the challenge amount)
// read a single moment's live listing state through this helper.
//
// Top Shot GraphQL MUST be reached through the topshot-proxy worker —
// Cloudflare blocks Vercel/Supabase egress to public-api.nbatopshot.com.
// In production TS_PROXY_URL points at the proxy; the literal is a dev
// fallback only. X-Proxy-Secret = TS_PROXY_SECRET.

const TS_GQL = process.env.TS_PROXY_URL || "https://public-api.nbatopshot.com/graphql";
const TS_PROXY_SECRET = process.env.TS_PROXY_SECRET || "";

export type MomentListingState = {
  momentId: string;
  forSale: boolean;
  price: number | null;
  isLocked: boolean;
  found: boolean;
};

// Per-moment listing-state lookup (the proven getMintedMoment shape used by
// app/api/wallet-search). Throws on transport/GQL error so callers can surface
// a clean "try again" hint.
export async function fetchMomentListingState(momentId: string): Promise<MomentListingState> {
  const query = `
    query VerifyMoment($id: ID!) {
      getMintedMoment(momentId: $id) {
        data { ... on MintedMoment { forSale price isLocked } }
      }
    }
  `;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (TS_PROXY_SECRET) headers["x-proxy-secret"] = TS_PROXY_SECRET;

  const res = await fetch(TS_GQL, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables: { id: momentId } }),
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });

  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`Top Shot GQL HTTP ${res.status}: ${raw.slice(0, 160)}`);
  }
  let json: {
    data?: { getMintedMoment?: { data?: { forSale?: unknown; price?: unknown; isLocked?: unknown } | null } | null };
    errors?: Array<{ message?: string }>;
  };
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("Top Shot GQL returned non-JSON");
  }
  if (Array.isArray(json.errors) && json.errors.length) {
    throw new Error(json.errors.map((e) => e?.message).filter(Boolean).join("; ").slice(0, 200) || "GQL error");
  }

  const node = json.data?.getMintedMoment?.data ?? null;
  const rawPrice = node && node.price != null ? Number(node.price) : null;
  return {
    momentId,
    found: !!node,
    forSale: !!node?.forSale,
    price: Number.isFinite(rawPrice as number) ? (rawPrice as number) : null,
    isLocked: !!node?.isLocked,
  };
}

// Exact-match in cents to avoid float drift.
export function priceMatchesCents(price: number | null, amount: number): boolean {
  if (price === null || !Number.isFinite(price)) return false;
  return Math.round(price * 100) === Math.round(amount * 100);
}

// Native Top Shot moment page (the owner lists from here). Confirmed format:
// https://nbatopshot.com/moment/<momentId> (see collection/page.tsx).
export function topShotMomentUrl(momentId: string): string {
  return `https://nbatopshot.com/moment/${encodeURIComponent(momentId)}`;
}
