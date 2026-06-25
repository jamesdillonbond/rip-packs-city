import { NextRequest } from "next/server"
import { runStudioHistoryDrain, type StudioHistoryConfig } from "@/lib/studio-sales-history"

// LaLiga Golazos sales-history backfill via the Dapper studio-platform GQL.
// Same mechanism as AllDay: edition_id filter == editions.external_id (numeric)
// → zero edition creation, no mis-key, no unmapped_sales writes. Fills the
// 2023-11→present coverage gap. See lib/studio-sales-history.ts +
// docs/handoff-2026-06-24-studio-platform-gql-deep-history.md.
// Revert: DELETE FROM sales WHERE source='golazos_studio_history_v1';

export const dynamic = "force-dynamic"
export const maxDuration = 300

const CFG: StudioHistoryConfig = {
  pipelineName: "golazos-studio-sales-history-backfill",
  collectionId: "06248cc4-b85f-47cd-af67-1855d14acd75",
  collectionSlug: "laliga_golazos",
  marketplace: "laligagolazos",
  sourceTag: "golazos_studio_history_v1",
  progressTable: "golazos_studio_sales_history_progress",
  seedFn: "seed_golazos_studio_sales_history_targets",
  queryName: "searchGolazosMarketplaceHistory",
  inputType: "SearchGolazosMarketplaceHistoryInput",
  origin: "https://laligagolazos.com",
  disableEnv: "GOLAZOS_STUDIO_SALES_HISTORY_BACKFILL_DISABLED",
}

export async function POST(req: NextRequest) {
  return runStudioHistoryDrain(req, CFG)
}
export async function GET(req: NextRequest) {
  return runStudioHistoryDrain(req, CFG)
}
