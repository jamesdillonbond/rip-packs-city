// lib/bot-ua.ts
//
// Moved verbatim from app/api/track-funnel/route.ts (2026-09-27) so the trophy
// funnel writer (lib/trophy/funnel-event.ts) classifies with the SAME regex
// instead of a second copy. The route re-exports it.

// ── Bot classification (deep-audit R23) ─────────────────────────────────────
// MEASURED 7 days to 2026-08-22: 15,803 events across 15,689 distinct sessions.
// Only 53 sessions (0.34%) fired more than one event, and 99.82% carried a null
// referrer. `getSessionId()` persists `rpc_sess` in sessionStorage, so a real
// multi-page visit SHARES one id — 1.007 events/session is a crawler with fresh
// storage per fetch, not browsing. `collection_view` rose 82 -> 7,738/day
// between 08-16 and 08-18 with ZERO change in wallet_paste, signups or sign-ins.
//
// The table had no way to express any of that, so any future read of "views" as
// traction is wrong by roughly three orders of magnitude. Same shape as the
// `is_smoke_test` lesson — except here the flag did not exist yet.
//
// ⚠ THIS IS A HEURISTIC AND THE COLUMN NAME SAYS SO. `bot_ua` records what the
// USER-AGENT claims, nothing more: a crawler that lies is not caught, and a real
// browser is never flagged by it. It is a cheap FIRST cut whose job is to make
// the honest slice possible at all — the stronger signals (one-event sessions,
// null referrer) stay in the analysis, not in this column.
//
// ⚠ Slice by this BEFORE slicing by time. That is the whole lesson.
export const BOT_UA = /bot|crawl|spider|slurp|bingpreview|headless|phantomjs|puppeteer|playwright|curl|wget|python-requests|httpx|axios|go-http-client|java\/|scrapy|facebookexternalhit|embedly|whatsapp|telegrambot|discordbot|semrush|ahrefs|mj12|dotbot|petalbot|bytespider|gptbot|claudebot|ccbot|perplexity|amazonbot|applebot|yandex|baiduspider|duckduckbot|lightpanda/i

/** True when the User-Agent SELF-IDENTIFIES as automated. Never a certainty. */
export function isBotUserAgent(ua: string | null | undefined): boolean {
  if (!ua) return false
  return BOT_UA.test(ua)
}
