import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const FIRESTORE_BASE = "https://firestore.googleapis.com/v1/projects/flowty-prod/databases/(default)/documents:runQuery";
const TREVOR_WALLET = "0xbd94cade097e50ac";
const TS_COLLECTION = "95f28a17-224a-4025-96ad-adf8a4c63bfd";
const BATCH_SIZE = 100;
const CONCURRENCY = 3;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

interface FlowtyMatch {
  nft_id: string;
  event_type: string;
  price: number;
  currency: string;
  buyer: string;
  seller: string;
  timestamp: string;
  transaction_id: string;
}

async function queryFlowtyEvents(nftId: string, eventType: string): Promise<any[]> {
  const body = JSON.stringify({
    structuredQuery: {
      from: [{ collectionId: "events" }],
      where: {
        compositeFilter: {
          op: "AND",
          filters: [
            { fieldFilter: { field: { fieldPath: "type" }, op: "EQUAL", value: { stringValue: eventType } } },
            { fieldFilter: { field: { fieldPath: "data.nftID" }, op: "EQUAL", value: { stringValue: nftId } } },
          ],
        },
      },
      limit: 10,
    },
  });

  const res = await fetch(FIRESTORE_BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return [];
  const results = await res.json();
  return (results as any[]).filter((r: any) => r.document);
}

function getStr(fields: any, key: string): string {
  const v = fields[key];
  return v?.stringValue ?? v?.integerValue?.toString() ?? "";
}

function getNum(fields: any, key: string): number {
  const v = fields[key];
  return v?.doubleValue ?? parseFloat(v?.integerValue ?? "0") ?? 0;
}

async function checkMoment(nftId: string, acquiredDate: string | null): Promise<FlowtyMatch | null> {
  const acquiredTs = acquiredDate ? new Date(acquiredDate).getTime() : 0;

  // Check STOREFRONT_PURCHASED — direct buy from listing
  const purchaseEvents = await queryFlowtyEvents(nftId, "STOREFRONT_PURCHASED");
  for (const evt of purchaseEvents) {
    const fields = evt.document.fields.data?.mapValue?.fields ?? {};
    const nftType = getStr(fields, "nftType");
    if (!nftType.includes("TopShot")) continue;
    const buyer = getStr(fields, "buyer");
    const ts = evt.document.fields.blockTimestamp?.timestampValue ?? "";
    const eventTs = new Date(ts).getTime();
    // Match if buyer is Trevor OR timestamp is within 5 min of acquired_date
    if (buyer === TREVOR_WALLET || (acquiredTs > 0 && Math.abs(eventTs - acquiredTs) < 300000)) {
      let price = getNum(fields, "salePrice");
      if (price > 1000000) price = price / 1e8; // micro-units
      return {
        nft_id: nftId,
        event_type: "flowty_purchase",
        price,
        currency: getStr(fields, "salePaymentVaultType").includes("FlowToken") ? "FLOW" : "DUC",
        buyer,
        seller: getStr(fields, "storefrontAddress"),
        timestamp: ts,
        transaction_id: evt.document.fields.transactionId?.stringValue ?? "",
      };
    }
  }

  await sleep(100);

  // Check STOREFRONT_OFFER_ACCEPTED — accepted offer
  const offerEvents = await queryFlowtyEvents(nftId, "STOREFRONT_OFFER_ACCEPTED");
  for (const evt of offerEvents) {
    const fields = evt.document.fields.data?.mapValue?.fields ?? {};
    const nftType = getStr(fields, "nftType");
    if (!nftType.includes("TopShot")) continue;
    const offerAddress = getStr(fields, "offerAddress");
    const ts = evt.document.fields.blockTimestamp?.timestampValue ?? "";
    const eventTs = new Date(ts).getTime();
    if (offerAddress === TREVOR_WALLET || (acquiredTs > 0 && Math.abs(eventTs - acquiredTs) < 300000)) {
      const price = getNum(fields, "offerAmount");
      return {
        nft_id: nftId,
        event_type: "flowty_offer_accepted",
        price,
        currency: getStr(fields, "paymentTokenName") || "DUC",
        buyer: offerAddress,
        seller: getStr(fields, "taker"),
        timestamp: ts,
        transaction_id: evt.document.fields.transactionId?.stringValue ?? "",
      };
    }
  }

  return null;
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const wallet = url.searchParams.get("wallet") || TREVOR_WALLET;
  const dryRun = url.searchParams.get("dry") === "1";

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // Get unknown acquisitions
  const { data: unknowns, error } = await supabase
    .from("moment_acquisitions")
    .select("id, nft_id, acquired_date")
    .eq("wallet", wallet)
    .eq("collection_id", TS_COLLECTION)
    .eq("acquisition_method", "unknown")
    .eq("acquisition_confidence", "unknown")
    .order("acquired_date", { ascending: false, nullsFirst: false })
    .limit(BATCH_SIZE);

  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  if (!unknowns || unknowns.length === 0) {
    return new Response(JSON.stringify({ ok: true, message: "No unknowns remaining", processed: 0 }));
  }

  let flowtyPurchases = 0;
  let flowtyOffers = 0;
  let noMatch = 0;
  let errors = 0;
  const matches: FlowtyMatch[] = [];

  // Process in chunks
  for (let i = 0; i < unknowns.length; i += CONCURRENCY) {
    const chunk = unknowns.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      chunk.map(async (acq: any) => {
        try {
          return await checkMoment(acq.nft_id, acq.acquired_date);
        } catch {
          errors++;
          return null;
        }
      })
    );

    for (let j = 0; j < results.length; j++) {
      const match = results[j];
      const acq = chunk[j];
      if (match) {
        matches.push(match);
        if (match.event_type === "flowty_purchase") flowtyPurchases++;
        else flowtyOffers++;

        if (!dryRun) {
          await supabase
            .from("moment_acquisitions")
            .update({
              acquisition_method: "marketplace",
              acquisition_confidence: "verified",
              buy_price: match.price,
              source: match.event_type,
              seller_address: match.seller,
              transaction_hash: match.transaction_id,
            })
            .eq("id", acq.id);
        }
      } else {
        noMatch++;
        // Mark as checked so we don't re-process
        if (!dryRun) {
          await supabase
            .from("moment_acquisitions")
            .update({ acquisition_confidence: "checked_no_flowty" })
            .eq("id", acq.id);
        }
      }
    }

    if (i + CONCURRENCY < unknowns.length) await sleep(300);
  }

  // Count remaining
  const { count: remaining } = await supabase
    .from("moment_acquisitions")
    .select("id", { count: "exact", head: true })
    .eq("wallet", wallet)
    .eq("collection_id", TS_COLLECTION)
    .eq("acquisition_method", "unknown")
    .eq("acquisition_confidence", "unknown");

  return new Response(JSON.stringify({
    ok: true,
    processed: unknowns.length,
    flowty_purchases: flowtyPurchases,
    flowty_offers: flowtyOffers,
    no_match: noMatch,
    errors,
    remaining: remaining ?? 0,
    sample_matches: matches.slice(0, 5).map(m => ({
      nft_id: m.nft_id,
      type: m.event_type,
      price: m.price,
      buyer: m.buyer,
    })),
  }), { headers: { "Content-Type": "application/json" } });
});
