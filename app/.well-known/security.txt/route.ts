// app/.well-known/security.txt/route.ts
//
// RFC 9116 security.txt — the one place a researcher or scanner looks for how
// to report a vulnerability. Until 2026-10-11 the site had none: no contact,
// no policy, nowhere but a public X handle buried in /privacy.
//
// A route handler rather than a file in public/: the proxy gates root-level
// public assets behind an exact allowlist (see STATIC_ROOT_ASSETS in proxy.ts),
// so a static file here would 307 to /login — which reads, to a scanner, as
// "no security.txt". The path is public in proxy.ts `isPublicPath` (exact
// match) and pinned by __tests__/proxy-is-public-path.test.ts.
//
// `Expires` is REQUIRED by the RFC and is the one field that goes stale on its
// own; it is derived at request time as one year ahead so the file is never
// served expired, and the Cache-Control keeps it to a daily recompute at the
// edge. Contacts: the mailbox /privacy, /terms and llms.txt name (confirmed
// 2026-10-12), then the X account.

import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"

const CONTACT_MAIL = "mailto:rippackscity@gmail.com"
const CONTACT = "https://x.com/RipPacksCity"
const CANONICAL = "https://www.rippackscity.com/.well-known/security.txt"

export function GET() {
  const expires = new Date()
  expires.setUTCFullYear(expires.getUTCFullYear() + 1)
  const body = [
    `Contact: ${CONTACT_MAIL}`,
    `Contact: ${CONTACT}`,
    `Expires: ${expires.toISOString()}`,
    "Preferred-Languages: en",
    `Canonical: ${CANONICAL}`,
    "Policy: https://www.rippackscity.com/privacy",
    "",
  ].join("\n")
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
    },
  })
}
