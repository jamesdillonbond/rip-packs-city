// components/SignInWithDapper.tsx
//
// Primary auth CTA on /profile. Walks the user through:
//   1. fcl.authenticate() against the configured Dapper discovery URL
//   2. POST /api/auth/fcl-verify with the returned account proof
//   3. Either (a) link the wallet to the existing Supabase session, or
//      (b) redeem the magic-link token via supabase.auth.verifyOtp to mint
//      a brand-new session.
//
// On success we also stash the verified addr in localStorage as the new
// `rpc_owner_key` replacement so the rest of the app (sniper, share, etc.)
// can pick it up immediately without a page reload.

"use client";

import { useCallback, useState } from "react";
import * as fcl from "@onflow/fcl";
import { configureFclAuth } from "@/lib/fcl-config";
import { getSupabaseBrowser } from "@/lib/auth/supabase-client";

const condensedFont = "'Barlow Condensed', sans-serif";
const monoFont = "'Share Tech Mono', monospace";

interface Props {
  onSuccess?: (addr: string) => void;
  className?: string;
  variant?: "primary" | "secondary";
}

export default function SignInWithDapper({ onSuccess, className, variant = "primary" }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      configureFclAuth();
      const user: any = await fcl.authenticate();
      const addr: string | undefined = user?.addr;
      if (!addr) throw new Error("Wallet did not return an address");

      const proofService = (user.services ?? []).find(
        (s: any) => s?.type === "account-proof" || s?.f_type === "AccountProofService"
      );
      const data = proofService?.data;
      if (!data?.signatures || !data?.nonce) {
        throw new Error("No account proof returned by wallet");
      }

      const res = await fetch("/api/auth/fcl-verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          addr,
          accountProof: {
            address: addr,
            nonce: data.nonce,
            signatures: data.signatures,
          },
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json?.error ?? `HTTP ${res.status}`);
      }

      if (json.mode === "minted" && json.tokenHash && json.email) {
        const supabase = getSupabaseBrowser();
        const { error: otpErr } = await supabase.auth.verifyOtp({
          token_hash: json.tokenHash,
          type: "magiclink",
        } as any);
        if (otpErr) throw new Error(otpErr.message);
      }

      try {
        localStorage.setItem("rpc_owner_key", addr);
      } catch {
        // localStorage can be blocked in private mode — non-fatal.
      }

      onSuccess?.(addr);
      // Hard reload so server-rendered profile data picks up the new session.
      window.location.reload();
    } catch (e: any) {
      setError(e?.message ?? "Sign-in failed");
      try {
        await fcl.unauthenticate();
      } catch {
        // ignore
      }
    } finally {
      setLoading(false);
    }
  }, [onSuccess]);

  const baseStyle: React.CSSProperties = {
    border: "none",
    padding: variant === "primary" ? "14px 28px" : "10px 18px",
    borderRadius: 8,
    fontFamily: condensedFont,
    fontWeight: 800,
    fontSize: variant === "primary" ? 15 : 12,
    letterSpacing: "0.1em",
    textTransform: "uppercase",
    cursor: loading ? "default" : "pointer",
    opacity: loading ? 0.7 : 1,
    background: "linear-gradient(135deg, #16C2A3 0%, #0EA5E9 100%)",
    color: "#0a0a0a",
    boxShadow: "0 0 24px rgba(22,194,163,0.45)",
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
  };

  return (
    <div className={className}>
      <button onClick={run} disabled={loading} style={baseStyle}>
        <span aria-hidden style={{ fontSize: variant === "primary" ? 18 : 14 }}>
          {"\u{1F510}"}
        </span>
        {loading ? "Signing in…" : "Sign in with Dapper"}
      </button>
      {error && (
        <div style={{ color: "#F87171", fontFamily: monoFont, fontSize: 11, marginTop: 8 }}>
          {error}
        </div>
      )}
    </div>
  );
}
