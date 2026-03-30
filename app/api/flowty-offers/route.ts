// app/api/flowty-offers/route.ts
//
// Returns the best (highest) open offer per TopShot Flow NFT ID from Flowty's Firestore.
// Uses Flowty's open `events` collection — no auth required.
//
// Firestore event types used:
//   STOREFRONT_OFFER_CREATED  — new offer placed
//   STOREFRONT_OFFER_CANCELLED — offer withdrawn
//
// Note: Firestore structured queries can't filter on nested mapValue fields server-side,
// so nftType filtering happens in application code after fetching.
//
// GET /api/flowty-offers                          — recent offers, all TopShot
// GET /api/flowty-offers?nftIds=123,456,789       — specific Flow NFT IDs

import { NextRequest, NextResponse } from "next/server";

const FIRESTORE_BASE =
  "https://firestore.googleapis.com/v1/projects/flowty-prod/databases/(default)";

const TOPSHOT_NFT_TYPE = "A.0b2a3299cc857e29.TopShot.NFT";

interface OfferDataFields {
  nftID?: { stringValue?: string; integerValue?: string };
  nftType?: { stringValue: string };
  // Offer amount field name varies by contract version
  offerAmount?: { doubleValue?: number; integerValue?: string };
  amount?: { doubleValue?: number; integerValue?: string };
  paymentTokenName?: { stringValue: string };
  offerer?: { stringValue: string };
  buyer?: { stringValue: string };
  state?: { stringValue: string };
}

interface OfferDocFields {
  type?: { stringValue: string };
  blockTimestamp?: { timestampValue: string };
  transactionId?: { stringValue: string };
  data?: { mapValue: { fields: OfferDataFields } };
}

interface OfferDoc {
  name: string;
  fields: OfferDocFields;
  createTime: string;
}

interface QueryResult {
  document?: OfferDoc;
  readTime: string;
}

export interface BestOffer {
  amount: number;
  currency: string;
  buyer: string;
  timestamp: string;
  transactionId: string;
}

async function fetchOfferEvents(type: "STOREFRONT_OFFER_CREATED" | "STOREFRONT_OFFER_CANCELLED"): Promise<OfferDoc[]> {
  const res = await fetch(`${FIRESTORE_BASE}/documents:runQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: "events" }],
        where: {
          fieldFilter: {
            field: { fieldPath: "type" },
            op: "EQUAL",
            value: { stringValue: type },
          },
        },
        orderBy: [{ field: { fieldPath: "blockTimestamp" }, direction: "DESCENDING" }],
        limit: 200,
      },
    }),
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) return [];
  const results: QueryResult[] = await res.json();
  return results.filter((r) => r.document).map((r) => r.document!);
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const nftIdsParam = url.searchParams.get("nftIds");
  const requestedIds = nftIdsParam
    ? new Set(nftIdsParam.split(",").map((s) => s.trim()).filter(Boolean))
    : null;

  // Fetch created and cancelled offers in parallel
  let createdDocs: OfferDoc[];
  let cancelledDocs: OfferDoc[];

  try {
    [createdDocs, cancelledDocs] = await Promise.all([
      fetchOfferEvents("STOREFRONT_OFFER_CREATED"),
      fetchOfferEvents("STOREFRONT_OFFER_CANCELLED"),
    ]);
  } catch (err) {
    return NextResponse.json(
      { error: "Firestore fetch failed", detail: String(err) },
      { status: 502 }
    );
  }

  // Build set of cancelled transaction IDs to filter stale offers
  const cancelledTxIds = new Set(
    cancelledDocs
      .map((doc) => doc.fields.transactionId?.stringValue ?? "")
      .filter(Boolean)
  );

  // Process offer events → best offer per nftID
  const bestOffers = new Map<string, BestOffer>();

  for (const doc of createdDocs) {
    const dataFields = doc.fields.data?.mapValue?.fields;
    if (!dataFields) continue;

    // Filter to TopShot only
    if (dataFields.nftType?.stringValue !== TOPSHOT_NFT_TYPE) continue;

    // Skip cancelled offers
    const txId = doc.fields.transactionId?.stringValue ?? "";
    if (cancelledTxIds.has(txId)) continue;

    // Parse nftID (can be stringValue or integerValue)
    const nftId =
      dataFields.nftID?.stringValue ??
      (dataFields.nftID?.integerValue ? String(dataFields.nftID.integerValue) : "");
    if (!nftId) continue;

    // Filter to requested IDs if provided
    if (requestedIds && !requestedIds.has(nftId)) continue;

    // Parse amount — field name varies by offer contract version
    const offerAmountVal =
      (dataFields.offerAmount?.doubleValue ?? parseFloat(dataFields.offerAmount?.integerValue ?? "0")) || 0;
    const amountVal =
      (dataFields.amount?.doubleValue ?? parseFloat(dataFields.amount?.integerValue ?? "0")) || 0;
    const rawAmount = offerAmountVal || amountVal;

    if (rawAmount <= 0) continue;

    const currency = dataFields.paymentTokenName?.stringValue ?? "DUC";
    const buyer =
      dataFields.offerer?.stringValue ??
      dataFields.buyer?.stringValue ??
      "";
    const timestamp = doc.fields.blockTimestamp?.timestampValue ?? doc.createTime;

    // Keep highest offer per nftID
    const existing = bestOffers.get(nftId);
    if (!existing || rawAmount > existing.amount) {
      bestOffers.set(nftId, { amount: rawAmount, currency, buyer, timestamp, transactionId: txId });
    }
  }

  const offers: Record<string, BestOffer> = Object.fromEntries(bestOffers);

  return NextResponse.json({
    offers,
    count: Object.keys(offers).length,
    fetchedCreated: createdDocs.length,
    fetchedCancelled: cancelledDocs.length,
    cancelledFiltered: cancelledDocs.filter(
      (d) => d.fields.transactionId?.stringValue && cancelledTxIds.has(d.fields.transactionId.stringValue)
    ).length,
  });
}