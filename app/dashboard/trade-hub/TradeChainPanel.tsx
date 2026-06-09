// NEXT_STEPS — Renders the on-chain trade lifecycle for a given trade_match.
// Reads trade_chain_state via GET /api/trade-chain/propose?trade_match_id=…
// and drives the four-step Propose → Deposit → Execute → Done progress
// strip. The Sign Deposit flow uses the client-side stub at
// lib/trade-escrow/sign-deposit.ts. Cancel currently logs only — wire to a
// real /api/trade-chain/cancel-callback route once the §3d cancel_trade.cdc
// template is signable on chain. See RPCTradeEscrow_DEPLOYMENT.md §3 / §4.

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { signAndSubmitDeposit } from "@/lib/trade-escrow/sign-deposit";
import {
  COLLECTION_META,
  type ChainTradeStatus,
  type TradeChainState,
  type TradeCollection,
} from "@/lib/trade-escrow/types";

interface Props {
  tradeMatchId: string;
  // The user's currently active wallet address (e.g. from FCL currentUser or
  // the saved_wallets selector). Lower-cased compare against partyA/B.
  connectedAddress: string | null;
  // Nft ids and collection slugs the connected user is expected to deposit,
  // resolved by the parent from the underlying user_trade_offer. Passed in
  // rather than re-derived so this panel stays presentational.
  myDepositIds?: string[];
  myCollection?: TradeCollection;
  // The OTHER party's collection — needed by the §3b deposit script to point
  // at the incoming receiver capability.
  counterpartyCollection?: TradeCollection;
}

type Step = 0 | 1 | 2 | 3;

const STEP_LABELS: Record<Step, string> = {
  0: "Propose",
  1: "Deposit",
  2: "Execute",
  3: "Done",
};

function statusToStep(status: ChainTradeStatus): Step {
  switch (status) {
    case "proposed":
      return 1; // deposit phase current
    case "partial_a":
    case "partial_b":
      return 1; // still in deposit phase
    case "ready":
      return 2; // both deposited, execute current
    case "executed":
      return 3; // done
    case "cancelled":
    case "expired":
    case "failed":
      return 3; // terminal (failed); marker still rests at end
    default:
      return 0;
  }
}

