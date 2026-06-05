"use client";

// app/rewards/page.tsx
//
// Auth-gated rewards hub. All numbers are server-authoritative (GET
// /api/rewards/summary). The client only displays them and POSTs an itemId to
// /api/rewards/redeem — it never sends a user id or a points amount.
//
// NOTE: this is NOT in proxy.ts isPublicPath() by design — it must require login.

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import MobileNav from "@/components/MobileNav";
import SupportChatConnected from "@/components/SupportChatConnected";

const DISPLAY = "var(--font-display)";
const MONO = "var(--font-mono)";
const RED = "var(--rpc-red)";

// Mirror of public.rewards_tier(status). Display-only; the server is the source
// of truth for the actual tier string in the summary payload.
const TIERS = [
  { name: "Rookie", min: 0 },
  { name: "Role Player", min: 500 },
  { name: "Starter", min: 2500 },
  { name: "All-Star", min: 10000 },
  { name: "Franchise", min: 30000 },
] as const;

type Tier = (typeof TIERS)[number];

function tierProgress(status: number) {
  let current: Tier = TIERS[0];
  let next: Tier | null = null;
  for (let i = 0; i < TIERS.length; i++) {
    if (status >= TIERS[i].min) {
      current = TIERS[i];
      next = TIERS[i + 1] ?? null;
    }
  }
  if (!next) return { current, next: null, pct: 100, toNext: 0 };
  const span = next.min - current.min;
  const into = status - current.min;
  const pct = Math.max(0, Math.min(100, Math.round((into / span) * 100)));
  return { current, next, pct, toNext: next.min - status };
}

function tierNameForStatus(min: number): string {
  let name: string = TIERS[0].name;
  for (const t of TIERS) if (min >= t.min) name = t.name;
  return name;
}

interface Summary {
  spendable: number;
  status: number;
  tier: string;
  lifetime_earned: number;
  lifetime_spent: number;
}
interface Rule {
  action_key: string;
  label: string;
  points: number;
  daily_cap: number | null;
  per_user_limit: number | null;
}
interface ShopItem {
  id: number;
  sku: string;
  name: string;
  description: string | null;
  type: string;
  cost_credits: number;
  stock: number | null;
  min_status: number;
  requires_verified_wallet: boolean;
  image_url: string | null;
  metadata: Record<string, unknown> | null;
}
interface Redemption {
  id: number;
  shop_item_id: number;
  cost_credits: number;
  status: string;
  requested_at: string;
}

const TYPE_LABEL: Record<string, string> = {
  pro: "Pro",
  cosmetic: "Cosmetic",
  raffle: "Raffle",
  moment: "Moment",
};

function num(n: number | null | undefined): string {
  return (n ?? 0).toLocaleString("en-US");
}

