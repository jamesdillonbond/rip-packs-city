// lib/alerts/soldpacks.ts
//
// Shared "pack report" command for the Telegram + Discord bots. Given a wallet
// (pasted, or resolved from a linked identity), returns a compact pack summary
// + recent pack activity. Pure reads over two existing SECDEF RPCs
// (get_wallet_pack_summary / get_wallet_pack_history) — no new DB.

import { supabaseAdmin as supabase } from "@/lib/supabase";
import { resolveChannelOwner, type Channel } from "@/lib/alerts";

const FLOW_ADDR_RE = /^0x[0-9a-f]{16}$/;

// Accepts "0x…16hex" with or without the prefix; returns the normalized
// lowercase 0x-prefixed address, or null if it isn't a Flow address.
export function normalizeFlowAddress(input: string): string | null {
  const t = (input || "").trim().toLowerCase();
  const withPrefix = t.startsWith("0x") ? t : `0x${t}`;
  return FLOW_ADDR_RE.test(withPrefix) ? withPrefix : null;
}

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

export function formatPackReportText(report: PackReport): string {
  const short = `${report.wallet.slice(0, 6)}…${report.wallet.slice(-4)}`;
  if (!report.totals || report.totals.packs_purchased + report.totals.primary_drops === 0) {
    return `No pack history found for ${short}.`;
  }
  const t = report.totals;
  const lines: string[] = [
    `📦 Pack report for ${short}`,
    "",
    `Purchased: ${t.packs_purchased}  (primary ${t.primary_drops} · secondary ${t.secondary_buys})`,
    `Ripped: ${t.packs_ripped}  ·  Sold: ${t.packs_sold}`,
    `Spent: ${money(t.spent_usd)}  ·  Sale proceeds: ${money(t.sold_proceeds_usd)}`,
    `Pulled value (ripped): ${money(t.ripped_value_usd)}`,
    `Net P/L: ${money(t.net_pl_usd)}`,
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
      { name: "Spent", value: money(t.spent_usd), inline: true },
      { name: "Proceeds", value: money(t.sold_proceeds_usd), inline: true },
      { name: "Net P/L", value: money(t.net_pl_usd), inline: true },
      ...(recent ? [{ name: "Recent packs", value: recent.slice(0, 1000) }] : []),
    ],
    footer: { text: "Rip Packs City" },
  };
}
