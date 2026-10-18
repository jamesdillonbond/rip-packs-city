// lib/alerts/soldpacks.ts
//
// Shared "pack report" command for the Telegram + Discord bots. Given a wallet
// (pasted, or resolved from a linked identity), returns a compact pack summary
// + recent pack activity. Pure reads over two existing SECDEF RPCs
// (get_wallet_pack_summary / get_wallet_pack_history) — no new DB.

import { supabaseAdmin as supabase } from "@/lib/supabase";
import { resolveChannelOwner, type Channel } from "@/lib/alerts";
import { normalizeFlowAddress } from "@/lib/address";

// Accepts "0x…16hex" with or without the prefix; returns the normalized
// lowercase 0x-prefixed address, or null if it isn't a Flow address.
// The one copy lives in lib/address.ts (2026-10-16); re-exported for importers.
export { normalizeFlowAddress };

export interface PackReport {
  wallet: string;
  totals: {
    packs_purchased: number;
    packs_ripped: number;
    packs_sold: number;
    primary_drops: number;
    secondary_buys: number;
    spent_usd: number;
    sold_proceeds_usd: number;
    ripped_value_usd: number;
    net_pl_usd: number;
    /** Rips with a known pull value. ripped_value_usd and net_pl_usd count an
     *  unvalued rip as $0, so when this is below packs_ripped both are partial. */
    ripped_value_known_count: number;
    /** Primary drops whose price is unknown: spent_usd omits them. */
    primary_spend_unknown_count: number;
  } | null;
  recent: Array<{
    pack_name: string | null;
    status: string | null;
    buy_price: number | null;
    sell_price: number | null;
    pull_value_usd: number | null;
    realized_pl_usd: number | null;
    collection_name: string | null;
  }>;
}