function statusIsTerminal(status: ChainTradeStatus): boolean {
  return status === "executed" || status === "cancelled" || status === "expired" || status === "failed";
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return "expired";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export default function TradeChainPanel({
  tradeMatchId,
  connectedAddress,
  myDepositIds,
  myCollection,
  counterpartyCollection,
}: Props) {
  const [state, setState] = useState<TradeChainState | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [signing, setSigning] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const pollRef = useRef<number | null>(null);

  const reload = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/trade-chain/propose?trade_match_id=${encodeURIComponent(tradeMatchId)}`,
        { credentials: "include" }
      );
      const j = (await res.json()) as { ok?: boolean; state?: TradeChainState | null; error?: string };
      if (!res.ok || j.error) throw new Error(j.error ?? `HTTP ${res.status}`);
      setState(j.state ?? null);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [tradeMatchId]);

  useEffect(() => {
    reload();
  }, [reload]);

  // Tick the countdown once per second so the "<5min" red treatment lands
  // without re-fetching the row. Stops if the state is terminal.
  useEffect(() => {
    if (state && statusIsTerminal(state.status)) return;
    pollRef.current = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
    };
  }, [state]);

  const myAddrLower = connectedAddress?.toLowerCase() ?? null;
  const partyA = state?.partya_address?.toLowerCase() ?? null;
  const partyB = state?.partyb_address?.toLowerCase() ?? null;
  const mySide: "A" | "B" | null = useMemo(() => {
    if (!myAddrLower) return null;
    if (myAddrLower === partyA) return "A";
    if (myAddrLower === partyB) return "B";
    return null;
  }, [myAddrLower, partyA, partyB]);

  const myDepositTxId = useMemo(() => {
    if (!state || !mySide) return null;
    return mySide === "A" ? state.partya_deposit_tx_id : state.partyb_deposit_tx_id;
  }, [state, mySide]);

  const canDeposit = useMemo(() => {
    if (!state || !mySide || myDepositTxId) return false;
    if (state.status === "proposed") return true;
    if (mySide === "A" && state.status === "partial_b") return true;
    if (mySide === "B" && state.status === "partial_a") return true;
    return false;
  }, [state, mySide, myDepositTxId]);

  const canCancel = useMemo(() => {
    if (!state || !mySide) return false;
    return !statusIsTerminal(state.status);
  }, [state, mySide]);

  const expiresAtMs = state ? Date.parse(state.expires_at) : 0;
  const msLeft = expiresAtMs - now;
  const lowOnTime = msLeft > 0 && msLeft < 5 * 60 * 1000;

  async function onSignDeposit() {
    if (!state || !mySide || !connectedAddress) return;
    if (!myDepositIds || myDepositIds.length === 0 || !myCollection || !counterpartyCollection) {
      setError(
        "Missing deposit context (nft ids / collection slugs). Pass myDepositIds, myCollection, counterpartyCollection to TradeChainPanel."
      );
      return;
    }
    setSigning(true);
    setError(null);
    try {
      const r = await signAndSubmitDeposit({
        trade_match_id: tradeMatchId,
        chain_trade_id: state.chain_trade_id ?? 0,
        side: mySide,
        depositor_address: connectedAddress,
        collection: myCollection,
        incoming_collection: counterpartyCollection,
        nft_ids: myDepositIds,
      });
      if (!r.ok) {
        setError(r.error ?? "Deposit submit failed");
      } else if (r.state) {
        setState(r.state as TradeChainState);
      } else {
        await reload();
      }
    } finally {
      setSigning(false);
    }
  }

  function onCancel() {
    // TODO — wire to a real `/api/trade-chain/cancel-callback` route once
    // the §3d cancel_trade.cdc client signing flow is built. For now this
    // is a stub that surfaces intent in the console without mutating the
    // row, matching the rest of the trade-chain stub posture.
    // eslint-disable-next-line no-console
    console.log("[TradeChainPanel:cancel:stub]", {
      trade_match_id: tradeMatchId,
      chain_trade_id: state?.chain_trade_id ?? null,
      mySide,
    });
    setError("Cancel signing not wired yet — see TODO in TradeChainPanel.tsx");
  }

  // Display ---------------------------------------------------------------

  if (state === undefined) {
    return (
      <div className="rpc-card" style={{ padding: 16 }}>
        <span style={{ color: "rgba(255,255,255,0.55)", fontSize: 13 }}>Loading trade state…</span>
      </div>
    );
  }
  if (state === null) {
    return (
      <div className="rpc-card" style={{ padding: 16 }}>
        <p style={{ margin: 0, color: "rgba(255,255,255,0.55)", fontSize: 13 }}>
          No on-chain trade has been proposed for this match yet.
        </p>
        {error && <p style={{ marginTop: 8, color: "var(--rpc-danger, #F87171)", fontSize: 12 }}>{error}</p>}
      </div>
    );
  }

  const currentStep = statusToStep(state.status);
  const isTerminal = statusIsTerminal(state.status);
  const isFailure = state.status === "cancelled" || state.status === "expired" || state.status === "failed";

  return (
    <div className="rpc-card" style={{ padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12, gap: 12 }}>
        <span className="rpc-label" style={{ letterSpacing: "0.2em" }}>On-chain trade</span>
        <span
          style={{
            fontSize: 12,
            fontFamily: "var(--font-mono)",
            color: lowOnTime ? "var(--rpc-danger, #F87171)" : "rgba(255,255,255,0.55)",
          }}
          aria-live="polite"
        >
          {isTerminal ? state.status : `expires in ${formatCountdown(msLeft)}`}
        </span>
      </div>

      <ol
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: 8,
          listStyle: "none",
          padding: 0,
          margin: "0 0 16px",
        }}
      >
        {([0, 1, 2, 3] as Step[]).map((idx) => {
          const completed = idx < currentStep || (idx === 3 && state.status === "executed");
          const current = idx === currentStep && !isTerminal;
          const failedAtThisStep = isFailure && idx === currentStep;
          const bg = completed
            ? "var(--rpc-red, #E03A2F)"
            : current
              ? "rgba(224,58,47,0.18)"
              : failedAtThisStep
                ? "rgba(248,113,113,0.18)"
                : "rgba(255,255,255,0.04)";
          const fg = completed
            ? "#0a0a0a"
            : failedAtThisStep
              ? "var(--rpc-danger, #F87171)"
              : "var(--rpc-text-primary, #F1F1F1)";
          const border = current
            ? "1px solid var(--rpc-red, #E03A2F)"
            : failedAtThisStep
              ? "1px solid var(--rpc-danger, #F87171)"
              : "1px solid var(--rpc-border, rgba(255,255,255,0.12))";
          return (
            <li
              key={idx}
              style={{
                background: bg,
                color: fg,
                border,
                borderRadius: 8,
                padding: "8px 10px",
                textAlign: "center",
                fontFamily: "var(--font-display)",
                textTransform: "uppercase",
                fontSize: 12,
                letterSpacing: "0.06em",
              }}
            >
              {STEP_LABELS[idx]}
            </li>
          );
        })}
      </ol>

      <dl
        style={{
          display: "grid",
          gridTemplateColumns: "auto 1fr",
          gap: "4px 12px",
          margin: 0,
          fontSize: 12,
          fontFamily: "var(--font-mono)",
          color: "rgba(255,255,255,0.65)",
        }}
      >
        <dt style={dtStyle}>status</dt>
        <dd style={ddStyle}>{state.status}</dd>
        <dt style={dtStyle}>chain id</dt>
        <dd style={ddStyle}>{state.chain_trade_id ?? "—"}</dd>
        <dt style={dtStyle}>party A</dt>
        <dd style={ddStyle}>
          {state.partya_address}{" "}
          {state.partya_deposit_tx_id ? <span style={pillStyle}>deposited</span> : null}
          {mySide === "A" && <span style={youPillStyle}>you</span>}
        </dd>
        <dt style={dtStyle}>party B</dt>
        <dd style={ddStyle}>
          {state.partyb_address}{" "}
          {state.partyb_deposit_tx_id ? <span style={pillStyle}>deposited</span> : null}
          {mySide === "B" && <span style={youPillStyle}>you</span>}
        </dd>
        {state.propose_tx_id && (
          <>
            <dt style={dtStyle}>propose tx</dt>
            <dd style={ddStyle}>{state.propose_tx_id}</dd>
          </>
        )}
        {state.execute_tx_id && (
          <>
            <dt style={dtStyle}>execute tx</dt>
            <dd style={ddStyle}>{state.execute_tx_id}</dd>
          </>
        )}
        {state.cancel_tx_id && (
          <>
            <dt style={dtStyle}>cancel tx</dt>
            <dd style={ddStyle}>{state.cancel_tx_id}</dd>
          </>
        )}
        {state.failure_reason && (
          <>
            <dt style={dtStyle}>failure</dt>
            <dd style={{ ...ddStyle, color: "var(--rpc-danger, #F87171)" }}>{state.failure_reason}</dd>
          </>
        )}
      </dl>

      <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
        {canDeposit && (
          <button
            type="button"
            className="rpc-btn-primary"
            onClick={onSignDeposit}
            disabled={signing}
            style={{ minHeight: 44 }}
          >
            {signing ? "Signing…" : `Sign deposit (side ${mySide})`}
          </button>
        )}
        {canCancel && (
          <button
            type="button"
            className="rpc-btn-ghost"
            onClick={onCancel}
            style={{ minHeight: 44 }}
          >
            Cancel trade
          </button>
        )}
        {mySide && myDepositTxId && !isTerminal && (
          <span style={{ alignSelf: "center", color: "rgba(255,255,255,0.55)", fontSize: 12 }}>
            Your deposit is in. Waiting on the other side.
          </span>
        )}
        {!mySide && (
          <span style={{ alignSelf: "center", color: "rgba(255,255,255,0.55)", fontSize: 12 }}>
            Connected wallet is not a party to this trade.
          </span>
        )}
      </div>

      {error && (
        <p
          style={{
            marginTop: 12,
            marginBottom: 0,
            color: "var(--rpc-danger, #F87171)",
            fontSize: 12,
            fontFamily: "var(--font-mono)",
          }}
        >
          {error}
        </p>
      )}

      {/* Surface the resolved collection metadata so dev / QA can sanity
          check the §3b storage paths the deposit stub will eventually use. */}
      {(myCollection || counterpartyCollection) && (
        <p
          style={{
            marginTop: 8,
            marginBottom: 0,
            color: "rgba(255,255,255,0.35)",
            fontSize: 10,
            fontFamily: "var(--font-mono)",
          }}
        >
          {myCollection && `my=${COLLECTION_META[myCollection].storage_path}`}
          {myCollection && counterpartyCollection && "  ·  "}
          {counterpartyCollection && `incoming=${COLLECTION_META[counterpartyCollection].public_path}`}
        </p>
      )}
    </div>
  );
}

const dtStyle: React.CSSProperties = {
  color: "rgba(255,255,255,0.42)",
  textTransform: "uppercase",
  letterSpacing: "0.1em",
  fontSize: 10,
  alignSelf: "center",
};
const ddStyle: React.CSSProperties = {
  margin: 0,
  color: "var(--rpc-text-primary, #F1F1F1)",
  display: "flex",
  alignItems: "center",
  gap: 6,
  flexWrap: "wrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};
const pillStyle: React.CSSProperties = {
  fontFamily: "var(--font-display)",
  fontSize: 10,
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  background: "rgba(52,211,153,0.18)",
  color: "var(--rpc-success, #34D399)",
  border: "1px solid rgba(52,211,153,0.3)",
  borderRadius: 4,
  padding: "1px 6px",
};
const youPillStyle: React.CSSProperties = {
  ...pillStyle,
  background: "var(--rpc-red-bg, rgba(224,58,47,0.08))",
  color: "var(--rpc-red, #E03A2F)",
  border: "1px solid var(--rpc-red-border, rgba(224,58,47,0.3))",
};
