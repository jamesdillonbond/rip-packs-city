// lib/market/franchise-teams.ts
//
// A Market Team pick covers every label its FRANCHISE has minted under
// (2026-10-14). editions.team_name is a label, not a franchise: "Los Angeles
// Clippers" (53 Top Shot editions) and "LA Clippers" (309) are one team, as are
// "Seattle SuperSonics" / "Oklahoma City Thunder" and, on All Day, "Washington
// Football Team" / "Washington Commanders". Matching the picked label alone
// silently dropped the franchise's other eras. CLAUDE.md concierge rule 2: a
// team label is not a franchise — resolve via resolve_team_name.
//
// Degrades to the picked label (never to nothing) when a resolve read fails or
// does not name exactly one franchise; `degraded` says so.

import { boundedRead } from "@/lib/api/bounded-read"

type Rpc = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }> }

export async function expandFranchiseLabels(
  supa: unknown,
  collectionId: string,
  teams: readonly string[],
): Promise<{ labels: string[]; degraded: boolean }> {
  const picked = [...new Set(teams.map((t) => t.trim()).filter(Boolean))]
  if (picked.length === 0) return { labels: [], degraded: false }
  const db = supa as Rpc
  const reads = await Promise.all(
    picked.map((team) =>
      boundedRead(db.rpc("resolve_team_name", { p_collection_id: collectionId, p_name: team }), "api/market/resolve_team_name"),
    ),
  )
  const labels = new Set<string>(picked)
  let degraded = false
  reads.forEach(({ data, error }) => {
    const v = data as { status?: unknown; names?: unknown } | null
    if (error || !v || v.status !== "one" || !Array.isArray(v.names)) {
      if (error) degraded = true
      return
    }
    for (const n of v.names as Array<{ team_name?: unknown }>) {
      if (typeof n?.team_name === "string" && n.team_name.trim()) labels.add(n.team_name.trim())
    }
  })
  return { labels: [...labels], degraded }
}
