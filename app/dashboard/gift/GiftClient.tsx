"use client";

// Phase 1 parent-signed gifting UI.
// Connect the parent (self-custody) wallet -> discover its Hybrid-Custody
// children live on-chain -> pick a moment (by NFT id) + recipient -> preview
// (server-verified) -> sign a SINGLE-signer transaction with the parent wallet.
// No Dapper co-signer (see docs/design/parent-signed-gifting-fcl-flow-2026-07-13.md).

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import * as fcl from "@onflow/fcl";
import { initFcl, initFclSelfCustody } from "@/lib/flow";
import { GIFT_MOMENT_CADENCE, GIFT_MOMENT_GAS_LIMIT } from "@/lib/chains/flow/cadence/gift-moment";

const DISPLAY = "var(--font-display)";
const MONO = "var(--font-mono)";
const RED = "var(--rpc-red)";

interface QuoteSummary {
  momentTitle: string;
  setName: string | null;
  serial: number | null;
  tier: string | null;
  imageUrl: string | null;
  recipientLabel: string | null;
  recipientAddr: string;
}
interface QuoteOk {
  ok: true;
  recipientReady: boolean;
  args: { childAddress: string; providerControllerID: number; momentId: string; recipient: string };
  summary: QuoteSummary;
}
interface QuoteFail {
  ok: false;
  reason?: string;
  recipientReady?: boolean;
  summary?: QuoteSummary;
  error?: string;
}

const REASON_COPY: Record<string, string> = {
  no_manager: "This wallet has no linked Top Shot accounts.",
  not_your_link: "This wallet isn't the parent of that account.",
  withdraw_not_permitted: "Dapper's account-link filter doesn't allow withdrawing Top Shot moments from this account.",
  moment_not_owned: "That linked account doesn't own this moment.",
  recipient_needs_setup: "The recipient needs to set up a Top Shot collection before they can receive a moment.",
  unknown_recipient: "Couldn't resolve that recipient — enter a Flow address (0x…) or a known username.",
  recipient_is_sender: "The recipient is the same account you're sending from.",
};

