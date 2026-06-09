"use client";

// app/dashboard/api-keys/page.tsx
//
// Self-serve MCP API key management. Mobile-first, §0-strict — every
// color is a var(--rpc-*) token, every font is var(--font-*). No
// hardcoded hex literals, no inline display-font name strings. Class
// families (.rpc-card, .rpc-btn-primary, .rpc-btn-ghost, .rpc-label,
// .rpc-mono) are preferred over duplicated inline styles.
//
// Wired against /api/mcp/keys which reuses the canonical
// get_user_saved_wallets(p_user_id) resolver — the same session→wallet
// path that /api/profile/cost-basis-summary and /api/profile/verify-challenge
// use. No new auth flow.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import MobileNav from "@/components/MobileNav";
import SupportChatConnected from "@/components/SupportChatConnected";

interface ApiKey {
  key_id: string;
  key_prefix: string;
  label: string | null;
  plan: string;
  status: string;
  scopes: string[];
  created_at: string | null;
  last_used_at: string | null;
  expires_at: string | null;
  wallet_address: string;
}

interface CreatedKey {
  key_id: string;
  raw_key: string;
  key_prefix: string;
  wallet_address: string;
  label: string | null;
}

function humanizeRelative(iso: string | null): string {
  if (!iso) return "Never";
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return "Just now";
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function truncateWallet(addr: string): string {
  if (!addr || addr.length < 10) return addr || "";
  return addr.slice(0, 6) + "…" + addr.slice(-4);
}

export default function ApiKeysPage() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [labelInput, setLabelInput] = useState("");
  const [issuing, setIssuing] = useState(false);
  const [issueError, setIssueError] = useState<string | null>(null);
  const [createdKey, setCreatedKey] = useState<CreatedKey | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied">("idle");

  const [toast, setToast] = useState<{ text: string; tone: "ok" | "err" } | null>(null);

  const pushToast = useCallback((text: string, tone: "ok" | "err" = "ok") => {
    setToast({ text, tone });
    setTimeout(() => setToast(null), 4500);
  }, []);

  const loadKeys = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch("/api/mcp/keys", { cache: "no-store" });
      if (res.status === 401) {
        setLoadError("Please sign in to manage API keys.");
        setKeys([]);
        return;
      }
      const json = (await res.json()) as { ok?: boolean; keys?: ApiKey[]; error?: string };
      if (!res.ok || !json.ok) {
        setLoadError(json.error || `Failed to load keys (HTTP ${res.status}).`);
        setKeys([]);
        return;
      }
      setKeys(json.keys ?? []);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load keys.");
      setKeys([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadKeys();
  }, [loadKeys]);

  const openCreate = useCallback(() => {
    setLabelInput("");
    setIssueError(null);
    setCreatedKey(null);
    setCopyState("idle");
    setModalOpen(true);
  }, []);

  const closeModal = useCallback(() => {
    setModalOpen(false);
    setCreatedKey(null);
    setCopyState("idle");
    setIssueError(null);
    // Reload the list so a newly-created key appears with its (now-prefix-only) row.
    if (createdKey) loadKeys();
  }, [createdKey, loadKeys]);

  const handleGenerate = useCallback(async () => {
    setIssuing(true);
    setIssueError(null);
    try {
      const res = await fetch("/api/mcp/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: labelInput.trim() || undefined }),
      });
      const json = (await res.json()) as Partial<CreatedKey> & { error?: string; message?: string };
      if (!res.ok) {
        setIssueError(json.message || json.error || `Failed (HTTP ${res.status}).`);
        return;
      }
      if (!json.raw_key || !json.key_id || !json.key_prefix || !json.wallet_address) {
        setIssueError("Issuance returned an incomplete response.");
        return;
      }
      setCreatedKey({
        key_id: json.key_id,
        raw_key: json.raw_key,
        key_prefix: json.key_prefix,
        wallet_address: json.wallet_address,
        label: json.label ?? null,
      });
    } catch (err) {
      setIssueError(err instanceof Error ? err.message : "Network error.");
    } finally {
      setIssuing(false);
    }
  }, [labelInput]);

  const handleCopy = useCallback(async () => {
    if (!createdKey) return;
    try {
      await navigator.clipboard.writeText(createdKey.raw_key);
      setCopyState("copied");
      setTimeout(() => setCopyState("idle"), 2500);
    } catch {
      pushToast("Copy failed — select the text manually.", "err");
    }
  }, [createdKey, pushToast]);

  const handleRevoke = useCallback(
    async (keyId: string, keyPrefix: string) => {
      const confirmed = window.confirm(
        `Revoke key ${keyPrefix}? This cannot be undone — any agent using this key will start receiving 401.`
      );
      if (!confirmed) return;

      const previous = keys;
      setKeys((prev) => prev.filter((k) => k.key_id !== keyId));
      try {
        const res = await fetch(`/api/mcp/keys/${encodeURIComponent(keyId)}`, { method: "DELETE" });
        if (!res.ok) {
          const json = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(json.error || `HTTP ${res.status}`);
        }
        pushToast(`Revoked ${keyPrefix}`, "ok");
      } catch (err) {
        setKeys(previous);
        pushToast(err instanceof Error ? err.message : "Revoke failed", "err");
      }
    },
    [keys, pushToast]
  );

  return (
    <main
      style={{
        minHeight: "100dvh",
        background: "var(--rpc-black)",
        color: "var(--rpc-text-primary)",
        paddingBottom: 96,
      }}
    >
      <div style={{ maxWidth: 720, margin: "0 auto", padding: "24px 16px 0" }}>
        {/* ── Header ────────────────────────────────────────────────────── */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: "var(--space-lg)",
          }}
        >
          <Link
            href="/dashboard"
            className="rpc-label"
            style={{
              color: "var(--rpc-text-secondary)",
              textDecoration: "none",
              padding: "8px 0",
              minHeight: 44,
              display: "inline-flex",
              alignItems: "center",
            }}
          >
            ← Dashboard
          </Link>
        </div>

        <div className="rpc-label" style={{ marginBottom: "var(--space-xs)" }}>
          MCP / Flow Agents
        </div>
        <h1
          className="rpc-heading"
          style={{ fontSize: "var(--text-3xl)", margin: "0 0 var(--space-md)" }}
        >
          API Keys
        </h1>
        <p
          style={{
            fontFamily: "var(--font-body)",
            color: "var(--rpc-text-secondary)",
            margin: "0 0 var(--space-xl)",
            lineHeight: 1.55,
            maxWidth: 560,
          }}
        >
          Let other apps and AI agents read your Rip Packs City collector data on your behalf.
          Issue a key, paste it into your agent, and revoke it when you&apos;re done.
        </p>

        {/* ── Primary CTA ───────────────────────────────────────────────── */}
        <button
          type="button"
          onClick={openCreate}
          className="rpc-btn-primary"
          style={{
            minHeight: 44,
            padding: "12px 22px",
            fontSize: "var(--text-base)",
            marginBottom: "var(--space-xl)",
            width: "100%",
            maxWidth: 280,
          }}
        >
          + Create new key
        </button>

        {/* ── Section label ─────────────────────────────────────────────── */}
        <div
          className="rpc-label"
          style={{
            marginTop: "var(--space-md)",
            marginBottom: "var(--space-sm)",
            color: "var(--rpc-text-muted)",
          }}
        >
          Your keys
        </div>

        {/* ── Empty / loading / error states ────────────────────────────── */}
        {loading && (
          <div className="rpc-card" style={{ padding: "var(--space-lg)" }}>
            <div className="rpc-skeleton" style={{ height: 16, width: "60%", marginBottom: 8 }} />
            <div className="rpc-skeleton" style={{ height: 12, width: "40%" }} />
          </div>
        )}

        {!loading && loadError && (
          <div
            className="rpc-card"
            style={{
              padding: "var(--space-lg)",
              borderColor: "var(--rpc-red-border)",
              background: "var(--rpc-red-bg)",
              color: "var(--rpc-text-primary)",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-sm)",
            }}
          >
            {loadError}
          </div>
        )}

        {!loading && !loadError && keys.length === 0 && (
          <div className="rpc-card" style={{ padding: "var(--space-xl)", textAlign: "center" }}>
            <div
              style={{
                fontFamily: "var(--font-body)",
                color: "var(--rpc-text-secondary)",
                lineHeight: 1.55,
              }}
            >
              No keys yet. Click <strong style={{ color: "var(--rpc-red)" }}>Create new key</strong>{" "}
              to issue one.
            </div>
            <div
              className="rpc-label"
              style={{ marginTop: "var(--space-md)", color: "var(--rpc-text-muted)" }}
            >
              Most agents need a single key — use one per device or per app so revoking is targeted.
            </div>
          </div>
        )}

        {!loading && !loadError && keys.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-sm)" }}>
            {keys.map((k) => (
              <KeyRow key={k.key_id} k={k} onRevoke={handleRevoke} />
            ))}
          </div>
        )}
      </div>

      {/* ── Create modal ────────────────────────────────────────────────── */}
      {modalOpen && (
        <ModalShell onBackdropClick={closeModal}>
          {!createdKey ? (
            <>
              <div className="rpc-label" style={{ color: "var(--rpc-text-muted)" }}>
                New API key
              </div>
              <h2
                className="rpc-heading"
                style={{ fontSize: "var(--text-xl)", margin: "var(--space-xs) 0 var(--space-md)" }}
              >
                Issue a key
              </h2>
              <label
                className="rpc-label"
                style={{ display: "block", marginBottom: "var(--space-xs)" }}
              >
                Label (optional)
              </label>
              <input
                type="text"
                value={labelInput}
                onChange={(e) => setLabelInput(e.target.value)}
                placeholder="Claude Desktop, My Eliza agent…"
                maxLength={80}
                className="rpc-filter-input"
                style={{
                  width: "100%",
                  minHeight: 44,
                  fontFamily: "var(--font-mono)",
                  marginBottom: "var(--space-md)",
                }}
              />

              {issueError && (
                <div
                  style={{
                    color: "var(--rpc-danger)",
                    fontFamily: "var(--font-mono)",
                    fontSize: "var(--text-sm)",
                    marginBottom: "var(--space-sm)",
                  }}
                >
                  {issueError}
                </div>
              )}

              <div style={{ display: "flex", gap: "var(--space-sm)", marginTop: "var(--space-md)" }}>
                <button
                  type="button"
                  onClick={closeModal}
                  className="rpc-btn-ghost"
                  style={{ minHeight: 44, flex: 1 }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleGenerate}
                  disabled={issuing}
                  className="rpc-btn-primary"
                  style={{ minHeight: 44, flex: 2, opacity: issuing ? 0.6 : 1 }}
                >
                  {issuing ? "Generating…" : "Generate"}
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="rpc-label" style={{ color: "var(--rpc-success)" }}>
                Key issued
              </div>
              <h2
                className="rpc-heading"
                style={{ fontSize: "var(--text-xl)", margin: "var(--space-xs) 0 var(--space-md)" }}
              >
                Copy your key now
              </h2>

              <div
                style={{
                  padding: "var(--space-md)",
                  background: "var(--rpc-red-bg)",
                  border: "1px solid var(--rpc-red-border)",
                  borderRadius: "var(--radius-md)",
                  marginBottom: "var(--space-md)",
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--text-sm)",
                  color: "var(--rpc-red)",
                  lineHeight: 1.5,
                }}
              >
                This is the only time you&apos;ll see this key. Copy it now. If you lose it, revoke
                and issue a new one.
              </div>

              <div
                className="rpc-mono"
                style={{
                  padding: "var(--space-md)",
                  background: "var(--rpc-surface-raised)",
                  border: "1px solid var(--rpc-border)",
                  borderRadius: "var(--radius-md)",
                  wordBreak: "break-all",
                  fontSize: "var(--text-sm)",
                  marginBottom: "var(--space-sm)",
                  lineHeight: 1.5,
                  color: "var(--rpc-text-primary)",
                }}
              >
                {createdKey.raw_key}
              </div>

              <button
                type="button"
                onClick={handleCopy}
                className={copyState === "copied" ? "rpc-btn-ghost" : "rpc-btn-primary"}
                style={{ minHeight: 44, width: "100%", marginBottom: "var(--space-sm)" }}
              >
                {copyState === "copied" ? "✓ Copied to clipboard" : "Copy to clipboard"}
              </button>

              <div
                className="rpc-label"
                style={{ color: "var(--rpc-text-muted)", marginTop: "var(--space-sm)" }}
              >
                Wallet: <span className="rpc-mono">{truncateWallet(createdKey.wallet_address)}</span>
                {createdKey.label ? ` · Label: ${createdKey.label}` : ""}
              </div>

              <button
                type="button"
                onClick={closeModal}
                className="rpc-btn-ghost"
                style={{ minHeight: 44, width: "100%", marginTop: "var(--space-md)" }}
              >
                Done
              </button>
            </>
          )}
        </ModalShell>
      )}

      {/* ── Toast ──────────────────────────────────────────────────────── */}
      {toast && (
        <div
          role="status"
          style={{
            position: "fixed",
            bottom: "calc(72px + env(safe-area-inset-bottom))",
            left: "50%",
            transform: "translateX(-50%)",
            padding: "12px 20px",
            background:
              toast.tone === "ok" ? "var(--rpc-surface-raised)" : "var(--rpc-red-bg)",
            border: `1px solid ${
              toast.tone === "ok" ? "var(--rpc-border-hover)" : "var(--rpc-red-border)"
            }`,
            color: toast.tone === "ok" ? "var(--rpc-text-primary)" : "var(--rpc-red)",
            borderRadius: "var(--radius-md)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-sm)",
            letterSpacing: "0.04em",
            zIndex: "var(--z-toast)",
            maxWidth: "calc(100vw - 32px)",
          }}
        >
          {toast.text}
        </div>
      )}

      <MobileNav />
      <SupportChatConnected />
    </main>
  );
}

