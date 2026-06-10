"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

// Friendly state for /share/<wallet> when the snapshot is empty (wallet not
// indexed yet / holds nothing / bad input).
//
// When the path param is a valid Flow address we treat "no snapshot yet" as
// "not indexed yet" and turn the old dead-end into a live flow: queue the
// wallet for indexing via the public /api/public/queue-wallet endpoint, show an
// "Analyzing…" state, and poll /api/collection-snapshot until moments appear —
// then reload into the real card. If indexing turns up nothing within the
// budget, fall back to the retry box (a Flow address goes straight through; a
// username is resolved via the public /api/wallet-search). (2026-06-09 funnel.)

const FLOW_ADDRESS = /^0x[0-9a-fA-F]{16}$/;

const POLL_INTERVAL_MS = 8_000;
const POLL_MAX_ATTEMPTS = 10; // ~80s of indexing budget

type Mode = "analyzing" | "retry";

export default function ShareEmptyState({ wallet }: { wallet: string }) {
  const router = useRouter();
  const isAddress = FLOW_ADDRESS.test(wallet);

  const [mode, setMode] = useState<Mode>(isAddress ? "analyzing" : "retry");
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startedRef = useRef(false);

  // Kick off indexing + poll for results when we land on a valid-but-empty
  // address. Runs once per mount.
  useEffect(() => {
    if (!isAddress || startedRef.current) return;
    startedRef.current = true;

    let cancelled = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      if (cancelled) return;
      attempts += 1;
      try {
        const res = await fetch(
          `/api/collection-snapshot?wallet=${encodeURIComponent(wallet)}&_=${attempts}`,
          { cache: "no-store" }
        );
        if (!cancelled && res.ok) {
          const data = await res.json().catch(() => null);
          if (data && Number(data.totalMoments) > 0) {
            // Indexed — reload into the real card. The page reads the snapshot
            // with no-store, so the reload renders fresh.
            router.refresh();
            window.location.reload();
            return;
          }
        }
      } catch {
        // ignore — keep polling until the budget runs out
      }
      if (cancelled) return;
      if (attempts >= POLL_MAX_ATTEMPTS) {
        setMode("retry");
        return;
      }
      timer = setTimeout(poll, POLL_INTERVAL_MS);
    };

    // Fire the queue request, then start polling regardless of its outcome
    // (the wallet may already be mid-index from another path).
    fetch("/api/public/queue-wallet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet }),
    }).catch(() => {});

    timer = setTimeout(poll, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [isAddress, wallet, router]);

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

  const wrap: React.CSSProperties = {
    minHeight: "100vh",
    background: "var(--rpc-black)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "var(--rpc-text-primary)",
    fontFamily: "var(--font-display)",
    padding: "24px",
  };

  // ── Analyzing state ──────────────────────────────────────────────────────
  if (mode === "analyzing") {
    return (
      <div style={wrap}>
        <div style={{ textAlign: "center", maxWidth: 460, width: "100%" }}>
          <div
            style={{
              fontSize: 40,
              fontWeight: 900,
              color: "var(--rpc-red, #E03A2F)",
              letterSpacing: "0.08em",
              marginBottom: 16,
            }}
          >
            RPC
          </div>
          <div
            className="rpc-share-spinner"
            style={{
              width: 40,
              height: 40,
              margin: "0 auto 20px",
              borderRadius: "50%",
              border: "3px solid var(--rpc-border)",
              borderTopColor: "var(--rpc-red, #E03A2F)",
            }}
            aria-hidden
          />
          <div style={{ fontSize: 20, color: "var(--rpc-text-primary)", marginBottom: 8 }}>
            Analyzing your wallet&hellip;
          </div>
          <div style={{ fontSize: 14, color: "var(--rpc-text-secondary)", marginBottom: 16 }}>
            First look usually takes 30&ndash;60 seconds. Hang tight &mdash; this page
            refreshes itself when it&rsquo;s ready.
          </div>
          <div
            style={{
              fontSize: 13,
              color: "var(--rpc-text-muted)",
              fontFamily: "monospace",
              wordBreak: "break-all",
            }}
          >
            {wallet}
          </div>
          <style>{`@keyframes rpc-share-spin{to{transform:rotate(360deg)}}.rpc-share-spinner{animation:rpc-share-spin 0.9s linear infinite}@media (prefers-reduced-motion: reduce){.rpc-share-spinner{animation-duration:2.4s}}`}</style>
        </div>
      </div>
    );
  }

  // ── Retry state ──────────────────────────────────────────────────────────
  return (
    <div style={wrap}>
      <div style={{ textAlign: "center", maxWidth: 460, width: "100%" }}>
        <div
          style={{
            fontSize: 40,
            fontWeight: 900,
            color: "var(--rpc-red, #E03A2F)",
            letterSpacing: "0.08em",
            marginBottom: 12,
          }}
        >
          RPC
        </div>
        <div style={{ fontSize: 20, color: "var(--rpc-text-primary)", marginBottom: 8 }}>
          {isAddress
            ? "We couldn’t find any moments for this wallet yet"
            : "We haven’t indexed this wallet yet"}
        </div>
        <div
          style={{
            fontSize: 13,
            color: "#777",
            fontFamily: "monospace",
            marginBottom: 24,
            wordBreak: "break-all",
          }}
        >
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
            background: "var(--rpc-surface)",
            border: "1px solid var(--rpc-border)",
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
              color: "var(--rpc-text-primary)",
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
              // brand-exception: white label on the red button — theme-independent
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
          <div
            role="alert"
            style={{ marginTop: 12, fontFamily: "monospace", fontSize: 12, color: "var(--rpc-red, #E03A2F)" }}
          >
            {error}
          </div>
        ) : null}

        <div style={{ marginTop: 28, fontSize: 13, color: "var(--rpc-text-secondary)" }}>
          Or explore the{" "}
          <a
            href="/insights"
            style={{ color: "var(--rpc-red, #E03A2F)", textDecoration: "none", fontWeight: 700 }}
          >
            free public insights →
          </a>
        </div>
      </div>
    </div>
  );
}
