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
