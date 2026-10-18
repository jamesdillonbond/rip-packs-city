// lib/emails/sender-identity.ts
//
// The one footer line every outbound email carries, so a reader can tell who
// sent it and how to reach them. CAN-SPAM wants a valid physical postal
// address on COMMERCIAL mail; until a registered-agent or PO box address is
// added here, the digests stay behind their flags (they are off today) and
// transactional mail carries the entity, city and mailbox.
export const SENDER_ENTITY = "Rip Packs City LLC"
export const SENDER_LOCALITY = "Portland, Oregon"
export const SENDER_MAILBOX = "rippackscity@gmail.com"
export const SENDER_LINE = `${SENDER_ENTITY} · ${SENDER_LOCALITY} · ${SENDER_MAILBOX}`

// ── Commercial-mail gate (2026-10-18, C2) ───────────────────────────────────
// A digest is COMMERCIAL mail: CAN-SPAM requires a valid physical postal
// address in it. The address is Trevor's to supply (C2), so it is read from the
// environment and NEVER defaulted — an absent address must block the send, not
// render as a blank or a placeholder. Turning digests on is then two settings:
// RPC_SENDER_POSTAL_ADDRESS and the route's own enable flag, and neither alone
// sends anything.
export function senderPostalAddress(): string | null {
  const v = process.env.RPC_SENDER_POSTAL_ADDRESS?.trim()
  return v ? v : null
}

export type CommercialSendBlock = "flag_off" | "postal_address_missing"

/** Why a commercial send must not happen, or null when it may. The flag is
 *  checked first so a disabled route reports "off", not a missing address. */
export function commercialSendBlockedReason(flagEnabled: boolean): CommercialSendBlock | null {
  if (!flagEnabled) return "flag_off"
  if (!senderPostalAddress()) return "postal_address_missing"
  return null
}

/** Footer line for COMMERCIAL mail: the sender line plus the postal address.
 *  Call only after commercialSendBlockedReason() returned null. */
export function commercialSenderLine(): string {
  const postal = senderPostalAddress()
  if (!postal) throw new Error("commercialSenderLine: RPC_SENDER_POSTAL_ADDRESS is not set")
  return `${SENDER_ENTITY} · ${postal} · ${SENDER_MAILBOX}`
}
