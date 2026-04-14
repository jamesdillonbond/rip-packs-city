export type GolazosBadgeRule = {
  badgeTitle: string
  priority: number
  patterns: string[]
}

export const GOLAZOS_BADGE_RULES: GolazosBadgeRule[] = [
  { badgeTitle: "El Clásico",            priority: 10, patterns: ["elclásico", "el clasico", "elclasico"] },
  { badgeTitle: "Eterno Rival",          priority: 9,  patterns: ["eterno rival"] },
  { badgeTitle: "Ídolos",                priority: 9,  patterns: ["ídolos", "idolos"] },
  { badgeTitle: "Estrellas",             priority: 8,  patterns: ["estrellas"] },
  { badgeTitle: "Team Europa",           priority: 8,  patterns: ["team europa", "equipo del mundo"] },
  { badgeTitle: "Tiki Taka",             priority: 7,  patterns: ["tiki taka", "team croqueta"] },
  { badgeTitle: "Last Gasp",             priority: 7,  patterns: ["last gasp"] },
  { badgeTitle: "Individual Brilliance", priority: 6,  patterns: ["me, myself", "veni, vidi"] },
]

export function classifyGolazos(set_name: string): string[] {
  const haystack = (set_name ?? "").toLowerCase()
  if (!haystack) return []
  const matches: { title: string; priority: number }[] = []
  for (const rule of GOLAZOS_BADGE_RULES) {
    if (rule.patterns.some(p => haystack.includes(p))) {
      matches.push({ title: rule.badgeTitle, priority: rule.priority })
    }
  }
  matches.sort((a, b) => b.priority - a.priority)
  return matches.map(m => m.title)
}

export const GOLAZOS_BADGE_COLORS: Record<string, string> = {
  "El Clásico":            "bg-yellow-950 text-yellow-300 border border-yellow-700",
  "Eterno Rival":          "bg-orange-950 text-orange-300 border border-orange-800",
  "Ídolos":                "bg-purple-950 text-purple-300 border border-purple-800",
  "Estrellas":             "bg-blue-950 text-blue-300 border border-blue-800",
  "Team Europa":           "bg-teal-950 text-teal-300 border border-teal-800",
  "Tiki Taka":             "bg-green-950 text-green-300 border border-green-800",
  "Last Gasp":             "bg-red-950 text-red-300 border border-red-800",
  "Individual Brilliance": "bg-zinc-800 text-white border border-zinc-600",
}
