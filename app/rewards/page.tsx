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
import { borderCosmetic, bannerCosmetic } from "@/lib/cosmetics";

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
interface ShipTo {
  name?: string;
  line1?: string;
  line2?: string;
  city?: string;
  region?: string;
  postal?: string;
  country?: string;
}
interface Fulfillment {
  gift_to?: string | null;
  ship_to?: ShipTo | null;
}
interface Redemption {
  id: number;
  shop_item_id: number;
  cost_credits: number;
  status: string;
  requested_at: string;
  fulfillment?: Fulfillment | null;
}
interface Cosmetic {
  sku: string;
  slot: string;
  value: string | null;
  acquired_at: string;
}
interface ProStatus {
  isPro: boolean;
  plan: string | null;
  expiresAt: string | null;
}
interface Equipped {
  border: string | null;
  banner: string | null;
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
  const [userId, setUserId] = useState<string | null>(null);
  const [referralCount, setReferralCount] = useState(0);
  const [cosmetics, setCosmetics] = useState<Cosmetic[]>([]);
  const [equipped, setEquipped] = useState<Equipped>({ border: null, banner: null });
  const [pro, setPro] = useState<ProStatus>({ isPro: false, plan: null, expiresAt: null });
  const [resolvedTsUsername, setResolvedTsUsername] = useState<string | null>(null);
  const [hasVerifiedWallet, setHasVerifiedWallet] = useState(true);
  const [redeeming, setRedeeming] = useState<number | null>(null);
  const [equipping, setEquipping] = useState<string | null>(null);
  const [flash, setFlash] = useState<
    { kind: "ok" | "err"; msg: string; cta?: { label: string; href: string } } | null
  >(null);
  // Merch redeem → shipping-address modal (redemptionId carried from the redeem).
  const [shipModal, setShipModal] = useState<{ redemptionId: number; itemName: string } | null>(null);

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
      setUserId(data.userId ?? null);
      setReferralCount(data.referralCount ?? 0);
      setCosmetics(data.cosmetics ?? []);
      setEquipped(data.equipped ?? { border: null, banner: null });
      setPro(data.pro ?? { isPro: false, plan: null, expiresAt: null });
      setResolvedTsUsername(data.resolvedTsUsername ?? null);
      setHasVerifiedWallet(data.hasVerifiedWallet ?? false);
    } catch {
      setFlash({ kind: "err", msg: "Couldn't load rewards. Try again." });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Set / correct the Top Shot username a Moment redemption is gifted to.
  const submitGiftTo = useCallback(
    async (redemptionId: number, current: string | null) => {
      const entered = window.prompt(
        "Top Shot username to gift this Moment to:",
        current ?? resolvedTsUsername ?? ""
      );
      if (entered === null) return; // cancelled
      const giftTo = entered.trim();
      if (!giftTo) return;
      try {
        const res = await fetch("/api/rewards/shipping", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ redemptionId, giftTo }),
        });
        const data = await res.json();
        if (res.ok && data?.ok) {
          setFlash({ kind: "ok", msg: `Gift target set to @${giftTo.replace(/^@+/, "")}.` });
          await load();
        } else {
          setFlash({ kind: "err", msg: "Couldn't save that username. Try again." });
        }
      } catch {
        setFlash({ kind: "err", msg: "Couldn't save that username. Try again." });
      }
    },
    [load, resolvedTsUsername]
  );

  // Used by the redeem flow (alias kept readable at the call site).
  const promptGiftTo = useCallback(
    (redemptionId: number) => submitGiftTo(redemptionId, null),
    [submitGiftTo]
  );

  // Save a shipping address for a merch redemption (from the modal).
  const submitShipping = useCallback(
    async (redemptionId: number, address: ShipTo) => {
      const res = await fetch("/api/rewards/shipping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redemptionId, address }),
      });
      const data = await res.json();
      if (res.ok && data?.ok) {
        setShipModal(null);
        setFlash({ kind: "ok", msg: "Shipping address saved — we'll send it out." });
        await load();
        return true;
      }
      return false;
    },
    [load]
  );

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
          // Digital goods (pro / cosmetic) deliver instantly at redeem
          // (data.status === "fulfilled"); moment / merch stay pending for
          // manual fulfillment. Tailor the toast to what actually happened.
          const redemptionId: number | null =
            typeof data.redemption_id === "number" ? data.redemption_id : null;
          let msg: string;
          if (item.type === "pro") {
            msg = "RPC Pro activated — 30 days. Enjoy.";
          } else if (item.type === "cosmetic") {
            msg = `Equipped "${item.name}" on your profile.`;
          } else if (item.type === "moment") {
            msg = resolvedTsUsername
              ? `Redeemed "${item.name}". We'll gift it to @${resolvedTsUsername} on Top Shot — track it below.`
              : `Redeemed "${item.name}". Tell us the Top Shot username to gift it to — track it below.`;
          } else if (item.type === "merch") {
            msg = `Redeemed "${item.name}". Add your shipping address so we can send it.`;
          } else {
            msg = `Redeemed "${item.name}". Track it below.`;
          }
          setFlash({ kind: "ok", msg });
          await load();
          // Merch → collect a shipping address right away.
          if (item.type === "merch" && redemptionId !== null) {
            setShipModal({ redemptionId, itemName: item.name });
          }
          // Moment with no resolved gift target → ask for the Top Shot username.
          if (item.type === "moment" && redemptionId !== null && !resolvedTsUsername) {
            await promptGiftTo(redemptionId);
          }
        } else if (data?.error === "verified_wallet_required") {
          // The gate is the sybil guard — surface it as the next step, not a
          // failure. (redeem_shop_item returns 'verified_wallet_required'.)
          setFlash({
            kind: "err",
            msg: "Verify your Top Shot wallet to unlock Moment + Pro rewards.",
            cta: { label: "Verify wallet →", href: "/profile" },
          });
        } else {
          const reason =
            data?.error === "insufficient_credits"
              ? "Not enough Credits."
              : data?.error === "out_of_stock"
              ? "That one's out of stock."
              : data?.error === "status_too_low"
              ? "You haven't reached the required tier yet."
              : data?.error === "per_user_limit_reached"
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
    [load, resolvedTsUsername, promptGiftTo]
  );

  const equip = useCallback(
    async (sku: string) => {
      setEquipping(sku);
      setFlash(null);
      try {
        const res = await fetch("/api/rewards/equip", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sku }),
        });
        const data = await res.json();
        if (res.ok && data?.ok) {
          setFlash({ kind: "ok", msg: "Equipped! It's live on your profile." });
          await load();
        } else {
          setFlash({ kind: "err", msg: "Couldn't equip that. Try again." });
        }
      } catch {
        setFlash({ kind: "err", msg: "Equip failed. Try again." });
      } finally {
        setEquipping(null);
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
            {flash.cta && (
              <>
                {" "}
                <Link href={flash.cta.href} style={{ color: RED, fontWeight: 600 }}>
                  {flash.cta.label}
                </Link>
              </>
            )}
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

            {/* PRO STATUS — only when active (granted via the Pro shop item) */}
            {pro.isPro && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  margin: "0 0 28px",
                  padding: "10px 14px",
                  borderRadius: 8,
                  border: `1px solid ${RED}`,
                  background: "rgba(224,58,47,0.10)",
                  fontFamily: MONO,
                  fontSize: 13,
                }}
              >
                <span style={{ color: RED, fontFamily: DISPLAY, letterSpacing: "0.06em" }}>★ RPC PRO</span>
                <span style={{ color: "#cfcfcf" }}>
                  {pro.expiresAt
                    ? `Active until ${new Date(pro.expiresAt).toLocaleDateString()}`
                    : "Active"}
                </span>
              </div>
            )}

            {/* INVITE */}
            {userId && (
              <>
                <SectionTitle>Invite a collector</SectionTitle>
                <InviteBlock userId={userId} referralCount={referralCount} />
              </>
            )}

            {/* COSMETICS — owned profile cosmetics, with equip/equipped state */}
            {cosmetics.length > 0 && (
              <>
                <SectionTitle>Your cosmetics</SectionTitle>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
                    gap: 12,
                    marginBottom: 28,
                  }}
                >
                  {cosmetics.map((c) => {
                    const isBorder = c.slot === "border";
                    const isBanner = c.slot === "banner";
                    const bc = isBorder ? borderCosmetic(c.value) : null;
                    const bn = isBanner ? bannerCosmetic(c.value) : null;
                    const label = bc?.label ?? bn?.label ?? c.value ?? c.sku;
                    const equippedNow =
                      (isBorder && equipped.border === c.value) ||
                      (isBanner && equipped.banner === c.value);
                    return (
                      <div
                        key={c.sku}
                        style={{ ...cardStyle, padding: 14, display: "flex", flexDirection: "column", gap: 10 }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          {isBanner ? (
                            <span
                              style={{
                                width: 48,
                                height: 22,
                                borderRadius: 4,
                                background: bn?.background ?? "#333",
                                border: "1px solid #333",
                                flexShrink: 0,
                              }}
                            />
                          ) : (
                            <span
                              style={{
                                width: 34,
                                height: 34,
                                borderRadius: "50%",
                                border: `3px solid ${bc?.ring ?? "#666"}`,
                                boxShadow: bc?.glow ? `0 0 10px ${bc.glow}` : undefined,
                                background: "#0a0a0a",
                                flexShrink: 0,
                              }}
                            />
                          )}
                          <div>
                            <div style={{ fontSize: 14 }}>{label}</div>
                            <div
                              style={{
                                fontFamily: MONO,
                                fontSize: 10,
                                textTransform: "uppercase",
                                letterSpacing: "0.08em",
                                color: "#7a7a7a",
                              }}
                            >
                              {c.slot}
                            </div>
                          </div>
                        </div>
                        <button
                          type="button"
                          disabled={equippedNow || equipping === c.sku}
                          onClick={() => equip(c.sku)}
                          style={{
                            padding: "7px 12px",
                            borderRadius: 8,
                            border: equippedNow ? "1px solid #2e7d32" : "none",
                            cursor: equippedNow ? "default" : "pointer",
                            background: equippedNow ? "transparent" : RED,
                            color: equippedNow ? "#5cc46a" : "#fff",
                            fontFamily: DISPLAY,
                            textTransform: "uppercase",
                            letterSpacing: "0.05em",
                            fontSize: 12,
                            opacity: equipping === c.sku ? 0.6 : 1,
                          }}
                        >
                          {equippedNow ? "Equipped" : equipping === c.sku ? "…" : "Equip"}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </>
            )}

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
            {!hasVerifiedWallet && (
              <Link
                href="/profile"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  margin: "0 0 16px",
                  padding: "12px 16px",
                  borderRadius: 8,
                  border: `1px solid ${RED}`,
                  background: "rgba(224,58,47,0.08)",
                  textDecoration: "none",
                  color: "#e7e7e7",
                }}
              >
                <span style={{ color: RED, fontFamily: DISPLAY, letterSpacing: "0.06em", fontSize: 18 }}>
                  🔒
                </span>
                <span style={{ fontFamily: MONO, fontSize: 13 }}>
                  Verify your Top Shot wallet to unlock Moment + Pro rewards — and earn{" "}
                  <strong style={{ color: RED }}>500 credits</strong> for linking.
                </span>
                <span style={{ marginLeft: "auto", color: RED, fontFamily: DISPLAY, whiteSpace: "nowrap" }}>
                  Verify →
                </span>
              </Link>
            )}
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
                    {item.type === "moment" && (
                      <div
                        style={{
                          marginTop: 6,
                          fontFamily: MONO,
                          fontSize: 11,
                          color: resolvedTsUsername ? "#5cc46a" : "#d6a13a",
                        }}
                      >
                        {resolvedTsUsername
                          ? `Gifts to @${resolvedTsUsername} on Top Shot`
                          : "Link a Top Shot wallet first to receive the gift"}
                      </div>
                    )}
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
                        {item?.type === "moment" && r.status === "pending" && (
                          <div style={{ marginTop: 4, fontFamily: MONO, fontSize: 11 }}>
                            {(() => {
                              const gift = r.fulfillment?.gift_to ?? resolvedTsUsername ?? null;
                              return (
                                <>
                                  <span style={{ color: gift ? "#9a9a9a" : "#d6a13a" }}>
                                    {gift ? `Gifting to @${gift}` : "No gift target set"}
                                  </span>{" "}
                                  <button
                                    type="button"
                                    onClick={() => submitGiftTo(r.id, r.fulfillment?.gift_to ?? null)}
                                    style={linkBtn}
                                  >
                                    {gift ? "not right?" : "set username"}
                                  </button>
                                </>
                              );
                            })()}
                          </div>
                        )}
                        {item?.type === "merch" && r.status === "pending" && (
                          <div style={{ marginTop: 4, fontFamily: MONO, fontSize: 11 }}>
                            {r.fulfillment?.ship_to?.name ? (
                              <>
                                <span style={{ color: "#9a9a9a" }}>
                                  Shipping to {r.fulfillment.ship_to.name}
                                </span>{" "}
                                <button
                                  type="button"
                                  onClick={() => setShipModal({ redemptionId: r.id, itemName: item?.name ?? "merch" })}
                                  style={linkBtn}
                                >
                                  edit
                                </button>
                              </>
                            ) : (
                              <button
                                type="button"
                                onClick={() => setShipModal({ redemptionId: r.id, itemName: item?.name ?? "merch" })}
                                style={{ ...linkBtn, color: "#d6a13a" }}
                              >
                                Add shipping address
                              </button>
                            )}
                          </div>
                        )}
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

      {shipModal && (
        <ShippingModal
          itemName={shipModal.itemName}
          onClose={() => setShipModal(null)}
          onSubmit={(addr) => submitShipping(shipModal.redemptionId, addr)}
        />
      )}
    </div>
  );
}

