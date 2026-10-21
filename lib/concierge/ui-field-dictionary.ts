// A dictionary of what the numbers and badges on RPC's surfaces MEAN, read
// from the rendering code (2026-10-03). The concierge's explain_ui_field tool
// answers "what is the +$ in the top right?" from this instead of asking the
// user to diagnose the page. Every entry names the file the meaning was read
// from; an entry is only as current as that file. Add to it when a reader
// asks about a field that is not here — the question itself is the signal.

import { FMV_ALGO_VERSION, FMV_RECENT_SALES_N, FMV_RECENT_SPAN_DAYS } from "@/lib/fmv-recalc-math";
import { NOTIFY_MODE_HINT, NOTIFY_MODE_LABEL } from "@/lib/alerts/notify-mode";

export type UiFieldEntry = {
  id: string;
  surface: string;
  field: string;
  aliases: string[];
  meaning: string;
  source: string;
};

export const UI_FIELD_DICTIONARY: readonly UiFieldEntry[] = [
  {
    id: "team-checklist.add-cost-badge",
    surface: "team checklist (/[collection]/team/[slug])",
    field: "\"+ $X ASK\" / \"+ $X FMV\" / \"+ $X PAR\" badge in a card's top-right corner (only when a wallet is scored)",
    aliases: ["+ $", "+$", "plus dollar", "top right", "top-right", "$ value", "value number", "number on the card", "add cost", "+ add", "ask fmv par", "par badge", "cheapest way in"],
    meaning:
      "The cheapest way IN to that missing edition — its contribution to the checklist's cost-to-complete. The suffix says what the figure is: ASK = the LIVE low ask for the edition (used when it is within 3× FMV); FMV = the edition's FMV because nothing is listed; PAR = the price of a PARALLEL of this edition (the \"Full editions\" view counts owning any parallel as collected, so the cheapest parallel is the cheapest way in). It is therefore not the high offer and, when the suffix is FMV or PAR, not this edition's own low ask either. \"+ add\" means no price is on file. Hovering the badge spells it out. Owned cards show ✓ (×N for multiples) and 🔒 when the owned copy is locked. (Before 2026-10-03 ~1:00 PM PT the badge was an unlabelled \"+ $X\" — the question that produced this entry.)",
    source: "components/entity/TeamChecklist.tsx (addLabel / addTitle, 8e5435d) + lib/entity/checklist-full-editions.ts (edition_cost_source, edition_cost_from_parallel)",
  },
  {
    id: "team-checklist.cost-to-complete",
    surface: "team checklist header",
    field: "Cost to complete",
    aliases: ["cost to complete", "completion cost", "how much to finish"],
    meaning:
      "The sum of the per-edition add costs over every missing edition that HAS a price: the live low ask where one is listed (within 3× FMV), else FMV; cheapest-of-parallels in the Full editions view. Editions with no price on file are counted separately as unpriced and are NOT in the total, so the true cost is at least this number. An estimate, not a quote.",
    source: "lib/entity/checklist-full-editions.ts (progress: cost, unpriced_missing_count; 8e5435d)",
  },
  {
    id: "team-checklist.views",
    surface: "team checklist toggles",
    field: "All moments vs Full editions; All-Time vs Contemporary",
    aliases: ["all moments", "full editions", "all-time", "contemporary", "scope", "view toggle", "parallels toggle"],
    meaning:
      "\"All moments\" lists every edition including each parallel as its own card; \"Full editions\" lists one card per play (the base edition) and treats owning ANY parallel of it as collected. \"All-Time\" includes every era the franchise minted under (historic team labels included); \"Contemporary\" is the current-label era only.",
    source: "components/entity/TeamChecklist.tsx + app/api/entity/team-checklist-full-editions/route.ts (view, scope)",
  },
  {
    id: "fmv",
    surface: "edition page, moment cards, wallet views",
    field: "FMV",
    aliases: ["fmv", "fair market value", "value", "what is fmv"],
    meaning:
      `Rip Packs City's modelled Fair Market Value for the edition: the median of its ${FMV_RECENT_SALES_N} most recent typical sales (sales within ${FMV_RECENT_SPAN_DAYS} days of the newest, special serials and grail spikes set aside), widened to 90 days when the edition is too thin to price otherwise. It is a value estimate, not a listing price; it is NOT the low ask and NOT the high offer.`,
    source: `lib/fmv-recalc-math.ts medianOfMostRecent (algo ${FMV_ALGO_VERSION})`,
  },
  {
    id: "fmv.confidence",
    surface: "NOT SHOWN on the site (internal only since 2026-10-18)",
    field: "confidence (HIGH / MEDIUM / LOW / STALE / ASK_ONLY / SALES_ONLY / NO_DATA)",
    aliases: ["confidence", "high medium low", "stale", "ask only", "sales only", "no data", "colour of the number", "color of the fmv"],
    meaning:
      "RPC does not publish a confidence rating — it is internal (Trevor, 2026-10-18). If a user asks about it, say the site shows no confidence rating and describe the facts behind the price instead (how many recent sales, when the last one was, whether it comes from a listing). Never name a tier to the user. Internal meaning: HIGH: enough recent sales that agree. MEDIUM: enough sales but noisier, or a thin edition corroborated by a fresh ask. LOW: too few sales or too much disagreement — directional only. STALE: the number was carried forward, not recently recomputed. ASK_ONLY: a live ask with no sales behind it (a floor, not a value). SALES_ONLY: old sales with no ask to corroborate. NO_DATA: nothing to price from. Only HIGH and MEDIUM should be read as a market value.",
    source: "app/api/support-chat/route.ts FMV_METHODOLOGY_BLOCK",
  },
  {
    id: "edition.low-ask-high-offer",
    surface: "edition page",
    field: "Low ask / High offer / Last sale",
    aliases: ["low ask", "lowest ask", "floor", "high offer", "best offer", "last sale", "recent sale"],
    meaning:
      "Low ask: the cheapest listing RPC has for the edition (live for Top Shot via the marketplace; indexed for others, with a timestamp). High offer: the highest standing offer in RPC's market bundle for the edition, with an updated_at — on a parallel page it is either scoped to that printing or an edition-wide offer any printing can fill (the cell label says which). Last sale: the most recent recorded sale. None of these is the FMV; the FMV is modelled from the sales history.",
    source: "lib/entity/edition-market-fetchers.ts (HighOffer: highest_offer, low_ask, updated_at, offer_scope) + get_edition_listings",
  },
  {
    id: "serial.fmv",
    surface: "moment / serial detail",
    field: "Serial FMV",
    aliases: ["serial fmv", "serial value", "special serial", "#1 serial", "jersey match", "perfect mint", "low serial"],
    meaning:
      "The edition FMV multiplied by a serial premium for #1, jersey-number match, perfect mint (last serial), and low serials. Quirky serials (palindromes, 420s) carry no premium.",
    source: "app/api/support-chat/route.ts FMV_METHODOLOGY_BLOCK (Serials)",
  },
  {
    id: "sniper.after-fees",
    surface: "sniper / deals board",
    field: "DEALS AFTER FEES toggle; net after fee",
    aliases: ["after fees", "deals after fees", "net after fee", "fee", "net"],
    meaning:
      "The listing's margin against FMV after the marketplace fee is deducted. With the toggle on (the default), listings whose fee-net margin is zero or negative are hidden, so a $0.25 common at \"net +$0.00\" no longer fills the first screen.",
    source: "components/sniper/SniperFilterBar.tsx (afterFeesOnly) + the 2026-10-03 ledger entry \"sniper: hide listings the fee erases by default\"",
  },
  {
    id: "trophy-case.badges",
    surface: "trophy case / profile",
    field: "moment badges",
    aliases: ["badges", "debut", "rookie year", "rookie debut", "badge missing"],
    meaning:
      "Badges are the moment's Top Shot tags (Debut, Rookie Year, Rookie Debut, …) read from the catalog. Special-serial badges (#1, perfect mint, jersey match) are a separate class computed from the serial; if they are absent on a card where the serial qualifies, that is a known report (2026-09-30, trophy case), not a missing tag.",
    source: "beta-feedback queue 2026-09-30 + app/api/support-chat/route.ts (badges guidance)",
  },
  {
    id: "pack-simulator.ev-per-slot",
    surface: "pack rip simulator (/[collection]/packs/simulator/[distId])",
    field: "EV / Slot (shown as \"≥ $X\" when coverage is under 100%)",
    aliases: ["ev / slot", "ev per slot", "ev slot", "expected value", "≥", "greater than", "at least", "pack ev", "ev"],
    meaning:
      "The expected FMV of ONE slot: every pullable edition's latest FMV weighted by its drop weight. An edition with no FMV counts as $0, so when FMV cov. is under 100% the figure is a LOWER BOUND and is shown with \"≥\" (hover says how many pullable editions are unpriced). Multiply by Slots / Pack for a whole pack. It may differ from the trimmed-mean pack EV on the pack listing page, which is computed separately.",
    source: "public.pack_grail_metrics (ev_per_slot = sum(drop_weight × coalesce(fmv,0)) / sum(drop_weight)) via get_pack_for_simulator + PackSimulatorClient.tsx",
  },
  {
    id: "pack-simulator.header-stats",
    surface: "pack rip simulator header",
    field: "Slots / Pack, Pool, FMV cov., Depletion, Chase",
    aliases: ["slots", "slots / pack", "~", "pool", "editions", "fmv cov", "fmv coverage", "coverage", "depletion", "chase", "max pull"],
    meaning:
      "Slots / Pack: moments per pack; a trailing \"~\" means the pack does not publish it and the simulator assumed 5. Pool: how many editions can still be pulled (drop weight > 0). FMV cov.: the share of those pullable editions that have an FMV. Depletion: the share of the drop's minted packs already opened, from the pack's distribution record (\"—\" when unknown). Chase: the single highest-FMV edition in the pool.",
    source: "PackSimulatorClient.tsx (Stat row) + public.pack_grail_metrics (edition_count_pullable, fmv_coverage_pct, max_pull_*) + pack_distributions.depletion_pct",
  },
  {
    id: "overview.priced-from-sales",
    surface: "collection overview (/[collection]/overview)",
    field: "Priced from Recent Sales",
    aliases: ["priced from recent sales", "priced from sales", "priced", "coverage", "how much is priced", "overview percentage"],
    meaning:
      "The share of this collection's editions whose FMV rests on corroborated recent sales rather than an ask, older sales or nothing — so a closed market reads 0% even though its closing values come from sales. It is NOT the share of editions that have any FMV at all, which is much larger. \"—\" means the figure could not be read, not 0%.",
    source: "app/(collections)/[collection]/overview/CollectionOverviewClient.tsx (fmv_high_medium_pct; no fallback to fmv_pct)",
  },
  {
    id: "alerts.notify-mode",
    surface: "alerts page (/alerts), deal alert form",
    field: "Notify me (how often an alert repeats)",
    aliases: ["notify me", "notify mode", "how often", "repeat", "every day", "my alert", "pinging me", "ping me", "alert again", "only once", "relisted", "cadence", "daily digest", "weekly digest"],
    // Built from the same text the form shows under the select, so this answer
    // cannot drift from the control (lib/alerts/notify-mode.ts).
    meaning:
      `How often one deal alert repeats for the same moment. ${NOTIFY_MODE_LABEL.new_listing} (the default): ${NOTIFY_MODE_HINT.new_listing} ${NOTIFY_MODE_LABEL.once}: ${NOTIFY_MODE_HINT.once} ${NOTIFY_MODE_LABEL.daily}: ${NOTIFY_MODE_HINT.daily} There is no daily or weekly DIGEST — before 2026-10-14 the form offered one and nothing implemented it; it was replaced by this setting.`,
    source: "app/alerts/AlertsClient.tsx (alert-notify-mode) + lib/alerts/notify-mode.ts + dispatch_due_deal_alerts (20261015002500)",
  },
];

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9$#+ ]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Score entries against a free-text question; returns the best matches
 * (highest first). Matching is token overlap over field + aliases + surface,
 * with an exact alias hit ranked above everything else.
 */
export function lookupUiField(question: string, surface?: string | null, limit = 3): UiFieldEntry[] {
  const q = norm(question);
  const qTokens = new Set(q.split(" ").filter((t) => t.length > 1));
  const sNorm = surface ? norm(surface) : "";
  // "+62.00", "+ $62", "+$12.50": a plus sign before a figure is the add-cost
  // badge's own shape, whatever words surround it.
  const plusFigure = /\+\s*\$?\d/.test(question);
  const scored = UI_FIELD_DICTIONARY.map((e) => {
    let score = 0;
    if (plusFigure && e.aliases.includes("+$")) score += 20;
    for (const a of e.aliases) {
      const an = norm(a);
      if (an && q.includes(an)) score += 10 + an.length;
    }
    const hay = norm(`${e.field} ${e.surface} ${e.aliases.join(" ")}`);
    for (const t of qTokens) if (hay.includes(t)) score += 1;
    if (sNorm && norm(e.surface).split(" ").some((w) => w.length > 3 && sNorm.includes(w))) score += 3;
    return { e, score };
  });
  return scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.e);
}
