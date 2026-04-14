export type AlldayBadgeRule = {
  badgeTitle: string
  priority: number
  patterns: string[]
}

export const ALLDAY_BADGE_RULES: AlldayBadgeRule[] = [
  { badgeTitle: "Rookie",             priority: 9,  patterns: ["rookie", "class of", "first class"] },
  { badgeTitle: "Super Bowl",         priority: 10, patterns: ["super bowl"] },
  { badgeTitle: "Playoffs",           priority: 8,  patterns: ["playoff", "wild card", "divisional", "championship game", "nfc title", "afc title", "conference championship"] },
  { badgeTitle: "Pro Bowl",           priority: 7,  patterns: ["pro bowl", "all-pro"] },
  { badgeTitle: "First Touchdown",    priority: 9,  patterns: ["first touchdown", "first td"] },
  { badgeTitle: "Record Breaking",    priority: 8,  patterns: ["record breaking", "historic", "milestone"] },
  { badgeTitle: "Championship Year",  priority: 7,  patterns: ["super bowl champ", "world champion"] },
]

export function classifyAlldayBadges(set_name: string): string[] {
  const haystack = (set_name ?? "").toLowerCase()
  if (!haystack) return []
  const matches: { title: string; priority: number }[] = []
  for (const rule of ALLDAY_BADGE_RULES) {
    if (rule.patterns.some(p => haystack.includes(p))) {
      matches.push({ title: rule.badgeTitle, priority: rule.priority })
    }
  }
  matches.sort((a, b) => b.priority - a.priority)
  return matches.map(m => m.title)
}

export const ALLDAY_BADGE_COLORS: Record<string, string> = {
  "Rookie":            "bg-green-950 text-green-300 border border-green-800",
  "Super Bowl":        "bg-yellow-950 text-yellow-300 border border-yellow-700",
  "Playoffs":          "bg-blue-950 text-blue-300 border border-blue-800",
  "Pro Bowl":          "bg-purple-950 text-purple-300 border border-purple-800",
  "First Touchdown":   "bg-orange-950 text-orange-300 border border-orange-800",
  "Record Breaking":   "bg-teal-950 text-teal-300 border border-teal-800",
  "Championship Year": "bg-zinc-800 text-white border border-zinc-600",
}
