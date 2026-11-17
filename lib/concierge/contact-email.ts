// lib/concierge/contact-email.ts
//
// A SIGNED-OUT reporter's volunteered email (2026-11-09 weekend review). On
// 11-07 the weekend's only human concierge session filed a real bug (Yan
// Diomande Panini FMVs) from a signed-out visitor, and nothing could tell them
// when it was fixed: shipped-notify (app/api/admin/feedback/[id]) emails
// `support_conversations.user_email`, and a signed-out row has none.
//
// The concierge now offers ONCE, after logging, to send a note when it's fixed;
// if the user replies with an address it is attached to THAT report. This
// helper is the only gate the address passes:
//   · it must look like one address (no spaces, one @, a dotted domain, ≤ 254);
//   · it must appear VERBATIM in what the USER typed this conversation — the
//     model can relay an address, never invent or "correct" one;
//   · a signed-in user's account email always wins (the caller never asks them).

import { textIncludes } from "@/lib/filter-match"

const EMAIL_RE = /^[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[^\s@<>()[\],;:".]{2,}$/

/** The address to store, or null when it fails any check above. */
export function volunteeredContactEmail(raw: unknown, userTyped: readonly string[]): string | null {
  if (typeof raw !== "string") return null
  const email = raw.trim()
  if (email.length === 0 || email.length > 254 || !EMAIL_RE.test(email)) return null
  // textIncludes: the repo's one case-insensitive containment (a-search-box-matches-accented-names).
  const typed = userTyped.some((m) => typeof m === "string" && textIncludes(m, email))
  return typed ? email : null
}
