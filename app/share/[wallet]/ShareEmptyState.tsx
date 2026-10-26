"use client";

import Link from "next/link"
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { accentText } from "@/lib/accent-text";

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

// ⚠ AT MOST TWO AUTOMATIC RELOADS per wallet per 10 minutes (2026-10-22). Each reload remounts this
// component and restarts the poll with its counter at 0, so a page that keeps rendering empty after
// the poll saw moments (a cached empty snapshot) reloaded forever — 36 times in 6 minutes for one
// visitor. Past the cap the reader gets a button instead of another reload.
const MAX_AUTO_RELOADS = 2;
const RELOAD_WINDOW_MS = 10 * 60_000;

/** Records one automatic reload; false when the cap is already spent, or when storage is unavailable (no count = no loop). */
export function claimAutoReload(wallet: string, now: number = Date.now()): boolean {
  const key = `rpc_share_reloads:${wallet.toLowerCase()}`;
  try {
    const raw = window.sessionStorage.getItem(key);
    const prior = (raw ? (JSON.parse(raw) as unknown) : []) as unknown;
    const recent = Array.isArray(prior) ? prior.filter((t): t is number => typeof t === "number" && now - t < RELOAD_WINDOW_MS) : [];
    if (recent.length >= MAX_AUTO_RELOADS) return false;
    window.sessionStorage.setItem(key, JSON.stringify([...recent, now]));
    return true;
  } catch {
    // No storage (private mode / blocked): we cannot count, so never loop — allow nothing automatic.
    return false;
  }
}

type Mode = "analyzing" | "ready" | "retry";

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
            // Indexed — reload into the real card, unless this tab already reloaded twice and still
            // landed here (then the reader gets a button, never an endless loop).
            if (claimAutoReload(wallet)) {
              router.refresh();
              window.location.reload();
            } else {
              setMode("ready");
            }
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
      // ⚠ Same defect as components/WalletSearch.tsx: without a status check a
      // failed search fell through to the not-found copy, which claims the
      // wallet does not exist and tells the reader to change their input.
      if (!res.ok) {
        // A 404 username_not_found IS an answer about the handle (the route
        // sends it only when Top Shot confirmed no such user); every other
        // non-2xx is us failing to look.
        let code: unknown = null;
        try { code = (await res.json())?.code; } catch { /* no body: stays a failure */ }
        setError(
          res.status === 404 && code === "username_not_found"
            ? "Couldn't find that Top Shot username. Check the spelling, or enter the wallet address."
            : "Couldn't search just now — this says nothing about that wallet. Try again shortly.",
        );
        return;
      }
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
              color: "var(--rpc-red-text)",
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

  // ── Ready state (the poll saw moments, but auto-reload is spent) ────────────
  if (mode === "ready") {
    return (
      <div style={wrap}>
        <div style={{ textAlign: "center", maxWidth: 460, width: "100%" }}>
          <div style={{ fontSize: 20, color: "var(--rpc-text-primary)", marginBottom: 12 }}>
            Your card is ready.
          </div>
          <button
            type="button"
            data-testid="share-ready-reload"
            onClick={() => window.location.reload()}
            style={{ padding: "10px 18px", border: "1px solid var(--rpc-red-border)", color: "var(--rpc-red-text)", background: "transparent", fontFamily: "var(--font-mono)", letterSpacing: "0.2em", textTransform: "uppercase", fontSize: 12, cursor: "pointer" }}
          >
            Show my card
          </button>
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
            color: "var(--rpc-red-text)",
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
            color: accentText("#777"),
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
            style={{ marginTop: 12, fontFamily: "monospace", fontSize: 12, color: "var(--rpc-red-text)" }}
          >
            {error}
          </div>
        ) : null}

        <div style={{ marginTop: 28, fontSize: 13, color: "var(--rpc-text-secondary)" }}>
          Or explore the{" "}
          <Link
            href="/insights"
            style={{ color: "var(--rpc-red-text)", textDecoration: "none", fontWeight: 700 }}
          >
            free public insights →
          </Link>
        </div>
      </div>
    </div>
  );
}
