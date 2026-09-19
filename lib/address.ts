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

// Panini identity is a USERNAME, not an address — `panini_card_serials.owner` is
// 100% populated, 2,762 distinct, and ZERO EVM-shaped (verified live 2026-08-08),
// max observed length 16. The raw feed envelope's `my_public_wallet` key is NOT
// an address either: every one of the 35,734 recent rows carrying it holds the
// string "false" — it is a boolean visibility flag. There is no Panini wallet
// address anywhere in RPC's data, so `isValidAddressForChain` alone cannot gate
// this surface.
//
// Store lowercased: distinct(owner) == distinct(lower(owner)) == 2,762, so
// folding is collision-free — but 51,817 of 73,088 rows are MIXED CASE, so any
// exact-match read must join on `lower(owner)`, never on `owner`.
const PANINI_USERNAME_REGEX = /^[A-Za-z0-9_.-]{2,16}$/;

export function isPaniniUsername(value: string): boolean {
  return PANINI_USERNAME_REGEX.test(value.trim());
}

// ── Display ────────────────────────────────────────────────────────────────
//
// ⛔ WHAT THIS REPLACES, AND IT WAS A FABRICATION RATHER THAN AN ABSENCE. Every
// wallet-display helper in this repo was written when every wallet was Flow, so
// they all do the same two things: `.toLowerCase()`, then prepend `0x` if it is
// missing. Applied to a Solana mint that is BOTH case-sensitive AND un-prefixed,
// that produces a string which is wrong three ways at once — it claims a Flow
// shape, it is a DIFFERENT address once folded, and it does not exist.
//
// Measured live 2026-09-19 on /candy-mlb/player/mike-trout and
// /candy-mlb/edition/mike-trout-pink: buyer and owner labels rendered as
// `0x2at8…jrqw`, `0x1bwu…ndix`, while the `title=` tooltip on the SAME element
// carried the correct-case `AGzqZEJXbYeJze7aba6xTvQRHCt5ENmLhjbXejnzSpcQ`. So
// the visible label and its own tooltip disagreed, and a reader who copied what
// they could see got a dead string. ⚠ A page that renders nothing is honest; a
// page that renders a plausible wrong address is not.
//
// ⚠ THE HEX PATH IS BYTE-IDENTICAL to what those helpers already did — fold,
// then prefix — so no Flow surface moves.

/** Canonical display form: base58 verbatim, hex lowercased and `0x`-prefixed. */
export function displayAddress(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (isSolanaAddress(trimmed)) return trimmed;
  const lower = trimmed.toLowerCase();
  return lower.startsWith("0x") ? lower : `0x${lower}`;
}

/** `0x1234…abcd` / `AGzq…SpcQ`. Returns `fallback` for a missing address. */
export function truncateAddressForDisplay(
  value: string | null | undefined,
  fallback = "—",
): string {
  const shown = displayAddress(value);
  if (!shown) return fallback;
  return shown.length <= 12 ? shown : `${shown.slice(0, 6)}…${shown.slice(-4)}`;
}

// ── Query keys ─────────────────────────────────────────────────────────────
//
// ⛔ THE THIRD FACE OF THE SAME BUG, and the costliest one measured so far. The
// `/profile` aggregations (top-movers, tier-breakdown, cost-basis-summary) each
// build their query key with `raw.startsWith("0x") ? raw : "0x" + raw`. That was
// correct while every saved wallet was Flow. `saved_wallets` accepts a Candy
// address now (its route already uses `normalizeAddress`), so the prepend turns
// a real base58 key into one that matches nothing.
//
// ⚠ AND IT IS NOT AN HONEST ABSENCE, because these RPCs DO serve Candy — none of
// them folds its input and both read `wallet_moments_cache`, which holds 25,375
// Candy rows. Measured live 2026-09-19 against a real Candy wallet:
//
//   get_wallet_tier_counts(<base58>)        -> {"COMMON": 1626, "LEGENDARY": 100}
//   get_wallet_tier_counts('0x' || <base58>) -> {}
//   get_top_movers(<base58>)                -> real movers (ICONs, -11.29%)
//   get_top_movers('0x' || <base58>)        -> {"losers": [], "gainers": []}
//
// So the tier chart drops 1,726 moments and still counts the wallet as
// ATTEMPTED — a measured zero about a portfolio nobody looked at.
//
// ⚠ THE HEX PATH IS BYTE-IDENTICAL, including the ABSENCE of a lowercase: these
// call sites never folded, and adding a fold here would change what the database
// is handed on every Flow read — a regression smuggled in under a Solana fix.
// (This is deliberately NOT `displayAddress`, which DOES fold, because a display
// string and a query key have different jobs.)
export function walletQueryKey(value: string | null | undefined): string {
  if (!value) return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  // base58 is the key exactly as stored: no fold, no prefix.
  if (isSolanaAddress(trimmed)) return trimmed;
  return trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
}