export default function GiftClient() {
  const [addr, setAddr] = useState<string | null>(null);
  const [children, setChildren] = useState<string[] | null>(null);
  const [childrenErr, setChildrenErr] = useState<string | null>(null);
  const [selectedChild, setSelectedChild] = useState<string>("");

  const [momentId, setMomentId] = useState("");
  const [recipient, setRecipient] = useState("");

  const [quote, setQuote] = useState<QuoteOk | QuoteFail | null>(null);
  const [quoting, setQuoting] = useState(false);

  const [txId, setTxId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<"sealed" | "failed" | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  useEffect(() => {
    initFcl();
    const unsub = fcl.currentUser.subscribe((u: any) => setAddr(u?.loggedIn ? (u.addr ?? null) : null));
    return unsub;
  }, []);

  // Discover linked children whenever the connected wallet changes.
  useEffect(() => {
    if (!addr) {
      setChildren(null);
      setSelectedChild("");
      return;
    }
    let cancelled = false;
    setChildren(null);
    setChildrenErr(null);
    (async () => {
      try {
        const r = await fetch("/api/gift/children", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ parentAddress: addr }),
        });
        const j = await r.json();
        if (cancelled) return;
        if (!j.ok) {
          setChildrenErr(j.error ?? "lookup_failed");
          setChildren([]);
          return;
        }
        setChildren(j.children ?? []);
        if ((j.children ?? []).length === 1) setSelectedChild(j.children[0]);
      } catch {
        if (!cancelled) {
          setChildrenErr("lookup_failed");
          setChildren([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [addr]);

  const resetTx = () => {
    setTxId(null);
    setResult(null);
    setErrMsg(null);
  };

  const doQuote = useCallback(async () => {
    if (!addr || !selectedChild || !momentId.trim() || !recipient.trim()) return;
    setQuoting(true);
    setQuote(null);
    resetTx();
    try {
      const r = await fetch("/api/gift/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          parentAddress: addr,
          childAddress: selectedChild,
          momentId: momentId.trim(),
          recipient: recipient.trim(),
        }),
      });
      const j = await r.json();
      setQuote(j);
    } catch {
      setQuote({ ok: false, error: "quote_failed" });
    } finally {
      setQuoting(false);
    }
  }, [addr, selectedChild, momentId, recipient]);

  const record = useCallback(
    async (payload: Record<string, unknown>) => {
      try {
        await fetch("/api/gift/record", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      } catch {
        /* analytics only — never blocks the gift */
      }
    },
    [],
  );

  const sendGift = useCallback(async () => {
    if (!quote || !quote.ok || !addr) return;
    const { args, summary } = quote;
    setSending(true);
    resetTx();
    try {
      const id: string = await (fcl.mutate as any)({
        cadence: GIFT_MOMENT_CADENCE,
        args: (arg: typeof fcl.arg, t: typeof fcl.t) => [
          arg(args.childAddress, t.Address),
          arg(String(args.providerControllerID), t.UInt64),
          arg(String(args.momentId), t.UInt64),
          arg(args.recipient, t.Address),
        ],
        proposer: fcl.authz,
        payer: fcl.authz,
        authorizations: [fcl.authz],
        limit: GIFT_MOMENT_GAS_LIMIT,
      });
      setTxId(id);
      void record({
        txId: id,
        parentAddress: addr,
        childAddress: args.childAddress,
        momentId: args.momentId,
        recipient: args.recipient,
        recipientLabel: summary.recipientLabel,
        momentTitle: summary.momentTitle,
        serial: summary.serial,
        status: "submitted",
      });
      const sealed: any = await fcl.tx(id).onceSealed();
      if (sealed?.errorMessage) {
        setResult("failed");
        setErrMsg(sealed.errorMessage);
        void record({ txId: id, parentAddress: addr, childAddress: args.childAddress, momentId: args.momentId, recipient: args.recipient, status: "failed", error: sealed.errorMessage });
      } else {
        setResult("sealed");
        void record({ txId: id, parentAddress: addr, childAddress: args.childAddress, momentId: args.momentId, recipient: args.recipient, status: "sealed" });
      }
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      setResult("failed");
      setErrMsg(/declin|reject|cancel/i.test(msg) ? "Gift cancelled." : msg);
    } finally {
      setSending(false);
    }
  }, [quote, addr, record]);

  const card: React.CSSProperties = {
    border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: 10,
    padding: "1rem 1.15rem",
    background: "rgba(255,255,255,0.03)",
  };
  const label: React.CSSProperties = { fontFamily: MONO, fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase", opacity: 0.6, display: "block", marginBottom: 6 };
  const input: React.CSSProperties = {
    width: "100%", padding: "0.6rem 0.7rem", borderRadius: 8, border: "1px solid rgba(255,255,255,0.15)",
    background: "rgba(0,0,0,0.3)", color: "inherit", fontFamily: MONO, fontSize: 14,
  };
  const btn = (primary = false): React.CSSProperties => ({
    padding: "0.6rem 1.1rem", borderRadius: 8, fontFamily: DISPLAY, fontWeight: 700, letterSpacing: "0.03em",
    textTransform: "uppercase", fontSize: 14, cursor: "pointer", border: `1px solid ${primary ? RED : "rgba(255,255,255,0.2)"}`,
    background: primary ? RED : "transparent", color: primary ? "#fff" : "inherit",
  });

  return (
    <div style={{ maxWidth: 640, margin: "0 auto", padding: "1.5rem 1rem 4rem", fontFamily: "var(--font-body, sans-serif)" }}>
      <div style={{ marginBottom: "0.35rem" }}>
        <Link href="/dashboard" style={{ fontFamily: MONO, fontSize: 12, opacity: 0.6, textDecoration: "none", color: "inherit" }}>← Dashboard</Link>
      </div>
      <h1 style={{ fontFamily: DISPLAY, fontSize: 30, fontWeight: 800, letterSpacing: "0.02em", margin: "0 0 0.25rem" }}>GIFT A MOMENT</h1>
      <p style={{ opacity: 0.7, fontSize: 14, margin: "0 0 1.25rem", lineHeight: 1.5 }}>
        Send a Top Shot moment out of your linked account to any Dapper or Flow wallet. You sign once with your own wallet — no Dapper co-signer.
      </p>

      {/* Step 1 — connect */}
      <div style={{ ...card, marginBottom: "1rem" }}>
        <span style={label}>1 · Your wallet (the parent)</span>
        {addr ? (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <code style={{ fontFamily: MONO, fontSize: 14 }}>{addr}</code>
            <button style={btn()} onClick={() => fcl.unauthenticate()}>Disconnect</button>
          </div>
        ) : (
          <button style={btn(true)} onClick={() => { initFclSelfCustody(); fcl.authenticate(); }}>Connect wallet</button>
        )}
      </div>

      {/* Step 2 — linked child */}
      {addr && (
        <div style={{ ...card, marginBottom: "1rem" }}>
          <span style={label}>2 · Send from linked account</span>
          {children === null ? (
            <span style={{ opacity: 0.6, fontSize: 13 }}>Reading your linked accounts on-chain…</span>
          ) : children.length === 0 ? (
            <span style={{ opacity: 0.75, fontSize: 13 }}>
              {childrenErr ? "Couldn't read linked accounts — try again." : "No Hybrid-Custody child accounts are linked to this wallet."}
            </span>
          ) : (
            <select style={{ ...input, fontFamily: MONO }} value={selectedChild} onChange={(e) => { setSelectedChild(e.target.value); setQuote(null); resetTx(); }}>
              <option value="">Select a linked account…</option>
              {children.map((c) => (<option key={c} value={c}>{c}</option>))}
            </select>
          )}
        </div>
      )}

      {/* Step 3 — moment + recipient */}
      {addr && selectedChild && (
        <div style={{ ...card, marginBottom: "1rem" }}>
          <span style={label}>3 · Moment & recipient</span>
          <div style={{ marginBottom: 12 }}>
            <span style={label}>Moment NFT id</span>
            <input style={input} inputMode="numeric" placeholder="e.g. 51492551" value={momentId}
              onChange={(e) => { setMomentId(e.target.value.replace(/[^\d]/g, "")); setQuote(null); resetTx(); }} />
          </div>
          <div>
            <span style={label}>Recipient (Flow address or username)</span>
            <input style={input} placeholder="0x… or @username" value={recipient}
              onChange={(e) => { setRecipient(e.target.value); setQuote(null); resetTx(); }} />
          </div>
          <div style={{ marginTop: 14 }}>
            <button style={btn()} disabled={quoting || !momentId || !recipient} onClick={doQuote}>
              {quoting ? "Checking…" : "Preview gift"}
            </button>
          </div>
        </div>
      )}

      {/* Preview / errors */}
      {quote && !quote.ok && (
        <div style={{ ...card, marginBottom: "1rem", borderColor: "rgba(224,58,47,0.5)" }}>
          <span style={{ color: RED, fontFamily: DISPLAY, fontWeight: 700 }}>Can't send</span>
          <p style={{ margin: "6px 0 0", fontSize: 14, opacity: 0.85 }}>
            {REASON_COPY[(quote as QuoteFail).reason ?? ""] ?? (quote as QuoteFail).error ?? "Preflight failed."}
          </p>
        </div>
      )}

      {quote && quote.ok && (
        <div style={{ ...card, marginBottom: "1rem" }}>
          <span style={label}>Confirm</span>
          <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
            {quote.summary.imageUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={quote.summary.imageUrl} alt={quote.summary.momentTitle} width={64} height={64}
                style={{ borderRadius: 8, objectFit: "cover", flex: "0 0 auto" }} />
            )}
            <div style={{ fontSize: 14, lineHeight: 1.5 }}>
              <strong style={{ fontFamily: DISPLAY, fontSize: 16 }}>{quote.summary.momentTitle}</strong><br />
              <span style={{ opacity: 0.75 }}>
                {[quote.summary.setName, quote.summary.tier, quote.summary.serial ? `#${quote.summary.serial}` : null].filter(Boolean).join(" · ")}
              </span><br />
              <span style={{ opacity: 0.9 }}>→ {quote.summary.recipientLabel ? `@${quote.summary.recipientLabel}` : ""} <code style={{ fontFamily: MONO, fontSize: 12 }}>{quote.summary.recipientAddr}</code></span>
            </div>
          </div>
          <div style={{ marginTop: 16, display: "flex", gap: 10, alignItems: "center" }}>
            <button style={btn(true)} disabled={sending || result === "sealed"} onClick={sendGift}>
              {sending ? "Awaiting signature…" : result === "sealed" ? "Sent ✓" : "Send gift"}
            </button>
            {txId && (
              <a href={`https://www.flowscan.io/tx/${txId}`} target="_blank" rel="noreferrer"
                style={{ fontFamily: MONO, fontSize: 12, opacity: 0.7, color: "inherit" }}>view tx ↗</a>
            )}
          </div>
          {result === "sealed" && (
            <p style={{ margin: "12px 0 0", color: "#34d399", fontSize: 14 }}>Gift delivered — the moment is now in the recipient's collection.</p>
          )}
          {result === "failed" && errMsg && (
            <p style={{ margin: "12px 0 0", color: RED, fontSize: 13 }}>{errMsg}</p>
          )}
        </div>
      )}

      <p style={{ opacity: 0.45, fontSize: 12, marginTop: "1.5rem", lineHeight: 1.5 }}>
        Gas is paid by your connected wallet. RPC never holds your keys — the transfer only happens when you approve it in your wallet.
      </p>
    </div>
  );
}
