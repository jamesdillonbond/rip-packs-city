// lib/wallet-capability.ts
//
// Reads public.v_wallet_capability_tier — the Hybrid-Custody capability signal that
// decides what a connected Flow wallet is allowed to DO.
//
// Product ruling (Trevor, 2026-07-29): a Dapper Wallet sign-in grants READ-ONLY
// capability; a self-custody Flow wallet linked as the Hybrid-Custody PARENT is what
// unlocks advanced/transacting capability. That is the Flow Hybrid Custody model —
// a Dapper-custodial child cannot sign a withdraw, only its parent can.
//
// ⚠ ABSENCE IS NOT `read_only`. The view is built from `linked_accounts`, so it only
// knows addresses the Hybrid-Custody indexer has seen. An address with no row is
// UNKNOWN — most likely an ordinary self-custody wallet that never linked anything.
// Coalescing a missing row to `read_only` would silently downgrade every normal
// wallet on the platform. Hence `tier: "unknown"`, and `showLinkParentPrompt` is
// false for it: we neither grant advanced capability nor claim the wallet is
// read-only. This is also written into the view's COMMENT.
//
// ⚠ Every row today is `relationship = 'restricted'`. If an `owned`/unrestricted
// link type ever appears, revisit — an unrestricted child has broader rights than
// this model assumes.

import { supabaseAdmin } from "@/lib/supabase";

export type WalletCapabilityTier = "advanced" | "read_only" | "unknown";
export type WalletRole = "parent" | "child" | "standalone" | "unknown";

export interface WalletCapability {
  address: string;
  /** "unknown" when the Hybrid-Custody index has never seen this address. */
  tier: WalletCapabilityTier;
  role: WalletRole;
  /** Whether the view has a row for this address at all. */
  known: boolean;
  /** Offer transacting affordances. True ONLY for a confirmed active parent. */
  canTransact: boolean;
  /**
   * Show the "connect your Flow Wallet as parent to do this" explainer. True ONLY
   * when we positively know the wallet is read-only — never for an unknown wallet.
   */
  showLinkParentPrompt: boolean;
  isActiveParent: boolean;
  isActiveChild: boolean;
  activeChildren: number;
  activeParentAddr: string | null;
  lastLinkEventAt: string | null;
}

const ADDR_RE = /^0x[0-9a-f]{16}$/;

export function normalizeFlowAddress(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const addr = input.trim().toLowerCase();
  return ADDR_RE.test(addr) ? addr : null;
}

function unknownCapability(address: string): WalletCapability {
  return {
    address,
    tier: "unknown",
    role: "unknown",
    known: false,
    canTransact: false,
    showLinkParentPrompt: false,
    isActiveParent: false,
    isActiveChild: false,
    activeChildren: 0,
    activeParentAddr: null,
    lastLinkEventAt: null,
  };
}

/**
 * Resolve a wallet's capability tier.
 *
 * A malformed address resolves to `unknown` (never `read_only`). A DB read failure
 * THROWS rather than degrading to a tier — reporting a wallet as read-only because
 * a query failed is the same silent-downgrade bug in a different disguise. Callers
 * should treat a thrown error as "unknown", not as a denial.
 */
export async function getWalletCapability(address: unknown): Promise<WalletCapability> {
  const addr = normalizeFlowAddress(address);
  if (!addr) return unknownCapability(typeof address === "string" ? address : "");

  const { data, error } = await supabaseAdmin
    .from("v_wallet_capability_tier")
    .select(
      "address, role, capability_tier, is_active_parent, is_active_child, active_children, active_parent_addr, last_link_event_at",
    )
    .eq("address", addr)
    .maybeSingle();

  if (error) {
    throw new Error(`v_wallet_capability_tier read failed: ${error.message}`);
  }

  // No row => the indexer has never seen this address. UNKNOWN, not read_only.
  if (!data) return unknownCapability(addr);

  const tier: WalletCapabilityTier =
    data.capability_tier === "advanced" ? "advanced" : "read_only";
  const role: WalletRole =
    data.role === "parent" || data.role === "child" || data.role === "standalone"
      ? data.role
      : "unknown";

  return {
    address: addr,
    tier,
    role,
    known: true,
    canTransact: tier === "advanced",
    showLinkParentPrompt: tier === "read_only",
    isActiveParent: data.is_active_parent === true,
    isActiveChild: data.is_active_child === true,
    activeChildren: Number(data.active_children ?? 0),
    activeParentAddr: data.active_parent_addr ?? null,
    lastLinkEventAt: data.last_link_event_at ?? null,
  };
}
