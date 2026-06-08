// Chain-aware wallet address validation.
//
// RPC is multi-chain (Flow chain one; Candy/Solana chain two in prep; Panini
// Ethereum bridge + Beezie/Base behind it). A wallet address is NOT universally
// "0x + 16 hex" — that is only Flow (Cadence). Each chain has its own shape:
//   - Cadence (Flow):   0x + exactly 16 hex chars
//   - EVM (Ethereum / Polygon / Flow-EVM / Base): 0x + exactly 40 hex chars
//   - Solana (Candy):   base58, ~32-44 chars, NO 0x prefix, CASE-SENSITIVE
//
// FOOTGUN: base58 is case-sensitive, so the many call sites that `.toLowerCase()`
// a wallet before storing/looking-up would corrupt a Solana address. Use
// `normalizeAddress` instead of a bare `.toLowerCase()` on any chain-agnostic path.

const CADENCE_ADDRESS_REGEX = /^0x[a-fA-F0-9]{16}$/;
const EVM_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;
// Base58 (Bitcoin alphabet — no 0, O, I, l). A 0x-prefixed string can never match
// (the alphabet excludes "0"), so this is unambiguous against Cadence/EVM.
const SOLANA_ADDRESS_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export type AddressChain = "cadence" | "evm" | "solana" | "unknown";

// The canonical address shape a collection's chain expects. Derived from a
// collection's `dbChain` (the `chain_type` enum: flow | ethereum | polygon |
// solana | flow_evm), which is the authoritative dispatch key in lib/collections.
export type ChainKind = "cadence" | "evm" | "solana";

export function isCadenceAddress(value: string): boolean {
  return CADENCE_ADDRESS_REGEX.test(value.trim());
}

export function isEvmAddress(value: string): boolean {
  return EVM_ADDRESS_REGEX.test(value.trim());
}

export function isSolanaAddress(value: string): boolean {
  return SOLANA_ADDRESS_REGEX.test(value.trim());
}

export function detectAddressChain(value: string): AddressChain {
  const trimmed = value.trim();
  if (isCadenceAddress(trimmed)) return "cadence";
  if (isEvmAddress(trimmed)) return "evm";
  if (isSolanaAddress(trimmed)) return "solana";
  return "unknown";
}

// True when `value` is a recognized address on ANY supported chain. Use at
// chain-agnostic entry points (the cross-collection wallet front door) that must
// accept Flow today and Solana/EVM as those chains come online — instead of a
// hard-coded Flow-only `/^0x...{16}$/` gate that rejects every non-Flow wallet.
export function isSupportedAddress(value: string): boolean {
  return detectAddressChain(value) !== "unknown";
}

// Maps a collection's `dbChain` (chain_type enum) to the address shape it expects.
// Returns null for chains with no on-chain wallet concept (e.g. dbChain === null).
export function chainKindForDbChain(
  dbChain: string | null | undefined
): ChainKind | null {
  switch (dbChain) {
    case "flow":
      return "cadence";
    case "ethereum":
    case "polygon":
    case "flow_evm":
      return "evm";
    case "solana":
      return "solana";
    default:
      return null;
  }
}

// Validates `value` against the address shape a specific collection's chain
// expects. When the chain is unknown/unmapped, falls back to "any supported
// address" rather than hard-rejecting, so an un-mapped collection never blocks a
// genuinely valid wallet.
export function isValidAddressForChain(
  value: string,
  dbChain: string | null | undefined
): boolean {
  const trimmed = value.trim();
  switch (chainKindForDbChain(dbChain)) {
    case "cadence":
      return isCadenceAddress(trimmed);
    case "evm":
      return isEvmAddress(trimmed);
    case "solana":
      return isSolanaAddress(trimmed);
    default:
      return isSupportedAddress(trimmed);
  }
}

// Case-safe normalization. Flow/EVM hex is case-insensitive → lowercase for
// stable keys. Solana base58 is CASE-SENSITIVE → preserve it verbatim. Reach for
// this anywhere a bare `address.toLowerCase()` previously ran on a chain-agnostic
// path, so a Solana address isn't silently corrupted.
export function normalizeAddress(value: string): string {
  const trimmed = value.trim();
  return detectAddressChain(trimmed) === "solana" ? trimmed : trimmed.toLowerCase();
}
