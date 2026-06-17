// lib/alerts/format.ts
//
// Per-channel message formatting for alert deliveries. A sender groups the
// pending rows for one (owner, channel) and renders ONE digest message so a
// user with 8 matching deals gets a single notification, not 8.
//
// Pure formatting — no DB, no network. Safe to import anywhere server-side.

import type { Delivery, DealPayload, FmvPayload } from "@/lib/alerts";

const SITE = "https://www.rippackscity.com";

function isDeal(d: Delivery): d is Delivery & { payload: DealPayload } {
  return d.alert_kind === "deal";
}
function isFmv(d: Delivery): d is Delivery & { payload: FmvPayload } {
  return d.alert_kind === "fmv";
}

function money(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function pct(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `${Math.round(Number(n))}%`;
}
function absUrl(detail: string | null | undefined): string {
  if (!detail) return SITE;
  return detail.startsWith("http") ? detail : `${SITE}${detail}`;
}
// Outbound buy link to the Top Shot edition listings page.
//
// DISABLED (2026-06-17): the previous format
// `https://nbatopshot.com/marketplace/editions/<setID>/<playID>` (on-chain
// integer ids) 404s on Top Shot. The working format is
// `https://nbatopshot.com/listings/p2p/<setUUID>+<playUUID>` — Top Shot's
// INTERNAL UUIDs joined with a literal `+`, set first. The deal payload only
// carries the integer external_id (setID:playID); the play UUID is not stored
// on canonical editions, so a correct link cannot be built here yet. Returns
// null so no broken "Buy on Top Shot" link renders.
//
// Proper fix (handoff-2026-06-17-alert-buy-link-url-correction.md): either
// persist play_uuid on editions (Option A) and build
// `…/listings/p2p/<set_uuid>+<play_uuid>`, or drive the link off the Atlas
// per-serial listings feed and use `…/moment/<momentId>` (Option B).
function topshotEditionMarketUrl(_deal: DealPayload["deal"]): string | null {
  return null;
}
function dealTitle(d: DealPayload["deal"]): string {
  return d.player_name || d.name || d.external_id || "Moment";
}
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── Telegram (HTML parse_mode) ───────────────────────────────────────────────

export function buildTelegramMessage(deliveries: Delivery[]): string {
  const deals = deliveries.filter(isDeal);
  const fmvs = deliveries.filter(isFmv);
  const lines: string[] = [];

  if (deals.length) {
    lines.push(`🎯 <b>${deals.length} new deal${deals.length === 1 ? "" : "s"} match your alerts</b>`);
    for (const d of deals.slice(0, 20)) {
      const deal = d.payload.deal;
      const title = esc(dealTitle(deal));
      const sub = esc([deal.set_name, deal.collection_name].filter(Boolean).join(" · "));
      const buyUrl = topshotEditionMarketUrl(deal);
      lines.push(
        `\n<a href="${absUrl(deal.detail_url)}">${title}</a>` +
          (sub ? `\n${sub}` : "") +
          `\n${money(deal.low_ask)} ask · ${pct(deal.discount_pct)} below FMV ${money(deal.fmv_usd)}` +
          (buyUrl ? ` · <a href="${buyUrl}">Buy on Top Shot ↗</a>` : "")
      );
    }
    if (deals.length > 20) lines.push(`\n…and ${deals.length - 20} more.`);
  }

  if (fmvs.length) {
    if (lines.length) lines.push("");
    lines.push(`🔔 <b>${fmvs.length} FMV alert${fmvs.length === 1 ? "" : "s"} triggered</b>`);
    for (const d of fmvs.slice(0, 20)) {
      const p = d.payload;
      const title = esc(p.player_name || p.edition_key || "Edition");
      lines.push(`\n${title}\nAsk ${money(p.lowest_ask)} · FMV ${money(p.current_fmv)}`);
    }
  }

  lines.push(`\n\nManage: ${SITE}/alerts`);
  return lines.join("\n");
}

// ── Discord embeds (max 10 per message) ──────────────────────────────────────

const RPC_RED = 0xe03a2f;

export function buildDiscordEmbeds(deliveries: Delivery[]): any[] {
  const embeds: any[] = [];
  for (const d of deliveries.slice(0, 10)) {
    if (isDeal(d)) {
      const deal = d.payload.deal;
      const buyUrl = topshotEditionMarketUrl(deal);
      // Discord embed field VALUES render markdown links; field NAMES don't.
      const fields: any[] = [
        { name: "Ask", value: money(deal.low_ask), inline: true },
        { name: "FMV", value: money(deal.fmv_usd), inline: true },
        { name: "Discount", value: pct(deal.discount_pct), inline: true },
      ];
      if (buyUrl) fields.push({ name: "Buy", value: `[Top Shot ↗](${buyUrl})`, inline: true });
      embeds.push({
        title: dealTitle(deal),
        url: absUrl(deal.detail_url),
        description: [deal.set_name, deal.collection_name].filter(Boolean).join(" · ") || undefined,
        color: RPC_RED,
        thumbnail: deal.thumbnail_url ? { url: absUrl(deal.thumbnail_url) } : undefined,
        fields,
        footer: { text: "Rip Packs City · /alerts to manage" },
      });
    } else if (isFmv(d)) {
      const p = d.payload;
      embeds.push({
        title: p.player_name || p.edition_key || "FMV alert",
        color: RPC_RED,
        fields: [
          { name: "Ask", value: money(p.lowest_ask), inline: true },
          { name: "FMV", value: money(p.current_fmv), inline: true },
        ],
        footer: { text: "Rip Packs City · /alerts to manage" },
      });
    }
  }
  return embeds;
}

// ── Email (Resend) ───────────────────────────────────────────────────────────

export function buildEmailMessage(deliveries: Delivery[]): {
  subject: string;
  html: string;
  text: string;
} {
  const deals = deliveries.filter(isDeal);
  const fmvs = deliveries.filter(isFmv);
  const total = deals.length + fmvs.length;

  const subject =
    deals.length && !fmvs.length
      ? `${deals.length} new deal${deals.length === 1 ? "" : "s"} match your Rip Packs City alert`
      : `${total} Rip Packs City alert${total === 1 ? "" : "s"}`;

  const dealRows = deals
    .map((d) => {
      const deal = d.payload.deal;
      const buyUrl = topshotEditionMarketUrl(deal);
      const thumb = deal.thumbnail_url
        ? `<img src="${absUrl(deal.thumbnail_url)}" width="48" height="48" style="border-radius:8px;display:block;" alt=""/>`
        : "";
      return `
        <tr>
          <td style="padding:12px 0;border-bottom:1px solid #27272a;vertical-align:top;width:60px;">${thumb}</td>
          <td style="padding:12px 0;border-bottom:1px solid #27272a;">
            <a href="${absUrl(deal.detail_url)}" style="color:#fafafa;font-weight:700;text-decoration:none;font-size:15px;">${esc(dealTitle(deal))}</a>
            <div style="color:rgba(255,255,255,0.5);font-size:12px;margin-top:2px;">${esc([deal.set_name, deal.collection_name].filter(Boolean).join(" · "))}</div>
            ${buyUrl ? `<div style="margin-top:4px;"><a href="${buyUrl}" style="color:#e55a4c;font-size:12px;font-weight:700;text-decoration:none;">Buy on Top Shot ↗</a></div>` : ""}
          </td>
          <td style="padding:12px 0;border-bottom:1px solid #27272a;text-align:right;white-space:nowrap;">
            <div style="color:#34d399;font-weight:800;font-size:15px;">${money(deal.low_ask)}</div>
            <div style="color:rgba(255,255,255,0.5);font-size:12px;">${pct(deal.discount_pct)} below FMV ${money(deal.fmv_usd)}</div>
          </td>
        </tr>`;
    })
    .join("");

  const fmvRows = fmvs
    .map((d) => {
      const p = d.payload;
      return `
        <tr>
          <td style="padding:12px 0;border-bottom:1px solid #27272a;">
            <span style="color:#fafafa;font-weight:700;font-size:15px;">${esc(p.player_name || p.edition_key || "Edition")}</span>
          </td>
          <td style="padding:12px 0;border-bottom:1px solid #27272a;text-align:right;white-space:nowrap;">
            <div style="color:#34d399;font-weight:800;">${money(p.lowest_ask)}</div>
            <div style="color:rgba(255,255,255,0.5);font-size:12px;">FMV ${money(p.current_fmv)}</div>
          </td>
        </tr>`;
    })
    .join("");

  const html = `<!doctype html><html><body style="margin:0;background:#0a0a0a;color:#fafafa;font-family:-apple-system,Segoe UI,Roboto,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#18181b;border:1px solid #27272a;border-radius:14px;">
        <tr><td style="padding:28px 28px 8px 28px;">
          <div style="font-size:11px;letter-spacing:0.22em;text-transform:uppercase;color:#e55a4c;font-weight:700;margin-bottom:8px;">Rip Packs City</div>
          <h1 style="margin:0 0 4px 0;font-size:22px;">${esc(subject)}</h1>
        </td></tr>
        <tr><td style="padding:8px 28px 24px 28px;">
          ${deals.length ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${dealRows}</table>` : ""}
          ${fmvs.length ? `<div style="margin-top:16px;font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:rgba(255,255,255,0.45);font-weight:700;">FMV alerts</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${fmvRows}</table>` : ""}
          <p style="margin:22px 0 0 0;text-align:center;">
            <a href="${SITE}/alerts" style="color:rgba(255,255,255,0.55);font-size:12px;text-decoration:underline;">Manage your alerts</a>
          </p>
        </td></tr>
      </table>
    </td></tr></table>
  </body></html>`;

  const textLines: string[] = [subject, ""];
  for (const d of deals) {
    const deal = d.payload.deal;
    const buyUrl = topshotEditionMarketUrl(deal);
    textLines.push(`• ${dealTitle(deal)} — ${money(deal.low_ask)} (${pct(deal.discount_pct)} below FMV ${money(deal.fmv_usd)})`);
    textLines.push(`  Details: ${absUrl(deal.detail_url)}`);
    if (buyUrl) textLines.push(`  Buy on Top Shot: ${buyUrl}`);
  }
  for (const d of fmvs) {
    const p = d.payload;
    textLines.push(`• ${p.player_name || p.edition_key} — ask ${money(p.lowest_ask)} / FMV ${money(p.current_fmv)}`);
  }
  textLines.push("", `Manage: ${SITE}/alerts`);

  return { subject, html, text: textLines.join("\n") };
}
