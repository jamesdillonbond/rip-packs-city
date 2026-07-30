// lib/chains/flow/fcl-config.ts
//
// THE SINGLE OWNER OF FCL WALLET DISCOVERY.
//
// `discovery.wallet` is a global FCL singleton. Until 2026-07-29 two modules wrote
// it — this one (self-custody) and lib/chains/flow/flow.ts (Dapper-restricted, via
// an auto-init import side effect) — each behind its own init guard that could not
// see the other, so both endpoints shipped to /dashboard and the winner was
// import-order dependent. flow.ts now configures the CHAIN only and carries no
// `discovery.*` key; every wallet-connect path goes through configureFcl() here.
// `__tests__/fcl-discovery-single-owner.test.ts` pins that invariant.
//
// Capability model (Trevor, 2026-07-29): a Dapper Wallet sign-in grants READ-ONLY
// capability; a self-custody Flow wallet linked as the Hybrid-Custody PARENT is what
// unlocks transacting. So sign-in defaults to self-custody discovery, and the
// Dapper-custodial endpoint is reserved for the one case where a Dapper child
// genuinely signs. Enforcement of what a connected wallet may do lives in
// lib/wallet-capability.ts (reads v_wallet_capability_tier).

"use client";

import * as fcl from "@onflow/fcl";

const APP_IDENTIFIER = "Rip Packs City";
const APP_ICON = "https://www.rippackscity.com/icon.png";

/**
 * Self-custody discovery — Flow Wallet and friends. The default for every path,
 * because only a self-custody wallet can act as the Hybrid-Custody parent.
 */
const SELF_CUSTODY_DISCOVERY = "https://fcl-discovery.onflow.org/authn";

/**
 * Dapper's custodial, restricted discovery. Surfaces the Dapper (Hybrid-Custody
 * CHILD) account, which cannot sign a withdraw. Reserve for flows where a Dapper
 * child genuinely signs — as of 2026-07-29 nothing calls this, which is correct.
 */
const DAPPER_CUSTODIAL_DISCOVERY = "https://accounts.meetdapper.com/fcl/authn-restricted";

/**
 * Wallet services to keep OUT of the Discovery list, by Flow address.
 *
 * NOTE ON "ALLOWLIST": FCL has no allowlist primitive. `discovery.authn.include`
 * only opts IN wallets that Discovery hides by default; it does not restrict the
 * list to its members. Both keys are forwarded verbatim to the Discovery API and
 * filtered server-side (see fcl-core `getServices`), so `discovery.authn.exclude`
 * is the only lever that can actually remove an offered wallet.
 *
 * Empty by default and deliberately so: excluding the wrong address would silently
 * hide a working wallet, and the address of an unwanted service has to be read off
 * the live Discovery list in a browser. Populate via
 * NEXT_PUBLIC_FCL_DISCOVERY_EXCLUDE (comma-separated Flow addresses).
 */
const DEFAULT_DISCOVERY_EXCLUDE: string[] = [];

export type FclIntent =
  /** Connect a wallet to establish identity (account proof). Self-custody. */
  | "sign-in"
  /** Connect a wallet that will SIGN a transaction — the HC parent. Self-custody. */
  | "transact"
  /** Connect the Dapper-custodial child. Only where a Dapper child truly signs. */
  | "dapper-custodial";

function discoveryFor(intent: FclIntent): string {
  const override = process.env.NEXT_PUBLIC_FCL_DISCOVERY_WALLET;
  if (override) return override;
  return intent === "dapper-custodial" ? DAPPER_CUSTODIAL_DISCOVERY : SELF_CUSTODY_DISCOVERY;
}

function discoveryExclude(): string[] {
  const raw = process.env.NEXT_PUBLIC_FCL_DISCOVERY_EXCLUDE;
  if (!raw) return DEFAULT_DISCOVERY_EXCLUDE;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

let baseConfigured = false;
let appliedIntent: FclIntent | null = null;

async function fetchNonce(): Promise<{ appIdentifier: string; nonce: string }> {
  const res = await fetch("/api/auth/fcl-nonce", { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`fcl-nonce HTTP ${res.status}`);
  }
  const data = await res.json();
  if (!data?.nonce) {
    throw new Error("fcl-nonce returned no nonce");
  }
  return { appIdentifier: APP_IDENTIFIER, nonce: data.nonce };
}

/**
 * Configure FCL for a wallet-connect flow. Idempotent per intent: repeat calls with
 * the same intent are a no-op, and switching intent rewrites only the discovery keys.
 *
 * The account-proof resolver is always installed — sign-in needs it, and it costs
 * nothing on the transact path (it is only invoked when a proof is requested).
 */
export function configureFcl(opts?: { intent?: FclIntent }): void {
  const intent = opts?.intent ?? "sign-in";

  if (!baseConfigured) {
    baseConfigured = true;

    const accessNode =
      process.env.NEXT_PUBLIC_FCL_ACCESS_NODE ?? "https://rest-mainnet.onflow.org";

    fcl
      .config()
      .put("flow.network", "mainnet")
      .put("accessNode.api", accessNode)
      .put("app.detail.title", APP_IDENTIFIER)
      .put("app.detail.icon", APP_ICON)
      .put("fcl.accountProof.resolver", fetchNonce);
  }

  if (appliedIntent === intent) return;
  appliedIntent = intent;

  fcl
    .config()
    .put("discovery.wallet", discoveryFor(intent))
    .put("discovery.wallet.method", "POP/RPC")
    .put("discovery.authn.exclude", discoveryExclude());
}

/**
 * Back-compat alias for the account-proof sign-in flow.
 * @deprecated prefer `configureFcl({ intent: "sign-in" })`.
 */
export function configureFclAuth(): void {
  configureFcl({ intent: "sign-in" });
}
