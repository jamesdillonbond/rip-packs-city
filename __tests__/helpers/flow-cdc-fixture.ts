// JSON-CDC fixture builders for driving the Flow-REST sales indexers in tests.
// Encodes event payloads and Cadence script results EXACTLY the way Flow REST
// serves them (base64 of typed JSON-CDC), so the routes' inline unwrapCdc /
// extractNftTypeId decode paths run unmodified against realistic bytes.
// Keep this file free of `.test.` in its name — it is a helper, not a suite.

export const cdc = {
  uint64: (v: string | number) => ({ type: "UInt64", value: String(v) }),
  ufix64: (v: string) => ({ type: "UFix64", value: v }),
  bool: (v: boolean) => ({ type: "Bool", value: v }),
  string: (v: string) => ({ type: "String", value: v }),
  optionalNull: () => ({ type: "Optional", value: null }),
  nftType: (typeID: string) => ({
    type: "Type",
    value: { staticType: { kind: "Resource", typeID } },
  }),
}

export function cdcEvent(id: string, fields: Record<string, unknown>) {
  return {
    type: "Event",
    value: {
      id,
      fields: Object.entries(fields).map(([name, value]) => ({ name, value })),
    },
  }
}

/** One Flow REST /v1/events block carrying a single event with the given
 *  JSON-CDC payload (base64-encoded, as the API returns it). */
export function eventBlock(opts: {
  height: number
  txId: string
  eventType: string
  payload: unknown
}) {
  return {
    block_id: "b".repeat(64),
    block_height: String(opts.height),
    block_timestamp: "2026-07-17T12:00:00Z",
    events: [
      {
        type: opts.eventType,
        transaction_id: opts.txId,
        event_index: 0,
        payload: Buffer.from(JSON.stringify(opts.payload)).toString("base64"),
      },
    ],
  }
}

/** Encode a Cadence script result ({String:String}? dictionary) the way Flow
 *  REST returns it: base64 of the JSON-CDC value. */
export function scriptResult(dict: Record<string, string> | null): { value: string } {
  const inner =
    dict === null
      ? { type: "Optional", value: null }
      : {
          type: "Optional",
          value: {
            type: "Dictionary",
            value: Object.entries(dict).map(([k, v]) => ({
              key: cdc.string(k),
              value: cdc.string(v),
            })),
          },
        }
  return { value: Buffer.from(JSON.stringify(inner)).toString("base64") }
}

export const V1_LISTING_COMPLETED = "A.4eb8a10cb9f87357.NFTStorefront.ListingCompleted"
export const V2_DAPPER_LISTING_COMPLETED = "A.4eb8a10cb9f87357.NFTStorefrontV2.ListingCompleted"
export const V2_FLOWTY_LISTING_COMPLETED = "A.3cdbb3d569211ff3.NFTStorefrontV2.ListingCompleted"

/** A V2 (Dapper) ListingCompleted purchase payload for the given NFT type. */
export function v2DapperSalePayload(nftId: string, price: string, typeID: string) {
  return cdcEvent(V2_DAPPER_LISTING_COMPLETED, {
    listingResourceID: cdc.uint64(7000 + (Number(nftId) % 1000)),
    storefrontResourceID: cdc.uint64(1),
    purchased: cdc.bool(true),
    nftType: cdc.nftType(typeID),
    nftID: cdc.uint64(nftId),
    salePrice: cdc.ufix64(price),
    customID: cdc.optionalNull(),
    commissionReceiver: cdc.optionalNull(),
  })
}

/** A V1 (reduced-payload) ListingCompleted event. */
export function v1SalePayload(nftId: string, lrid: string, purchased: boolean, typeID: string) {
  return cdcEvent(V1_LISTING_COMPLETED, {
    listingResourceID: cdc.uint64(lrid),
    storefrontResourceID: cdc.uint64(2),
    purchased: cdc.bool(purchased),
    nftType: cdc.nftType(typeID),
    nftID: cdc.uint64(nftId),
  })
}
