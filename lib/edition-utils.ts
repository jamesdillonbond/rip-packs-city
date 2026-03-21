export function getEditionKey(row: any) {
  return `${row.setId}-${row.playId}-${row.parallel || "base"}`
}

export function buildEditionStats(rows: any[]) {
  const map: Record<string, { owned: number; locked: number }> = {}

  for (const r of rows || []) {
    const key = getEditionKey(r)

    if (!map[key]) {
      map[key] = { owned: 0, locked: 0 }
    }

    map[key].owned += 1
    if (r.locked) map[key].locked += 1
  }

  return map
}