// lib/alerts/discord-verify.ts
//
// Verify a Discord interaction's Ed25519 signature using Node's built-in
// crypto (Node 24) — no tweetnacl dependency. Discord signs (timestamp + rawBody)
// with its application key; we verify against DISCORD_PUBLIC_KEY (a 32-byte hex
// raw Ed25519 public key) by wrapping the raw key in the fixed SPKI/DER prefix
// for Ed25519 so createPublicKey can ingest it.

import { createPublicKey, verify as cryptoVerify } from "node:crypto";

// DER SPKI header for an Ed25519 public key (RFC 8410): SEQUENCE { algo id }
// + BIT STRING tag, immediately followed by the 32 raw key bytes.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function rawHexToPublicKey(publicKeyHex: string) {
  const raw = Buffer.from(publicKeyHex, "hex");
  if (raw.length !== 32) throw new Error("Ed25519 public key must be 32 bytes");
  const der = Buffer.concat([ED25519_SPKI_PREFIX, raw]);
  return createPublicKey({ key: der, format: "der", type: "spki" });
}

// Returns true iff the signature is valid. Never throws — a malformed
// signature/timestamp/key resolves to false so the route returns 401.
export function verifyDiscordRequest(args: {
  publicKeyHex: string;
  signatureHex: string;
  timestamp: string;
  rawBody: string;
}): boolean {
  try {
    if (!args.publicKeyHex || !args.signatureHex || !args.timestamp) return false;
    const key = rawHexToPublicKey(args.publicKeyHex);
    const message = Buffer.from(args.timestamp + args.rawBody);
    const signature = Buffer.from(args.signatureHex, "hex");
    if (signature.length !== 64) return false;
    return cryptoVerify(null, message, key, signature);
  } catch {
    return false;
  }
}
