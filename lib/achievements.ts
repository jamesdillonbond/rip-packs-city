export interface AchievementTier {
  key: string;
  label: string;
  threshold: number;
  desc: string;
}

export interface AchievementDef {
  emoji: string;
  name: string;
  description: string;
  tiers: AchievementTier[];
}

export const ACHIEVEMENT_DEFS: Record<string, AchievementDef> = {
  pack_hunter: {
    emoji: "🎒",
    name: "Pack Hunter",
    description: "Rip packs to unlock tiers",
    tiers: [
      { key: "bronze", label: "Bronze", threshold: 10, desc: "10+ pack pulls" },
      { key: "silver", label: "Silver", threshold: 50, desc: "50+ pack pulls" },
      { key: "gold", label: "Gold", threshold: 200, desc: "200+ pack pulls" },
      { key: "platinum", label: "Platinum", threshold: 500, desc: "500+ pack pulls" },
    ],
  },
  diamond_hands: {
    emoji: "💎",
    name: "Diamond Hands",
    description: "Hold a Legendary for 180+ days",
    tiers: [
      { key: "gold", label: "Gold", threshold: 1, desc: "1+ Legendary held 6 months" },
    ],
  },
  serial_sniper: {
    emoji: "🎯",
    name: "Serial Sniper",
    description: "Own low serial moments",
    tiers: [
      { key: "bronze", label: "Bronze", threshold: 1, desc: "1+ moment with serial ≤100" },
      { key: "silver", label: "Silver", threshold: 1, desc: "1+ moment with serial ≤10" },
      { key: "gold", label: "Gold", threshold: 3, desc: "3+ moments with serial ≤10" },
    ],
  },
  trophy_curator: {
    emoji: "🏆",
    name: "Trophy Curator",
    description: "Pin moments to your Trophy Case",
    tiers: [
      { key: "bronze", label: "Bronze", threshold: 1, desc: "1 trophy pinned" },
      { key: "silver", label: "Silver", threshold: 3, desc: "3 trophies pinned" },
      { key: "gold", label: "Gold", threshold: 6, desc: "Full trophy case — all 6 slots" },
    ],
  },
  challenge_accepted: {
    emoji: "⚡",
    name: "Challenge Accepted",
    description: "Earn moments via challenges",
    tiers: [
      { key: "gold", label: "Gold", threshold: 1, desc: "1+ challenge reward earned" },
    ],
  },
  series_collector: {
    emoji: "📚",
    name: "Series Collector",
    description: "Collect across multiple series",
    tiers: [
      { key: "bronze", label: "Bronze", threshold: 3, desc: "Moments in 3+ series" },
      { key: "silver", label: "Silver", threshold: 5, desc: "Moments in 5+ series" },
      { key: "gold", label: "Gold", threshold: 7, desc: "Moments in 7+ series" },
    ],
  },
  big_spender: {
    emoji: "💰",
    name: "Big Spender",
    description: "Total marketplace spend",
    tiers: [
      { key: "bronze", label: "Bronze", threshold: 100, desc: "$100+ spent" },
      { key: "silver", label: "Silver", threshold: 1000, desc: "$1,000+ spent" },
      { key: "gold", label: "Gold", threshold: 10000, desc: "$10,000+ spent" },
    ],
  },
};

export function getTierColor(tier: string): string {
  switch ((tier || "").toLowerCase()) {
    case "bronze":
      return "#CD7F32";
    case "silver":
      return "#C0C0C0";
    case "gold":
      return "#F59E0B";
    case "platinum":
      return "#E0E0FF";
    default:
      return "#FFFFFF";
  }
}

export function getHighestTierLabel(def: AchievementDef, currentTier: string): string {
  const found = def.tiers.find((t) => t.key === currentTier);
  return found ? found.label : currentTier;
}