// Resolve a wallet for an inbound bot message: explicit arg wins; otherwise
// fall back to the linked user's first saved wallet.
export async function resolveWalletForChannel(
  channel: Channel,
  channelUserId: string,
  explicit?: string | null
): Promise<string | null> {
  if (explicit) {
    const norm = normalizeFlowAddress(explicit);
    if (norm) return norm;
  }
  const owner = await resolveChannelOwner(channel, channelUserId);
  if (!owner.linked || !owner.owner_key) return null;
  const { data } = await supabase
    .from("saved_wallets")
    .select("wallet_addr")
    .eq("user_id", owner.owner_key)
    .order("pinned_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.wallet_addr ? normalizeFlowAddress(data.wallet_addr) : null;
}

export async function getPackReport(wallet: string): Promise<PackReport> {
  const [summaryRes, historyRes] = await Promise.all([
    (supabase as any).rpc("get_wallet_pack_summary", { p_wallet: wallet }),
    // Prefer sold packs; the formatter falls back to whatever recent activity
    // exists when a wallet has never sold a pack.
    (supabase as any).rpc("get_wallet_pack_history", { p_wallet: wallet, p_limit: 8, p_offset: 0 }),
  ]);

  // A failed summary read must not render as "No pack history found" (a false
  // account-level claim): throw, and each bot answers "Couldn't load".
  if (summaryRes?.error) {
    throw new Error(`get_wallet_pack_summary failed: ${summaryRes.error.message ?? String(summaryRes.error)}`);
  }
  const t = summaryRes?.data?.totals ?? null;
  const totals = t
    ? {
        packs_purchased: Number(t.packs_purchased ?? 0),
        packs_ripped: Number(t.packs_ripped ?? 0),
        packs_sold: Number(t.packs_sold ?? 0),
        primary_drops: Number(t.primary_drops ?? 0),
        secondary_buys: Number(t.secondary_buys ?? 0),
        spent_usd: Number(t.spent_usd ?? 0),
        sold_proceeds_usd: Number(t.sold_proceeds_usd ?? 0),
        ripped_value_usd: Number(t.ripped_value_usd ?? 0),
        net_pl_usd: Number(t.net_pl_usd ?? 0),
        // Absent count = unknown coverage: treat every rip as unvalued, never as valued.
        ripped_value_known_count: Number(t.ripped_value_known_count ?? 0),
        primary_spend_unknown_count: Number(t.primary_spend_unknown_count ?? 0),
      }
    : null;

  const packs: any[] = Array.isArray(historyRes?.data?.packs) ? historyRes.data.packs : [];
  // Surface sold/flipped packs first; fall back to recent ripped/held activity.
  const sorted = packs.sort((a, b) => {
    const rank = (s: string | null) => (s === "sold" || s === "flipped" ? 0 : 1);
    return rank(a.status) - rank(b.status);
  });
  const recent = sorted.slice(0, 5).map((p) => ({
    pack_name: p.pack_name ?? null,
    status: p.status ?? null,
    buy_price: p.buy_price != null ? Number(p.buy_price) : null,
    sell_price: p.sell_price != null ? Number(p.sell_price) : null,
    pull_value_usd: p.pull_value_usd != null ? Number(p.pull_value_usd) : null,
    realized_pl_usd: p.realized_pl_usd != null ? Number(p.realized_pl_usd) : null,
    collection_name: p.collection_name ?? null,
  }));

  return { wallet, totals, recent };
}

function money(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const v = Number(n);
  const sign = v < 0 ? "-" : "";
  return `${sign}$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// The RPC sums only what it can price: an unvalued rip adds $0 to the ripped
// value (understating P/L) and an unpriced primary drop adds $0 to spend
// (overstating it). Measured 2026-10-18: 11.1 % of 60-day rips are unvalued.
// So each figure states which way it is partial, and a P/L that is partial in
// BOTH directions has no sign we can stand behind.
export function packReportFigures(t: NonNullable<PackReport["totals"]>): {
  spent: string; rippedValue: string; netPl: string;
} {
  const unvalued = Math.max(0, t.packs_ripped - t.ripped_value_known_count);
  const unpricedDrops = Math.max(0, t.primary_spend_unknown_count);
  const spent = unpricedDrops > 0
    ? `≥ ${money(t.spent_usd)} (${unpricedDrops} drop${unpricedDrops === 1 ? "" : "s"} unpriced)`
    : money(t.spent_usd);
  const rippedValue = unvalued > 0
    ? `≥ ${money(t.ripped_value_usd)} (${t.ripped_value_known_count} of ${t.packs_ripped} rips valued)`
    : money(t.ripped_value_usd);
  let netPl: string;
  if (unvalued > 0 && unpricedDrops > 0) netPl = "— (unvalued rips and unpriced drops)";
  else if (unvalued > 0) netPl = `≥ ${money(t.net_pl_usd)}`;
  else if (unpricedDrops > 0) netPl = `≤ ${money(t.net_pl_usd)}`;
  else netPl = money(t.net_pl_usd);
  return { spent, rippedValue, netPl };
}

export function formatPackReportText(report: PackReport): string {
  const short = `${report.wallet.slice(0, 6)}…${report.wallet.slice(-4)}`;
  if (!report.totals || report.totals.packs_purchased + report.totals.primary_drops === 0) {
    return `No pack history found for ${short}.`;
  }
  const t = report.totals;
  const f = packReportFigures(t);
  const lines: string[] = [
    `📦 Pack report for ${short}`,
    "",
    `Purchased: ${t.packs_purchased}  (primary ${t.primary_drops} · secondary ${t.secondary_buys})`,
    `Ripped: ${t.packs_ripped}  ·  Sold: ${t.packs_sold}`,
    `Spent: ${f.spent}  ·  Sale proceeds: ${money(t.sold_proceeds_usd)}`,
    `Pulled value (ripped): ${f.rippedValue}`,
    `Net P/L: ${f.netPl}`,
  ];
  if (report.recent.length) {
    lines.push("", "Recent packs:");
    for (const p of report.recent) {
      const tail =
        p.status === "sold" || p.status === "flipped"
          ? `sold ${money(p.sell_price)} (P/L ${money(p.realized_pl_usd)})`
          : `${p.status ?? "—"} · pulled ${money(p.pull_value_usd)}`;
      lines.push(`• ${p.pack_name ?? "Pack"} — ${tail}`);
    }
  }
  lines.push("", "More at https://www.rippackscity.com/dashboard/history");
  return lines.join("\n");
}

export function formatPackReportDiscordEmbed(report: PackReport): any {
  const short = `${report.wallet.slice(0, 6)}…${report.wallet.slice(-4)}`;
  if (!report.totals || report.totals.packs_purchased + report.totals.primary_drops === 0) {
    return { title: `Pack report — ${short}`, description: "No pack history found.", color: 0xe03a2f };
  }
  const t = report.totals;
  const f = packReportFigures(t);
  const recent = report.recent
    .map((p) => {
      const tail =
        p.status === "sold" || p.status === "flipped"
          ? `sold ${money(p.sell_price)} (P/L ${money(p.realized_pl_usd)})`
          : `${p.status ?? "—"} · pulled ${money(p.pull_value_usd)}`;
      return `• ${p.pack_name ?? "Pack"} — ${tail}`;
    })
    .join("\n");
  return {
    title: `Pack report — ${short}`,
    url: "https://www.rippackscity.com/dashboard/history",
    color: 0xe03a2f,
    fields: [
      { name: "Purchased", value: `${t.packs_purchased} (P${t.primary_drops}/S${t.secondary_buys})`, inline: true },
      { name: "Ripped", value: String(t.packs_ripped), inline: true },
      { name: "Sold", value: String(t.packs_sold), inline: true },
      { name: "Spent", value: f.spent, inline: true },
      { name: "Proceeds", value: money(t.sold_proceeds_usd), inline: true },
      { name: "Pulled (ripped)", value: f.rippedValue, inline: true },
      { name: "Net P/L", value: f.netPl, inline: true },
      ...(recent ? [{ name: "Recent packs", value: recent.slice(0, 1000) }] : []),
    ],
    footer: { text: "Rip Packs City" },
  };
}
