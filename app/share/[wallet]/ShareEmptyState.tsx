"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";

// Friendly empty state for /share/<wallet> when the snapshot can't be built
// (wallet not indexed yet / bad input). Replaces the bare "Collection not
// found" dead-end with a retry input (Flow address → straight through; a
// username → resolved via the public /api/wallet-search) plus a link to the
// free /insights surfaces, so an anon arrival isn't a terminal page.
// (2026-05-31, handoff B4.)

const FLOW_ADDRESS = /^0x[0-9a-fA-F]{16}$/;

export default function ShareEmptyState({ wallet }: { wallet: string }) {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    const raw = value.trim();
    if (!raw || pending) return;
    setError(null);
    if (FLOW_ADDRESS.test(raw)) {
      router.push(`/share/${encodeURIComponent(raw)}`);
      return;
    }
    setPending(true);
    try {
      const res = await fetch("/api/wallet-search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: raw, limit: 1 }),
      });
      const data = await res.json().catch(() => null);
      const addr: string | undefined = data?.walletAddress;
      if (addr && FLOW_ADDRESS.test(addr)) {
        router.push(`/share/${encodeURIComponent(addr)}`);
        return;
      }
      setError(data?.error || "Couldn't find that. Try a Flow wallet address (0x…).");
    } catch {
      setError("Something went wrong. Try again in a moment.");
    } finally {
      setPending(false);
    }
  }, [router, value, pending]);

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#0A0A0A",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "#fff",
        fontFamily: "var(--font-display)",
        padding: "24px",
      }}
    >
      <div style={{ textAlign: "center", maxWidth: 460, width: "100%" }}>
        <div style={{ fontSize: 40, fontWeight: 900, color: "var(--rpc-red, #E03A2F)", letterSpacing: "0.08em", marginBottom: 12 }}>
          RPC
        </div>
        <div style={{ fontSize: 20, color: "#ddd", marginBottom: 8 }}>We haven&rsquo;t indexed this wallet yet</div>
        <div style={{ fontSize: 13, color: "#777", fontFamily: "monospace", marginBottom: 24, wordBreak: "break-all" }}>
          {wallet}
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          style={{
            display: "flex",
            alignItems: "stretch",
            background: "#111",
            border: "1px solid #2a2a2a",
            borderRadius: 10,
            overflow: "hidden",
            height: 52,
          }}
        >
          <input
            aria-label="Try another Top Shot username or Flow wallet"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Try another username or wallet (0x…)"
            style={{
              flex: 1,
              minWidth: 0,
              padding: "0 16px",
              background: "transparent",
              border: "none",
              outline: "none",
              color: "#fff",
              fontFamily: "monospace",
              fontSize: 14,
            }}
          />
          <button
            type="submit"
            disabled={pending}
            style={{
              background: "var(--rpc-red, #E03A2F)",
              border: "none",
              color: "#fff",
              padding: "0 20px",
              fontFamily: "monospace",
              fontWeight: 700,
              fontSize: 12,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              cursor: pending ? "wait" : "pointer",
              opacity: pending ? 0.7 : 1,
              whiteSpace: "nowrap",
            }}
          >
            {pending ? "…" : "GO →"}
          </button>
        </form>

        {error ? (
          <div role="alert" style={{ marginTop: 12, fontFamily: "monospace", fontSize: 12, color: "var(--rpc-red, #E03A2F)" }}>
            {error}
          </div>
        ) : null}

        <div style={{ marginTop: 28, fontSize: 13, color: "#888" }}>
          Or explore the{" "}
          <a href="/insights" style={{ color: "var(--rpc-red, #E03A2F)", textDecoration: "none", fontWeight: 700 }}>
            free public insights →
          </a>
        </div>
      </div>
    </div>
  );
}