// ─── Subcomponents ─────────────────────────────────────────────────────────

function KeyRow({ k, onRevoke }: { k: ApiKey; onRevoke: (id: string, prefix: string) => void }) {
  return (
    <div
      className="rpc-card"
      style={{
        padding: "var(--space-md)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-xs)",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: "var(--space-sm)",
        }}
      >
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            className="rpc-mono"
            style={{
              color: "var(--rpc-text-primary)",
              fontSize: "var(--text-sm)",
              wordBreak: "break-all",
            }}
          >
            {k.key_prefix}…
          </div>
          {k.label && (
            <div
              style={{
                fontFamily: "var(--font-body)",
                color: "var(--rpc-text-secondary)",
                fontSize: "var(--text-base)",
                marginTop: 2,
                textTransform: "none",
              }}
            >
              {k.label}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => onRevoke(k.key_id, k.key_prefix)}
          className="rpc-btn-ghost"
          style={{ minHeight: 44, padding: "6px 14px", fontSize: "var(--text-sm)" }}
        >
          Revoke
        </button>
      </div>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "var(--space-md)",
          marginTop: 4,
        }}
      >
        <div className="rpc-label" style={{ color: "var(--rpc-text-muted)" }}>
          Plan&nbsp;
          <span style={{ color: "var(--rpc-text-secondary)" }}>{k.plan}</span>
        </div>
        <div className="rpc-label" style={{ color: "var(--rpc-text-muted)" }}>
          Last used&nbsp;
          <span className="rpc-mono" style={{ color: "var(--rpc-text-secondary)" }}>
            {humanizeRelative(k.last_used_at)}
          </span>
        </div>
        <div className="rpc-label" style={{ color: "var(--rpc-text-muted)" }}>
          Wallet&nbsp;
          <span className="rpc-mono" style={{ color: "var(--rpc-text-secondary)" }}>
            {truncateWallet(k.wallet_address)}
          </span>
        </div>
      </div>
    </div>
  );
}

function ModalShell({
  children,
  onBackdropClick,
}: {
  children: React.ReactNode;
  onBackdropClick: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onBackdropClick}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.72)",
        zIndex: "var(--z-modal)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        backdropFilter: "blur(4px)",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="rpc-card"
        style={{
          maxWidth: 480,
          width: "100%",
          padding: "var(--space-xl)",
          background: "var(--rpc-surface)",
          borderColor: "var(--rpc-border-hover)",
          maxHeight: "90vh",
          overflowY: "auto",
        }}
      >
        {children}
      </div>
    </div>
  );
}
