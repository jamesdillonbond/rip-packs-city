// lib/emails/weekly-digest-news.ts
//
// "New on Rip Packs City" (2026-11-17): features members asked for, shipped, and then did not find
// (zero human use in the week after each shipped). Each item drops out of the email by itself
// NEW_ITEM_DAYS after it shipped, so a stale "new" line cannot linger.

import { emailLink } from "./email-link"

const NEW_ITEM_DAYS = 28;
export type NewItem = { shipped: string; title: string; line: string; path: string; campaign: string };
export const NEW_ITEMS: NewItem[] = [
  { shipped: "2026-11-14", title: "Serial search", line: "Find every listed copy of a serial number across all editions.", path: "/nba-top-shot/sniper", campaign: "new_serial_search" },
  { shipped: "2026-11-14", title: "Your open offers", line: "See every offer you have out and which ones have been outbid.", path: "/nba-top-shot/analytics", campaign: "new_open_offers" },
  { shipped: "2026-11-16", title: "Compare collections", line: "Put two collections side by side before you trade.", path: "/trades/compare", campaign: "new_compare" },
];
export function currentNewItems(now: Date): NewItem[] {
  return NEW_ITEMS.filter((i) => {
    const age = (now.getTime() - Date.parse(`${i.shipped}T12:00:00-08:00`)) / 86_400_000;
    return age >= 0 && age <= NEW_ITEM_DAYS;
  });
}
const escHtml = (t: string): string => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** The "New on Rip Packs City" block for the weekly email: HTML and plain-text lines (empty when nothing is current). */
export function buildNewItemsBlock(origin: string, now: Date): { html: string; text: string[] } {
  const news = currentNewItems(now).map((i) => ({ ...i, url: emailLink(`${origin}${i.path}`, "weekly_digest", i.campaign) }))
  if (!news.length) return { html: "", text: [] }
  const html = `<div style="border:1px solid rgba(255,255,255,0.1);border-radius:12px;padding:16px 20px;margin-bottom:20px">
      <div style="font-size:11px;color:rgba(255,255,255,0.5);text-transform:uppercase;letter-spacing:.12em;margin-bottom:8px">New on Rip Packs City</div>
      ${news.map((i) => `<div style="font-size:13px;line-height:1.5;margin-top:6px"><a href="${escHtml(i.url)}" style="color:#fff;font-weight:700">${escHtml(i.title)}</a> <span style="color:rgba(255,255,255,0.65)">· ${escHtml(i.line)}</span></div>`).join("")}
    </div>`
  const text = ["", "New on Rip Packs City:", ...news.map((i) => `- ${i.title}: ${i.line} ${i.url}`)]
  return { html, text }
}
