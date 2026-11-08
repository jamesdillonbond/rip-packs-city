// lib/routing/link-preview-bot.ts
//
// Link-preview crawlers and the dashboard's challenge deep link (2026-11-07).
//
// WHY: Trevor shares /dashboard?tab=trophy&challenge=dame-time — the link that
// LANDS a signed-in collector on the challenge. /dashboard is auth-gated, so a
// crawler (always signed out) was 302'd to /login and the link unfurled as the
// sign-in page. A crawler asking for that link is sent to the challenge's
// PUBLIC board, which carries the challenge's own card. People are unaffected:
// signed in, they get the dashboard; signed out, they still get /login?next=…
// and land on the challenge after signing in (no redirect loop through the
// board's own "Enter" button, which links back here).

import { isChallengeSlug } from "@/lib/trophy/challenge-link"

/** Crawlers that fetch a page only to build a link preview (not search engines). */
export const LINK_PREVIEW_BOT_RE =
  /Discordbot|Twitterbot|Slackbot|Slack-ImgProxy|facebookexternalhit|facebookcatalog|LinkedInBot|WhatsApp|TelegramBot|SkypeUriPreview|redditbot|Embedly|Pinterestbot|vkShare|Iframely|Mastodon|Bluesky|Applebot/i

export function isLinkPreviewBot(userAgent: string | null | undefined): boolean {
  return !!userAgent && LINK_PREVIEW_BOT_RE.test(userAgent)
}

/**
 * Where a signed-out request should go instead of /login, or null to keep the
 * normal sign-in redirect. Only a link-preview crawler, only the dashboard,
 * only a valid challenge slug.
 */
export function challengePreviewTarget(pathname: string, search: string, userAgent: string | null | undefined): string | null {
  if (pathname !== "/dashboard" || !isLinkPreviewBot(userAgent)) return null
  const slug = (new URLSearchParams(search).get("challenge") ?? "").trim().toLowerCase()
  return isChallengeSlug(slug) ? `/trophy-challenges/${slug}` : null
}