const linkBtn: React.CSSProperties = {
  background: "none",
  border: "none",
  padding: 0,
  cursor: "pointer",
  color: RED,
  fontFamily: MONO,
  fontSize: 11,
  textDecoration: "underline",
};

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

// Credits awarded per verified referral. Mirrors the points_rules
// `referral_verified` seed (300); display-only — the server is authoritative.
const REFERRAL_CREDITS = 300;

function InviteBlock({ userId, referralCount }: { userId: string; referralCount: number }) {
  const [copied, setCopied] = useState(false);
  const link = useMemo(() => {
    const origin =
      typeof window !== "undefined" ? window.location.origin : "https://www.rippackscity.com";
    return `${origin}/?ref=${userId}`;
  }, [userId]);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // clipboard can be blocked — non-fatal, user can select the text.
    }
  }, [link]);

  return (
    <div style={{ ...cardStyle, marginBottom: 28 }}>
      <p style={{ marginTop: 0, color: "#9a9a9a", fontSize: 14 }}>
        Share your link. When a collector links a verified wallet through it, you earn{" "}
        <strong style={{ color: "#e7e7e7" }}>{num(REFERRAL_CREDITS)} credits</strong>.
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input
          readOnly
          value={link}
          onFocus={(e) => e.currentTarget.select()}
          style={{
            flex: "1 1 280px",
            minWidth: 0,
            fontFamily: MONO,
            fontSize: 13,
            color: "#e7e7e7",
            background: "#0a0a0a",
            border: "1px solid #333",
            borderRadius: 8,
            padding: "10px 12px",
          }}
        />
        <button
          type="button"
          onClick={copy}
          style={{
            padding: "10px 18px",
            borderRadius: 8,
            border: "none",
            cursor: "pointer",
            background: RED,
            color: "#fff",
            fontFamily: DISPLAY,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            fontSize: 13,
            whiteSpace: "nowrap",
          }}
        >
          {copied ? "Copied!" : "Copy link"}
        </button>
      </div>
      <div style={{ marginTop: 10, fontFamily: MONO, fontSize: 12, color: "#9a9a9a" }}>
        {referralCount > 0
          ? `${num(referralCount)} ${referralCount === 1 ? "friend" : "friends"} joined · earned ${num(
              referralCount * REFERRAL_CREDITS
            )} credits`
          : "No referrals yet — be the first to share."}
      </div>
    </div>
  );
}

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

