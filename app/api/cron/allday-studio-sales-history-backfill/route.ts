import { NextRequest } from "next/server"
import { runStudioHistoryDrain, type StudioHistoryConfig } from "@/lib/studio-sales-history"

// NFL All Day sales-history backfill via the Dapper studio-platform GQL.
// Fills the 2023-11→present coverage gap the forward indexer + on-chain backfill
// never captured. edition_id filter == editions.external_id → zero edition
// creation, no mis-key, no unmapped_sales writes. See lib/studio-sales-history.ts
// + docs/handoff-2026-06-24-studio-platform-gql-deep-history.md.
// Revert: DELETE FROM sales WHERE source='allday_studio_history_v1';

export const dynamic = "force-dynamic"
export const maxDuration = 300

const CFG: StudioHistoryConfig = {
  pipelineName: "allday-studio-sales-history-backfill",
  collectionId: "dee28451-5d62-409e-a1ad-a83f763ac070",
  collectionSlug: "nfl_all_day",
  marketplace: "nflallday",
  sourceTag: "allday_studio_history_v1",
  progressTable: "allday_studio_sales_history_progress",
  seedFn: "seed_allday_studio_sales_history_targets",
  queryName: "searchAllDayMarketplaceHistory",
  inputType: "SearchAllDayMarketplaceHistoryInput",
  origin: "https://nflallday.com",
  disableEnv: "ALLDAY_STUDIO_SALES_HISTORY_BACKFILL_DISABLED",
}

export async function POST(req: NextRequest) {
  return runStudioHistoryDrain(req, CFG)
}
export async function GET(req: NextRequest) {
  return runStudioHistoryDrain(req, CFG)
}
