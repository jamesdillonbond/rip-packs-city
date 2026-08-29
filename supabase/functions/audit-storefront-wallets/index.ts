import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const INGEST_SECRET = Deno.env.get("INGEST_SECRET_TOKEN");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const FLOW_ACCESS = "https://rest-mainnet.onflow.org";
const BATCH_SIZE = 50;
const EXPIRED_THRESHOLD = 20;

const AUDIT_SCRIPT = btoa(`
import NFTStorefrontV2 from 0x4eb8a10cb9f87357
import DapperUtilityCoin from 0xead892083b3e2c6c
import FungibleToken from 0xf233dcee88fe0abe

access(all) fun main(addr: Address): {String: Int} {
  let acct = getAccount(addr)

  // Check Dapper wallet via DUC balance capability
  let ducCap = acct.capabilities.borrow<&{FungibleToken.Balance}>(/public/dapperUtilityCoinBalance)
  let isDapper = ducCap != nil ? 1 : 0

  let sf = acct.capabilities.borrow<&{NFTStorefrontV2.StorefrontPublic}>(NFTStorefrontV2.StorefrontPublicPath)
  if sf == nil {
    return {"total": 0, "expired": 0, "active": 0, "noExpiry": 0, "hasStorefront": 0, "isDapper": isDapper}
  }

  let ids = sf!.getListingIDs()
  let now = getCurrentBlock().timestamp
  var expired = 0
  var active = 0
  var noExpiry = 0

  for id in ids {
    if let listing = sf!.borrowListing(listingResourceID: id) {
      let expiry = listing.getDetails().expiry
      if expiry == 0 || expiry > UInt64(32000000000) {
        noExpiry = noExpiry + 1
      } else if UFix64(expiry) < now {
        expired = expired + 1
      } else {
        active = active + 1
      }
    }
  }
  return {"total": ids.length, "expired": expired, "active": active, "noExpiry": noExpiry, "hasStorefront": 1, "isDapper": isDapper}
}
`);

async function auditWallet(address: string): Promise<Record<string, number> | null> {
  try {
    const addrArg = btoa(JSON.stringify({ type: "Address", value: address }));
    const resp = await fetch(`${FLOW_ACCESS}/v1/scripts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ script: AUDIT_SCRIPT, arguments: [addrArg] }),
      signal: AbortSignal.timeout(25000),
    });
    if (!resp.ok) return null;
    const raw = await resp.json();
    const decoded = JSON.parse(atob(raw.trim().replace(/^"|"$/g, "")));
    const result: Record<string, number> = {};
    for (const entry of decoded.value) {
      result[entry.key.value] = parseInt(entry.value.value);
    }
    return result;
  } catch (e: any) {
    console.log(`[audit-storefront] ${address} error: ${e.message}`);
    return null;
  }
}

Deno.serve(async (req: Request) => {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${INGEST_SECRET}`) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_KEY!);

  const { data: wallets, error } = await supabase
    .from("storefront_audit_wallets")
    .select("address")
    .is("last_scanned_at", null)
    .order("created_at", { ascending: true })
    .limit(BATCH_SIZE);

  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });

  if (!wallets?.length) {
    const { count } = await supabase
      .from("storefront_audit_wallets")
      .select("*", { count: "exact", head: true })
      .eq("cleanup_status", "pending")
      .eq("is_dapper", true);
    return new Response(JSON.stringify({ ok: true, audited: 0, message: "No unaudited wallets", dapper_pending_cleanup: count || 0 }));
  }

  let audited = 0;
  let flagged = 0;
  let dapperFound = 0;

  for (const { address } of wallets) {
    const result = await auditWallet(address);
    const now = new Date().toISOString();
    const update: any = { last_scanned_at: now };

    if (result) {
      update.total_listings = result.total ?? 0;
      update.expired_listings = result.expired ?? 0;
      update.active_listings = result.active ?? 0;
      update.no_expiry_listings = result.noExpiry ?? 0;
      update.is_dapper = result.isDapper === 1;

      if (result.isDapper === 1) dapperFound++;

      if (!result.hasStorefront) {
        update.cleanup_status = "skipped";
      } else if (result.isDapper === 1 && (result.expired ?? 0) > EXPIRED_THRESHOLD) {
        update.cleanup_status = "pending";
        flagged++;
      } else {
        update.cleanup_status = "skipped";
      }
    } else {
      update.cleanup_status = "error";
    }

    await supabase.from("storefront_audit_wallets").update(update).eq("address", address);
    audited++;
    await new Promise(r => setTimeout(r, 110));
  }

  return new Response(JSON.stringify({
    ok: true,
    audited,
    dapper_found: dapperFound,
    flagged_for_cleanup: flagged,
  }), { headers: { "Content-Type": "application/json" } });
});
