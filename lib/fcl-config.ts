// lib/fcl-config.ts
//
// Browser-side FCL configuration with an account-proof resolver pointed at
// /api/auth/fcl-nonce. Calling configureFclAuth() is idempotent — it can be
// invoked any number of times (e.g. once per SignInWithDapper render).
//
// We intentionally keep this separate from lib/flow.ts: that module
// preconfigures FCL for cart/transaction signing without an account-proof
// resolver. The auth flow needs a resolver that mints server-issued nonces,
// which would otherwise force an unnecessary network round-trip during
// non-auth FCL usage.

"use client";

import * as fcl from "@onflow/fcl";

const APP_IDENTIFIER = "Rip Packs City";
const APP_ICON = "https://rip-packs-city.vercel.app/icon.png";
const FALLBACK_DISCOVERY = "https://fcl-discovery.onflow.org/authn";

let configured = false;

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

export function configureFclAuth(): void {
  if (configured) return;
  configured = true;

  const accessNode =
    process.env.NEXT_PUBLIC_FCL_ACCESS_NODE ?? "https://rest-mainnet.onflow.org";
  const discovery =
    process.env.NEXT_PUBLIC_FCL_DISCOVERY_WALLET ?? FALLBACK_DISCOVERY;

  fcl
    .config()
    .put("flow.network", "mainnet")
    .put("accessNode.api", accessNode)
    .put("discovery.wallet", discovery)
    .put("discovery.wallet.method", "POP/RPC")
    .put("app.detail.title", APP_IDENTIFIER)
    .put("app.detail.icon", APP_ICON)
    .put("fcl.accountProof.resolver", fetchNonce);
}
