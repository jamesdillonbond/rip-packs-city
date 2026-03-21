import { NextRequest, NextResponse } from "next/server";
import { getFlowtyQuotes } from "@/lib/markets/flowty";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { momentIds?: number[] };

    const momentIds = Array.isArray(body.momentIds)
      ? body.momentIds
          .map((id) => Number(id))
          .filter((id) => Number.isFinite(id))
          .slice(0, 12)
      : [];

    if (momentIds.length === 0) {
      return NextResponse.json({ results: [] });
    }

    const flowtyResults = await getFlowtyQuotes(momentIds.map(String));

    return NextResponse.json({ results: flowtyResults });
  } catch (error) {
    console.error("[FLOWTY_ENRICH_ERROR]", error);

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Flowty enrichment failed.",
      },
      { status: 500 }
    );
  }
}