export default function RewardsPage() {
  const [loading, setLoading] = useState(true);
  const [authed, setAuthed] = useState(true);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [rules, setRules] = useState<Rule[]>([]);
  const [shop, setShop] = useState<ShopItem[]>([]);
  const [redemptions, setRedemptions] = useState<Redemption[]>([]);
  const [redeeming, setRedeeming] = useState<number | null>(null);
  const [flash, setFlash] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/rewards/summary", { cache: "no-store" });
      if (res.status === 401) {
        setAuthed(false);
        setLoading(false);
        return;
      }
      const data = await res.json();
      setSummary(data.summary ?? null);
      setRules(data.rules ?? []);
      setShop(data.shop ?? []);
      setRedemptions(data.redemptions ?? []);
    } catch {
      setFlash({ kind: "err", msg: "Couldn't load rewards. Try again." });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const redeem = useCallback(
    async (item: ShopItem) => {
      setRedeeming(item.id);
      setFlash(null);
      try {
        const res = await fetch("/api/rewards/redeem", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ itemId: item.id }),
        });
        const data = await res.json();
        if (res.ok && data?.redeemed) {
          setFlash({
            kind: "ok",
            msg: `Redeemed "${item.name}". We'll send it to your wallet — track it below.`,
          });
          await load();
        } else {
          const reason =
            data?.error === "insufficient_credits"
              ? "Not enough Credits."
              : data?.error === "out_of_stock"
              ? "That one's out of stock."
              : data?.error === "status_too_low"
              ? "You haven't reached the required tier yet."
              : data?.error === "requires_verified_wallet"
              ? "Link & verify a wallet first."
              : data?.error === "per_user_limit"
              ? "You've already redeemed this."
              : "Couldn't redeem that item.";
          setFlash({ kind: "err", msg: reason });
        }
      } catch {
        setFlash({ kind: "err", msg: "Redeem failed. Try again." });
      } finally {
        setRedeeming(null);
      }
    },
    [load]
  );

  const status = summary?.status ?? 0;
  const spendable = summary?.spendable ?? 0;
  const prog = useMemo(() => tierProgress(status), [status]);
  const itemById = useMemo(() => {
    const m = new Map<number, ShopItem>();
    for (const s of shop) m.set(s.id, s);
    return m;
  }, [shop]);

  return (
    <div style={{ minHeight: "100vh", background: "#0a0a0a", color: "#e7e7e7" }}>
      <MobileNav />
      <SupportChatConnected />

      <main style={{ maxWidth: 1080, margin: "0 auto", padding: "24px 16px 96px" }}>
        <h1
          style={{
            fontFamily: DISPLAY,
            textTransform: "uppercase",
            letterSpacing: "0.04em",
            fontSize: 38,
            margin: "8px 0 4px",
          }}
        >
          RPC <span style={{ color: RED }}>Rewards</span>
        </h1>
        <p style={{ color: "#9a9a9a", margin: "0 0 20px", maxWidth: 640 }}>
          Earn <strong>Status</strong> for using the platform — it only goes up and sets your tier.
          Spend <strong>Credits</strong> in the shop. Most earns happen automatically as you go.
        </p>

        {flash && (
          <div
            role="status"
            style={{
              margin: "0 0 16px",
              padding: "10px 14px",
              borderRadius: 8,
              border: `1px solid ${flash.kind === "ok" ? "#2e7d32" : RED}`,
              background: flash.kind === "ok" ? "rgba(46,125,50,0.12)" : "rgba(224,58,47,0.12)",
              fontFamily: MONO,
              fontSize: 13,
            }}
          >
            {flash.msg}
          </div>
        )}

        {loading ? (
          <p style={{ fontFamily: MONO, color: "#9a9a9a" }}>Loading…</p>
        ) : !authed ? (
          <div
            style={{
              padding: 24,
              border: "1px solid #222",
              borderRadius: 12,
              background: "#111",
            }}
          >
            <p style={{ marginTop: 0 }}>Sign in to view your rewards.</p>
            <Link
              href="/login?next=/rewards"
              style={{
                display: "inline-block",
                marginTop: 8,
                padding: "10px 18px",
                background: RED,
                color: "#fff",
                borderRadius: 8,
                fontFamily: DISPLAY,
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                textDecoration: "none",
              }}
            >
              Sign in
            </Link>
          </div>
        ) : (
          <>
            {/* HERO — two-number system */}
            <section
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 16,
                marginBottom: 28,
              }}
            >
              <div style={cardStyle}>
                <div style={kickerStyle}>Tier · Status</div>
                <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                  <span style={{ fontFamily: DISPLAY, fontSize: 30, textTransform: "uppercase" }}>
                    {summary?.tier ?? prog.current.name}
                  </span>
                  <span style={{ fontFamily: MONO, color: RED, fontSize: 18 }}>
                    {num(status)} pts
                  </span>
                </div>
                <div
                  style={{
                    marginTop: 12,
                    height: 8,
                    borderRadius: 99,
                    background: "#222",
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      width: `${prog.pct}%`,
                      height: "100%",
                      background: RED,
                      transition: "width 240ms ease",
                    }}
                  />
                </div>
                <div style={{ marginTop: 6, fontFamily: MONO, fontSize: 12, color: "#9a9a9a" }}>
                  {prog.next
                    ? `${num(prog.toNext)} status to ${prog.next.name}`
                    : "Top tier reached"}
                </div>
              </div>

              <div style={cardStyle}>
                <div style={kickerStyle}>Credits · Spendable</div>
                <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                  <span style={{ fontFamily: MONO, color: RED, fontSize: 34 }}>{num(spendable)}</span>
                  <span style={{ color: "#9a9a9a" }}>Credits</span>
                </div>
                <div style={{ marginTop: 12, fontFamily: MONO, fontSize: 12, color: "#9a9a9a" }}>
                  Lifetime earned {num(summary?.lifetime_earned)} · spent{" "}
                  {num(summary?.lifetime_spent)}
                </div>
              </div>
            </section>

            {/* EARN */}
            <SectionTitle>Ways to earn</SectionTitle>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
                gap: 12,
                marginBottom: 28,
              }}
            >
              {rules.map((r) => (
                <div key={r.action_key} style={{ ...cardStyle, padding: 14 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                    <span style={{ fontSize: 14 }}>{r.label}</span>
                    <span style={{ fontFamily: MONO, color: RED, whiteSpace: "nowrap" }}>
                      +{num(r.points)}
                    </span>
                  </div>
                  <div style={{ marginTop: 6, fontFamily: MONO, fontSize: 11, color: "#7a7a7a" }}>
                    {r.per_user_limit === 1
                      ? "One-time"
                      : r.daily_cap
                      ? `Up to ${r.daily_cap}×/day`
                      : "Repeatable"}
                  </div>
                </div>
              ))}
            </div>

            {/* SHOP */}
            <SectionTitle>Shop</SectionTitle>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
                gap: 14,
                marginBottom: 28,
              }}
            >
              {shop.map((item) => {
                const tierLocked = status < (item.min_status ?? 0);
                const affordable = spendable >= item.cost_credits;
                const soldOut = item.stock !== null && item.stock <= 0;
                const disabled =
                  redeeming === item.id || !affordable || tierLocked || soldOut;
                return (
                  <div key={item.id} style={{ ...cardStyle, display: "flex", flexDirection: "column" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                      <span
                        style={{
                          fontFamily: MONO,
                          fontSize: 10,
                          textTransform: "uppercase",
                          letterSpacing: "0.08em",
                          color: "#9a9a9a",
                          border: "1px solid #333",
                          borderRadius: 99,
                          padding: "2px 8px",
                        }}
                      >
                        {TYPE_LABEL[item.type] ?? item.type}
                      </span>
                      {item.requires_verified_wallet && (
                        <span title="Requires a verified wallet" style={{ color: "#9a9a9a" }}>
                          🔒
                        </span>
                      )}
                    </div>
                    <div style={{ fontFamily: DISPLAY, fontSize: 19, marginTop: 10 }}>
                      {item.name}
                    </div>
                    {item.description && (
                      <div style={{ fontSize: 13, color: "#9a9a9a", marginTop: 4, flex: 1 }}>
                        {item.description}
                      </div>
                    )}
                    <div style={{ flex: item.description ? undefined : 1 }} />
                    <div
                      style={{
                        marginTop: 12,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 8,
                      }}
                    >
                      <span style={{ fontFamily: MONO, color: RED, fontSize: 18 }}>
                        {num(item.cost_credits)}
                      </span>
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => redeem(item)}
                        style={{
                          padding: "8px 14px",
                          borderRadius: 8,
                          border: "none",
                          cursor: disabled ? "not-allowed" : "pointer",
                          opacity: disabled ? 0.5 : 1,
                          background: RED,
                          color: "#fff",
                          fontFamily: DISPLAY,
                          textTransform: "uppercase",
                          letterSpacing: "0.05em",
                          fontSize: 13,
                        }}
                      >
                        {redeeming === item.id ? "…" : "Redeem"}
                      </button>
                    </div>
                    <div style={{ marginTop: 6, fontFamily: MONO, fontSize: 11, color: "#7a7a7a" }}>
                      {soldOut
                        ? "Out of stock"
                        : tierLocked
                        ? `Needs ${tierNameForStatus(item.min_status)} (${num(item.min_status)} status)`
                        : !affordable
                        ? `Need ${num(item.cost_credits - spendable)} more`
                        : item.stock !== null
                        ? `${num(item.stock)} left`
                        : " "}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* HISTORY */}
            <SectionTitle>Your redemptions</SectionTitle>
            {redemptions.length === 0 ? (
              <p style={{ fontFamily: MONO, color: "#7a7a7a" }}>Nothing redeemed yet.</p>
            ) : (
              <div style={{ ...cardStyle, padding: 0, overflow: "hidden" }}>
                {redemptions.map((r, i) => {
                  const item = itemById.get(r.shop_item_id);
                  return (
                    <div
                      key={r.id}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        gap: 12,
                        padding: "12px 16px",
                        borderTop: i === 0 ? "none" : "1px solid #1c1c1c",
                      }}
                    >
                      <div>
                        <div style={{ fontSize: 14 }}>{item?.name ?? `Item #${r.shop_item_id}`}</div>
                        <div style={{ fontFamily: MONO, fontSize: 11, color: "#7a7a7a" }}>
                          {new Date(r.requested_at).toLocaleDateString()}
                        </div>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                        <span style={{ fontFamily: MONO, color: "#9a9a9a" }}>
                          −{num(r.cost_credits)}
                        </span>
                        <span
                          style={{
                            fontFamily: MONO,
                            fontSize: 11,
                            textTransform: "uppercase",
                            letterSpacing: "0.06em",
                            color: r.status === "fulfilled" ? "#5cc46a" : "#d6a13a",
                          }}
                        >
                          {r.status}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  padding: 18,
  border: "1px solid #222",
  borderRadius: 12,
  background: "#111",
};

const kickerStyle: React.CSSProperties = {
  fontFamily: MONO,
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  color: "#9a9a9a",
  marginBottom: 8,
};

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2
      style={{
        fontFamily: DISPLAY,
        textTransform: "uppercase",
        letterSpacing: "0.05em",
        fontSize: 20,
        margin: "0 0 12px",
        paddingBottom: 6,
        borderBottom: `2px solid ${RED}`,
        display: "inline-block",
      }}
    >
      {children}
    </h2>
  );
}
