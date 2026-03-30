// app/api/flowty-offers/route.ts
//
// Returns the best (highest) open offer per TopShot Flow NFT ID from Flowty's Firestore.
// Uses Flowty's open `events` collection — no auth required.
//
// Firestore event types used:
//   STOREFRONT_OFFER_CREATED  — new offer placed
//   STOREFRONT_OFFER_CANCELLED — offer withdrawn
//
// Cancellation matching: offerResourceID (NOT transactionId — they're different transactions)
// The Firestore document id is "{offerResourceID}_{TYPE}" confirming this is the correct key.
//
// nftID source: data.typeAndIDOffer.nftID (more reliable than data.nftID which can be null)
// FMV source:   data.valuations.blended.usdValue (LiveToken, included free on created events)
//
// GET /api/flowty-offers                          — recent offers, all TopShot
// GET /api/flowty-offers?nftIds=123,456,789       — specific Flow NFT IDs

import { NextRequest, NextResponse } from "next/server";

const FIRESTORE_BASE =
  "https://firestore.googleapis.com/v1/projects/flowty-prod/databases/(default)";

const TOPSHOT_NFT_TYPE = "A.0b2a3299cc857e29.TopShot.NFT";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FirestoreFields = Record<string, any>;

interface OfferDoc {
  name: string;
  fields: FirestoreFields;
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
  offerResourceId: string;
  fmv: number | null;
}

async function fetchOfferEvents(
  type: "STOREFRONT_OFFER_CREATED" | "STOREFRONT_OFFER_CANCELLED"
): Promise<OfferDoc[]> {
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

function getStr(f: FirestoreFields, key: string): string {
  return f[key]?.stringValue ?? f[key]?.integerValue ?? "";
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const nftIdsParam = url.searchParams.get("nftIds");
  const requestedIds = nftIdsParam
    ? new Set(nftIdsParam.split(",").map((s) => s.trim()).filter(Boolean))
    : null;

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

  // ── Build cancelled set by offerResourceID ──────────────────────────────────
  // Document id is "{offerResourceID}_{TYPE}" — offerResourceID is the correct
  // join key between cancellations and their original created offer.
  // transactionId is WRONG — created and cancelled are separate transactions.
  const cancelledOfferIds = new Set<string>();
  for (const doc of cancelledDocs) {
    const dataFields = doc.fields.data?.mapValue?.fields ?? {};
    const id = getStr(dataFields, "offerResourceID") || getStr(dataFields, "offerId");
    if (id) cancelledOfferIds.add(id);
  }

  // ── Process created offers → best offer per nftID ───────────────────────────
  const bestOffers = new Map<string, BestOffer>();

  for (const doc of createdDocs) {
    const dataFields = doc.fields.data?.mapValue?.fields ?? {};

    // TopShot only
    const nftType = getStr(dataFields, "nftType");
    if (nftType && nftType !== TOPSHOT_NFT_TYPE) continue;

    // Skip cancelled offers
    const offerResourceId = getStr(dataFields, "offerResourceID") || getStr(dataFields, "offerId");
    if (offerResourceId && cancelledOfferIds.has(offerResourceId)) continue;

    // nftID: typeAndIDOffer.nftID is most reliable (top-level nftID can be null)
    const typeAndIDOffer = dataFields.typeAndIDOffer?.mapValue?.fields ?? {};
    const offerParamsString = dataFields.offerParamsString?.mapValue?.fields ?? {};
    const nftId =
      getStr(typeAndIDOffer, "nftID") ||
      getStr(dataFields, "nftID") ||
      getStr(offerParamsString, "nftId");

    if (!nftId) continue;
    if (requestedIds && !requestedIds.has(nftId)) continue;

    // Amount
    const rawAmount =
      (dataFields.offerAmount?.doubleValue ?? parseFloat(dataFields.offerAmount?.integerValue ?? "0") ?? 0) ||
      (dataFields.amount?.doubleValue ?? parseFloat(dataFields.amount?.integerValue ?? "0") ?? 0);
    if (rawAmount <= 0) continue;

    // FMV — free from LiveToken valuation embedded in created event
    const blended = dataFields.valuations?.mapValue?.fields?.blended?.mapValue?.fields ?? {};
    const fmvRaw = blended.usdValue?.doubleValue ?? blended.usdValue?.integerValue ?? null;
    const fmv = fmvRaw !== null ? parseFloat(String(fmvRaw)) : null;

    const currency = getStr(dataFields, "paymentTokenName") || "DUC";
    const buyer =
      getStr(dataFields, "offerAddress") ||
      getStr(dataFields, "payer") ||
      getStr(dataFields, "offerer") ||
      "";
    const timestamp = doc.fields.blockTimestamp?.timestampValue ?? doc.createTime;
    const transactionId = doc.fields.transactionId?.stringValue ?? "";

    const existing = bestOffers.get(nftId);
    if (!existing || rawAmount > existing.amount) {
      bestOffers.set(nftId, {
        amount: rawAmount,
        currency,
        buyer,
        timestamp,
        transactionId,
        offerResourceId,
        fmv,
      });
    }
  }

  const offers: Record<string, BestOffer> = Object.fromEntries(bestOffers);

  return NextResponse.json({
    offers,
    count: Object.keys(offers).length,
    fetchedCreated: createdDocs.length,
    fetchedCancelled: cancelledDocs.length,
    cancelledFiltered: cancelledOfferIds.size,
  });
}