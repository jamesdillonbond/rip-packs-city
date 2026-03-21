import { NextRequest, NextResponse } from "next/server"

type TrackClickBody = {
  destination?: string
  label?: string
  momentId?: string | number | null
  editionKey?: string | null
  playerName?: string | null
  setName?: string | null
  walletAddress?: string | null
  username?: string | null
  sessionId?: string | null
  rowRank?: number | null
  compactMode?: boolean | null
  sortKey?: string | null
  sortDirection?: string | null
  filters?: Record<string, unknown> | null
  presetName?: string | null
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as TrackClickBody

    const event = {
      timestamp: new Date().toISOString(),
      destination: body.destination ?? null,
      label: body.label ?? null,
      momentId: body.momentId ?? null,
      editionKey: body.editionKey ?? null,
      playerName: body.playerName ?? null,
      setName: body.setName ?? null,
      walletAddress: body.walletAddress ?? null,
      username: body.username ?? null,
      sessionId: body.sessionId ?? null,
      rowRank: body.rowRank ?? null,
      compactMode: body.compactMode ?? null,
      sortKey: body.sortKey ?? null,
      sortDirection: body.sortDirection ?? null,
      filters: body.filters ?? null,
      presetName: body.presetName ?? null,
    }

    console.log("[TRACK_CLICK]", JSON.stringify(event))

    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: e instanceof Error ? e.message : "track-click failed",
      },
      { status: 500 }
    )
  }
}