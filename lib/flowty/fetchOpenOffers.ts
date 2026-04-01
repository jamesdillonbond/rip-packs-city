// lib/flowty/fetchOpenOffers.ts
//
// Shared utility: fetches the best (highest) open Flowty offer per TopShot NFT ID.
// Extracted from app/api/flowty-offers/route.ts so sniper-feed can call it directly
// instead of making an outbound HTTP request to its own domain.

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

/**
 * Fetches open Flowty offers and returns the best (highest) offer per NFT ID.
 * Returns a Map keyed by nftID (Flow NFT ID string).
 */
export async function fetchOpenOffers(): Promise<Map<string, { amount: number; fmv: number | null }>> {
  const [createdDocs, cancelledDocs] = await Promise.all([
    fetchOfferEvents("STOREFRONT_OFFER_CREATED"),
    fetchOfferEvents("STOREFRONT_OFFER_CANCELLED"),
  ]);

  // Build cancelled set by offerResourceID
  const cancelledOfferIds = new Set<string>();
  for (const doc of cancelledDocs) {
    const dataFields = doc.fields.data?.mapValue?.fields ?? {};
    const id = getStr(dataFields, "offerResourceID") || getStr(dataFields, "offerId");
    if (id) cancelledOfferIds.add(id);
  }

  // Process created offers → best offer per nftID
  const bestOffers = new Map<string, { amount: number; fmv: number | null }>();

  for (const doc of createdDocs) {
    const dataFields = doc.fields.data?.mapValue?.fields ?? {};

    // TopShot only
    const nftType = getStr(dataFields, "nftType");
    if (nftType && nftType !== TOPSHOT_NFT_TYPE) continue;

    // Skip cancelled offers
    const offerResourceId = getStr(dataFields, "offerResourceID") || getStr(dataFields, "offerId");
    if (offerResourceId && cancelledOfferIds.has(offerResourceId)) continue;

    // nftID: typeAndIDOffer.nftID is most reliable
    const typeAndIDOffer = dataFields.typeAndIDOffer?.mapValue?.fields ?? {};
    const offerParamsString = dataFields.offerParamsString?.mapValue?.fields ?? {};
    const nftId =
      getStr(typeAndIDOffer, "nftID") ||
      getStr(dataFields, "nftID") ||
      getStr(offerParamsString, "nftId");

    if (!nftId) continue;

    // Amount
    const rawAmount =
      (dataFields.offerAmount?.doubleValue ?? parseFloat(dataFields.offerAmount?.integerValue ?? "0") ?? 0) ||
      (dataFields.amount?.doubleValue ?? parseFloat(dataFields.amount?.integerValue ?? "0") ?? 0);
    if (rawAmount <= 0) continue;

    // FMV — free from LiveToken valuation embedded in created event
    const blended = dataFields.valuations?.mapValue?.fields?.blended?.mapValue?.fields ?? {};
    const fmvRaw = blended.usdValue?.doubleValue ?? blended.usdValue?.integerValue ?? null;
    const fmv = fmvRaw !== null ? parseFloat(String(fmvRaw)) : null;

    const existing = bestOffers.get(nftId);
    if (!existing || rawAmount > existing.amount) {
      bestOffers.set(nftId, { amount: rawAmount, fmv });
    }
  }

  return bestOffers;
}
