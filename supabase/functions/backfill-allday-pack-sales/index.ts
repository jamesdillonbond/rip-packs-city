// backfill-allday-pack-sales — All Day pack SALES history from Dapper studio
// searchPackMarketplaceHistory (nft_type = A.e4cf4bdc1751c65d.PackNFT.NFT).
//
// v-next (2026-09-23): HEAD-FIRST. Every run reads from the newest sale until a
// page brings nothing new, then continues the history sweep with the remaining
// page budget. Logs itself to pipeline_runs as "allday-pack-sales-ingest". All logic
// lives in ../_shared/pack-sales-walker.ts (unit-tested); this file is config.
//
// Gate: ?key= must equal PACK_SALES_GATE_KEY (or _OLD). pg_cron sends
// public.cron_gate_key('backfill-allday-pack-sales') — a Vault secret holding the
// same value, so cron and the function cannot disagree. ?reset=1 restarts the
// sweep; ?pages=N total page budget (≤60); ?head=N head-page cap (≤10).
// Revert: redeploy the previous version (the pre-2026-09-23 body is in
// docs/audits/pack-sales-walker-pre-head-first.md).
import { createClient } from "@supabase/supabase-js"
import { handlePackSalesRequest } from "../_shared/pack-sales-walker.ts"

const sb = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "")

const CFG = {
  pipeline: "allday-pack-sales-ingest",
  collectionSlug: "nfl_all_day",
  table: "allday_pack_sales_history",
  cursorTable: "allday_pack_sales_cursor",
  packType: "A.e4cf4bdc1751c65d.PackNFT.NFT",
  defaultPages: 30,
  headers: {
    "Content-Type": "application/json",
    "Origin": "https://nflallday.com",
    "Referer": "https://nflallday.com/",
    "User-Agent": "RipPacksCity/1.0 (www.rippackscity.com)",
  },
}

Deno.serve((req) =>
  handlePackSalesRequest(req, sb, CFG, {
    key: Deno.env.get("PACK_SALES_GATE_KEY") ?? "",
    keyOld: Deno.env.get("PACK_SALES_GATE_KEY_OLD") ?? "",
  })
)
