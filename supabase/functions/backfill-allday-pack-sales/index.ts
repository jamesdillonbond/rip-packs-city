// backfill-allday-pack-sales — All Day pack SALES history from Dapper studio
// searchPackMarketplaceHistory (nft_type = A.e4cf4bdc1751c65d.PackNFT.NFT).
//
// v-next (2026-09-23): HEAD-FIRST. Every run reads from the newest sale until a
// page brings nothing new, then continues the history sweep with the remaining
// page budget. Logs itself to pipeline_runs as "allday-pack-sales-ingest". All logic
// lives in ../_shared/pack-sales-walker.ts (unit-tested); this file is config.
//
// Gate (2026-10-13): ../_shared/cron-gate.ts — the key (x-rpc-gate-key header or ?key=) is
// checked against the SAME Vault secret pg_cron sends, cron_gate_key('backfill-allday-pack-sales'). No env
// secret is read; a rotation is one vault.update_secret (rpc-edge-fn-deploy §0).
// ?reset=1 restarts the
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
  handlePackSalesRequest(req, sb, CFG, "backfill-allday-pack-sales")
)
