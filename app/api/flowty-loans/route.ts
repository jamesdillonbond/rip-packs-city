// app/api/flowty-loans/route.ts
//
// Fetches the active Flowty loan book for Top Shot moments.
// Moments used as collateral are signals — high LTV = motivated seller,
// overdue loan = distressed asset.
//
// GET /api/flowty-loans              — full loan book (up to 4 pages)
// GET /api/flowty-loans?limit=50     — limit results

import { NextRequest, NextResponse } from "next/server";

const FLOWTY_ENDPOINT = "https://api2.flowty.io/collection/0x0b2a3299cc857e29/TopShot";
const FLOWTY_HEADERS = {
  "Content-Type": "application/json",
  Origin: "https://www.flowty.io",
  Referer: "https://www.flowty.io/",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/146 Safari/537.36",
};

// High LTV threshold: loan >= 80% of FMV
const HIGH_LTV_THRESHOLD = 0.8;

export interface LoanItem {
  nftID: string;
  momentId: string | null;
  borrower: string;
  loanAmount: number;
  repaymentAmount: number;
  ltv: number | null;
  expiresAt: string | null;
  isOverdue: boolean;
  livetokenFmv: number | null;
  playerName: string;
  setName: string;
  tier: string;
  serialNumber: number;
  circulationCount: number;
  thumbnailUrl: string | null;
}

function buildLoanBody(from: number) {
  return {
    address: null,
    addresses: [],
    collectionFilters: [
      { collection: "0x0b2a3299cc857e29.TopShot", traits: [] },
    ],
    from,
    includeAllListings: true,
    limit: 24,
    onlyUnlisted: false,
    orderFilters: [{ conditions: [], kind: "loan", paymentTokens: [] }],
    sort: { direction: "desc", listingKind: "loan", path: "blockTimestamp" },
  };
}

function getTrait(traits: unknown[], name: string): string {
  if (!Array.isArray(traits)) return "";
  const t = traits.find(
    (tr: any) => tr && (tr.name === name || tr.trait_type === name)
  ) as any;
  return t && t.value ? String(t.value) : "";
}

async function fetchLoanPage(from: number): Promise<any[]> {
  try {
    const res = await fetch(FLOWTY_ENDPOINT, {
      method: "POST",
      headers: FLOWTY_HEADERS,
      body: JSON.stringify(buildLoanBody(from)),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.log(`[flowty-loans] Page ${from} HTTP ${res.status}`);
      return [];
    }
    const json = await res.json();
    const items = json.data || json.nfts || [];
    return Array.isArray(items) ? items : [];
  } catch (e: any) {
    console.log(`[flowty-loans] Page ${from} error: ${e.message || "unknown"}`);
    return [];
  }
}

function mapLoanItem(nft: any, now: number): LoanItem | null {
  try {
    if (!nft) return null;
    const orders = nft.orders;
    if (!Array.isArray(orders) || orders.length === 0) return null;

    // Find the loan order
    const order = orders.find((o: any) => o.listingKind === "loan") || orders[0];
    if (!order) return null;

    const loanAmount = parseFloat(order.amount || order.salePrice || "0");
    const repaymentAmount = parseFloat(order.repaymentAmount || order.totalRepayment || "0");
    if (loanAmount <= 0) return null;

    // Expiration
    const expiresAtRaw = order.expiry || order.expiresAt || order.term?.expiry || null;
    const expiresAt = expiresAtRaw
      ? new Date(
          typeof expiresAtRaw === "number" && expiresAtRaw > 1e12
            ? expiresAtRaw
            : typeof expiresAtRaw === "number"
              ? expiresAtRaw * 1000
              : expiresAtRaw
        ).toISOString()
      : null;
    const isOverdue = expiresAt ? new Date(expiresAt).getTime() < now : false;

    // LiveToken FMV from valuations
    const blended = nft.valuations?.blended;
    const fmvRaw = blended?.usdValue ?? null;
    const livetokenFmv = fmvRaw ? parseFloat(String(fmvRaw)) : null;

    // LTV calculation
    const ltv = livetokenFmv && livetokenFmv > 0 ? loanAmount / livetokenFmv : null;

    const traits =
      nft.nftView && Array.isArray(nft.nftView.traits) ? nft.nftView.traits : [];
    const playerName = (nft.card?.title ? String(nft.card.title) : "").trim();
    const nftID = nft.id ? String(nft.id) : "";

    if (!nftID) return null;

    return {
      nftID,
      momentId: nft.nftView?.uuid ? String(nft.nftView.uuid) : null,
      borrower: order.storefrontAddress ? String(order.storefrontAddress) : "",
      loanAmount,
      repaymentAmount: repaymentAmount || loanAmount,
      ltv: ltv !== null ? Math.round(ltv * 1000) / 1000 : null,
      expiresAt,
      isOverdue,
      livetokenFmv,
      playerName,
      setName: getTrait(traits, "SetName"),
      tier: (getTrait(traits, "Tier") || "COMMON").toUpperCase(),
      serialNumber: parseInt(String(nft.card?.num || "0"), 10) || 0,
      circulationCount: parseInt(String(nft.card?.max || "0"), 10) || 0,
      thumbnailUrl:
        nft.card?.images?.[0]?.url ?? null,
    };
  } catch (e: any) {
    console.log(`[flowty-loans] Map error: ${e.message || "unknown"}`);
    return null;
  }
}

export async function GET(req: NextRequest) {
  const startTime = Date.now();
  const url = new URL(req.url);
  const limitParam = parseInt(url.searchParams.get("limit") ?? "96");
  const now = Date.now();

  // ── 1. Fetch up to 4 pages from Flowty loan book ──────────────────────────
  const pageOffsets = [0, 24, 48, 72];
  const pageResults = await Promise.all(
    pageOffsets.map((off) => fetchLoanPage(off))
  );
  const allNfts = pageResults.flat();

  console.log(`[flowty-loans] Fetched ${allNfts.length} raw loan NFTs from Flowty`);

  if (allNfts.length === 0) {
    return NextResponse.json({
      count: 0,
      loans: [],
      overdueCount: 0,
      highLtvCount: 0,
      elapsed: Date.now() - startTime,
    });
  }

  // ── 2. Map to LoanItem ─────────────────────────────────────────────────────
  const loans: LoanItem[] = [];
  for (const nft of allNfts) {
    const item = mapLoanItem(nft, now);
    if (item) loans.push(item);
  }

  // Apply limit
  const limited = loans.slice(0, limitParam);

  const overdueCount = limited.filter((l) => l.isOverdue).length;
  const highLtvCount = limited.filter(
    (l) => l.ltv !== null && l.ltv >= HIGH_LTV_THRESHOLD
  ).length;

  console.log(
    `[flowty-loans] Mapped ${limited.length} loans — ${overdueCount} overdue, ${highLtvCount} high LTV`
  );

  return NextResponse.json(
    {
      count: limited.length,
      loans: limited,
      overdueCount,
      highLtvCount,
      elapsed: Date.now() - startTime,
    },
    {
      headers: {
        "Cache-Control": "public, max-age=0, s-maxage=60, stale-while-revalidate=120",
      },
    }
  );
}