// Merch shipping-address modal. Returns true from onSubmit on success (so we
// can keep it open with an error if the POST fails). Address lives only in the
// redemption's fulfillment (service-role surface) — never rendered publicly.
function ShippingModal({
  itemName,
  onClose,
  onSubmit,
}: {
  itemName: string;
  onClose: () => void;
  onSubmit: (addr: ShipTo) => Promise<boolean>;
}) {
  const [name, setName] = useState("");
  const [line1, setLine1] = useState("");
  const [line2, setLine2] = useState("");
  const [city, setCity] = useState("");
  const [region, setRegion] = useState("");
  const [postal, setPostal] = useState("");
  const [country, setCountry] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const canSubmit = name.trim() && line1.trim() && city.trim();

  const submit = async () => {
    if (!canSubmit || saving) return;
    setSaving(true);
    setErr(null);
    const ok = await onSubmit({
      name: name.trim(),
      line1: line1.trim(),
      line2: line2.trim() || undefined,
      city: city.trim(),
      region: region.trim() || undefined,
      postal: postal.trim() || undefined,
      country: country.trim() || undefined,
    });
    setSaving(false);
    if (!ok) setErr("Couldn't save that address. Check the fields and try again.");
  };

  const field: React.CSSProperties = {
    width: "100%",
    boxSizing: "border-box",
    padding: "9px 11px",
    borderRadius: 8,
    border: "1px solid #333",
    background: "#0a0a0a",
    color: "#e7e7e7",
    fontFamily: MONO,
    fontSize: 13,
    marginTop: 4,
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Shipping address"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.72)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: 420, maxWidth: "94vw", ...cardStyle, maxHeight: "90vh", overflowY: "auto" }}
      >
        <h3 style={{ fontFamily: DISPLAY, textTransform: "uppercase", margin: "0 0 4px", fontSize: 22 }}>
          Shipping <span style={{ color: RED }}>address</span>
        </h3>
        <p style={{ color: "#9a9a9a", fontSize: 13, marginTop: 0 }}>
          Where should we send your <strong style={{ color: "#e7e7e7" }}>{itemName}</strong>? Only RPC
          sees this — it's never shown publicly.
        </p>

        <label style={{ display: "block", fontFamily: MONO, fontSize: 11, color: "#9a9a9a", marginTop: 10 }}>
          Full name
          <input style={field} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label style={{ display: "block", fontFamily: MONO, fontSize: 11, color: "#9a9a9a", marginTop: 10 }}>
          Street address
          <input style={field} value={line1} onChange={(e) => setLine1(e.target.value)} />
        </label>
        <label style={{ display: "block", fontFamily: MONO, fontSize: 11, color: "#9a9a9a", marginTop: 10 }}>
          Apt / unit (optional)
          <input style={field} value={line2} onChange={(e) => setLine2(e.target.value)} />
        </label>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 10 }}>
          <label style={{ display: "block", fontFamily: MONO, fontSize: 11, color: "#9a9a9a" }}>
            City
            <input style={field} value={city} onChange={(e) => setCity(e.target.value)} />
          </label>
          <label style={{ display: "block", fontFamily: MONO, fontSize: 11, color: "#9a9a9a" }}>
            State / region
            <input style={field} value={region} onChange={(e) => setRegion(e.target.value)} />
          </label>
          <label style={{ display: "block", fontFamily: MONO, fontSize: 11, color: "#9a9a9a" }}>
            Postal code
            <input style={field} value={postal} onChange={(e) => setPostal(e.target.value)} />
          </label>
          <label style={{ display: "block", fontFamily: MONO, fontSize: 11, color: "#9a9a9a" }}>
            Country
            <input style={field} value={country} onChange={(e) => setCountry(e.target.value)} />
          </label>
        </div>

        {err && (
          <div style={{ marginTop: 10, color: RED, fontFamily: MONO, fontSize: 12 }}>{err}</div>
        )}

        <div style={{ display: "flex", gap: 10, marginTop: 16, justifyContent: "flex-end" }}>
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: "9px 16px",
              borderRadius: 8,
              border: "1px solid #333",
              background: "transparent",
              color: "#e7e7e7",
              cursor: "pointer",
              fontFamily: DISPLAY,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              fontSize: 13,
            }}
          >
            Later
          </button>
          <button
            type="button"
            disabled={!canSubmit || saving}
            onClick={submit}
            style={{
              padding: "9px 18px",
              borderRadius: 8,
              border: "none",
              background: RED,
              color: "#fff",
              cursor: canSubmit && !saving ? "pointer" : "not-allowed",
              opacity: canSubmit && !saving ? 1 : 0.5,
              fontFamily: DISPLAY,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              fontSize: 13,
            }}
          >
            {saving ? "Saving…" : "Save address"}
          </button>
        </div>
      </div>
    </div>
  );
}
