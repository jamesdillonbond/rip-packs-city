"use client";

// app/special-serial-owners/page.tsx
//
// Auth-gated Special Serial Owners board. For every canonical Top Shot special
// serial — the #1 mint, the perfect mint (#N/N), and the jersey-match serial —
// it shows the current tracked-wallet holder and the edition FMV. Backed by the
// public route /api/public/special-serial-owners (service-role -> SECDEF RPC ->
// topshot_special_serial_owners view).
//
// NOT in proxy.ts isPublicPath() by design — it must require login (Trevor's
// 2026-06-19 holder-exposure decision). Lives at /special-serial-owners (top
// level) rather than /insights/* precisely because /insights/* is anon-public.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import MobileNav from "@/components/MobileNav";
import SupportChatConnected from "@/components/SupportChatConnected";
import type { OwnerRow, SpecialSerialTag, OwnersSortKey } from "@/lib/special-serial-owners-board";

type TagFilter = "all" | SpecialSerialTag;
type TierFilter = "all" | "COMMON" | "FANDOM" | "RARE" | "LEGENDARY" | "ULTIMATE";

const TAGS: { val: TagFilter; label: string }[] = [
  { val: "all", label: "All" },
  { val: "#1", label: "#1 Mint" },
  { val: "perfect", label: "Perfect" },
  { val: "jersey", label: "Jersey" },
];
const TIERS: { val: TierFilter; label: string }[] = [
  { val: "all", label: "All" },
  { val: "COMMON", label: "Common" },
  { val: "FANDOM", label: "Fandom" },
  { val: "RARE", label: "Rare" },
  { val: "LEGENDARY", label: "Legendary" },
  { val: "ULTIMATE", label: "Ultimate" },
];

function fmtMoney(n: number | null): string {
  if (n == null) return "—";
  const v = Number(n);
  if (v >= 100) return `$${Math.round(v).toLocaleString("en-US")}`;
  return `$${v.toFixed(2)}`;
}
function fmtInt(n: number | null): string {
  if (n == null) return "—";
  return Number(n).toLocaleString("en-US");
}
function truncAddr(a: string | null): string {
  if (!a) return "—";
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}
function tierColor(tier: string | null): string {
  switch ((tier ?? "").toUpperCase()) {
    case "LEGENDARY": return "var(--tier-legendary)";
    case "ULTIMATE": return "var(--tier-ultimate)";
    case "RARE": return "var(--tier-rare)";
    case "FANDOM": return "var(--tier-fandom)";
    case "COMMON": return "var(--tier-common)";
    default: return "var(--rpc-text-muted)";
  }
}
function tagLabel(tag: string | null): string {
  if (tag === "#1") return "#1 MINT";
  if (tag === "perfect") return "PERFECT";
  if (tag === "jersey") return "JERSEY";
  return (tag ?? "").toUpperCase();
}
function serialLabel(r: OwnerRow): string {
  if (r.circulation_count != null) return `#${fmtInt(r.serial)} / ${fmtInt(r.circulation_count)}`;
  return `#${fmtInt(r.serial)}`;
}
function editionHref(r: OwnerRow): string | null {
  if (!r.edition_key) return null;
  return `/nba-top-shot/edition/${encodeURIComponent(r.edition_key)}`;
}
function momentImg(r: OwnerRow): string | null {
  if (!r.nft_id) return null;
  return `https://assets.nbatopshot.com/media/${encodeURIComponent(r.nft_id)}/image?width=384`;
}

function BoardImage({ r }: { r: OwnerRow }) {
  const initial = momentImg(r);
  const [src, setSrc] = useState<string | null>(initial);
  if (!src) return <div className="rpc-sso-img-fallback" aria-hidden />;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={r.player_name || r.set_name || "Moment"}
      className="rpc-sso-img"
      loading="lazy"
      onError={() => setSrc(null)}
    />
  );
}

type ApiResponse = { meta: { fetched_at: string; total_rows: number }; rows: OwnerRow[] };

export default function SpecialSerialOwnersPage() {
  const [rows, setRows] = useState<OwnerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [tag, setTag] = useState<TagFilter>("all");
  const [tier, setTier] = useState<TierFilter>("all");
  const [sort, setSort] = useState<OwnersSortKey>("fmv");
  const [playerInput, setPlayerInput] = useState("");
  const [player, setPlayer] = useState("");

  // Debounce the player search box so each keystroke doesn't refetch.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onPlayerChange = useCallback((v: string) => {
    setPlayerInput(v);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setPlayer(v.trim()), 350);
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    async function run() {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        params.set("limit", "200");
        params.set("sort", sort);
        if (tag !== "all") params.set("tag", tag);
        if (tier !== "all") params.set("tier", tier);
        if (player) params.set("player", player);
        const r = await fetch(`/api/public/special-serial-owners?${params.toString()}`, {
          signal: ctrl.signal,
          cache: "no-store",
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as ApiResponse;
        setRows(j.rows ?? []);
      } catch (e: unknown) {
        if ((e as { name?: string })?.name === "AbortError") return;
        setError(e instanceof Error ? e.message : "Failed to load");
      } finally {
        setLoading(false);
      }
    }
    run();
    return () => ctrl.abort();
  }, [tag, tier, sort, player]);

  const kpis = useMemo(() => {
    const holders = new Set(rows.map((r) => r.holder_address).filter(Boolean));
    const topFmv = rows.reduce<number | null>((m, r) => {
      const v = r.edition_fmv == null ? null : Number(r.edition_fmv);
      if (v == null) return m;
      return m == null || v > m ? v : m;
    }, null);
    return { count: rows.length, holders: holders.size, topFmv };
  }, [rows]);

  return (
    <div style={{ minHeight: "100vh", background: "var(--rpc-black)", color: "var(--rpc-text-primary)" }}>
      <MobileNav />
      <style>{CSS}</style>
      <main className="rpc-sso-main">
        <section className="rpc-sso-head">
          <div className="rpc-sso-eyebrow">RPC Intelligence</div>
          <div className="rpc-sso-title-row">
            <h1 className="rpc-sso-h1">Special Serial Owners</h1>
            <Link href="/dashboard" className="rpc-sso-back">← Dashboard</Link>
          </div>
          <p className="rpc-sso-lede">
            Who actually holds the chase serials on Top Shot — the <strong>#1 mint</strong>, the{" "}
            <strong>perfect mint</strong> (#N&nbsp;of&nbsp;N), and the <strong>jersey-match</strong>{" "}
            serial of every edition. Current holder among tracked wallets, with the edition&apos;s FMV.
          </p>
        </section>

        <section className="rpc-sso-kpi-row" aria-label="Summary">
          <div className="rpc-sso-kpi">
            <div className="rpc-sso-kpi-label">Special serials</div>
            <div className="rpc-sso-kpi-value">{fmtInt(kpis.count)}</div>
          </div>
          <div className="rpc-sso-kpi">
            <div className="rpc-sso-kpi-label">Distinct holders</div>
            <div className="rpc-sso-kpi-value">{fmtInt(kpis.holders)}</div>
          </div>
          <div className="rpc-sso-kpi">
            <div className="rpc-sso-kpi-label">Top edition FMV</div>
            <div className="rpc-sso-kpi-value">{fmtMoney(kpis.topFmv)}</div>
          </div>
        </section>

        <section className="rpc-sso-controls" aria-label="Filters">
          <div className="rpc-sso-pill-group" role="tablist" aria-label="Serial type">
            <span className="rpc-sso-pill-label">SERIAL</span>
            {TAGS.map((t) => (
              <button
                key={t.val}
                role="tab"
                aria-selected={tag === t.val}
                className={`rpc-sso-pill ${tag === t.val ? "rpc-sso-pill-active" : ""}`}
                onClick={() => setTag(t.val)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="rpc-sso-pill-group" role="tablist" aria-label="Tier">
            <span className="rpc-sso-pill-label">TIER</span>
            {TIERS.map((t) => (
              <button
                key={t.val}
                role="tab"
                aria-selected={tier === t.val}
                className={`rpc-sso-pill ${tier === t.val ? "rpc-sso-pill-active" : ""}`}
                onClick={() => setTier(t.val)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <label className="rpc-sso-search">
            <span className="rpc-sso-pill-label">PLAYER</span>
            <input
              value={playerInput}
              onChange={(e) => onPlayerChange(e.target.value)}
              placeholder="Search player…"
              className="rpc-sso-input"
            />
          </label>
          <label className="rpc-sso-sort">
            <span className="rpc-sso-pill-label">SORT</span>
            <select value={sort} onChange={(e) => setSort(e.target.value as OwnersSortKey)} className="rpc-sso-select">
              <option value="fmv">Edition FMV (desc)</option>
              <option value="recent">Most recently held</option>
            </select>
          </label>
        </section>

        <section className="rpc-sso-list-wrap" aria-label="Special serial owners">
          {error ? (
            <div className="rpc-sso-state">Failed to load: {error}</div>
          ) : loading ? (
            <div className="rpc-sso-state">Loading…</div>
          ) : rows.length === 0 ? (
            <div className="rpc-sso-state">No special serials match those filters.</div>
          ) : (
            <div className="rpc-sso-list">
              {rows.map((r, i) => {
                const href = editionHref(r);
                const title = r.player_name || r.set_name || "—";
                return (
                  <div className="rpc-sso-row" key={`${r.edition_id ?? r.edition_key ?? i}-${r.tag}-${r.serial}`}>
                    <div className="rpc-sso-rank">{i + 1}</div>
                    {href ? (
                      <Link href={href} className="rpc-sso-row-art" aria-label={title}><BoardImage r={r} /></Link>
                    ) : (
                      <div className="rpc-sso-row-art"><BoardImage r={r} /></div>
                    )}
                    <div className="rpc-sso-row-main">
                      {href ? (
                        <Link href={href} className="rpc-sso-row-name">{title}</Link>
                      ) : (
                        <span className="rpc-sso-row-name">{title}</span>
                      )}
                      <div className="rpc-sso-row-sub">
                        {r.set_name ? <span>{r.set_name}</span> : null}
                        <span className="rpc-sso-dot">·</span>
                        <span>{serialLabel(r)}</span>
                        <span className="rpc-sso-dot">·</span>
                        <span className="rpc-sso-tag">{tagLabel(r.tag)}</span>
                        {r.tier ? (
                          <>
                            <span className="rpc-sso-dot">·</span>
                            <span style={{ color: tierColor(r.tier) }}>{r.tier}</span>
                          </>
                        ) : null}
                      </div>
                    </div>
                    <div className="rpc-sso-row-holder">
                      <div className="rpc-sso-holder-label">Holder</div>
                      {r.holder_address ? (
                        <Link href={`/profile/${encodeURIComponent(r.holder_address)}`} className="rpc-sso-holder-link" title={r.holder_address}>
                          {r.holder_username ? `@${r.holder_username}` : truncAddr(r.holder_address)}
                        </Link>
                      ) : (
                        <span className="rpc-sso-holder-none">—</span>
                      )}
                    </div>
                    <div className="rpc-sso-row-fmv">
                      <div className="rpc-sso-fmv-label">Edition FMV</div>
                      <div className="rpc-sso-fmv-value">{fmtMoney(r.edition_fmv)}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className="rpc-sso-footer">
          <h3 className="rpc-sso-h3">What this board is</h3>
          <p>
            For every canonical Top Shot edition we identify three chase serials — the{" "}
            <strong>#1 mint</strong>, the <strong>perfect mint</strong> (the last serial, #N&nbsp;of&nbsp;N),
            and the <strong>jersey-match</strong> serial (the number worn in that moment) — and show the
            wallet currently holding each among the wallets RPC tracks. The FMV shown is the edition&apos;s
            cached fair-market value, not a serial-specific estimate. Per-serial last-sale detail lives on
            the edition page.
          </p>
        </section>
      </main>
      <SupportChatConnected />
    </div>
  );
}

const CSS = `
.rpc-sso-main { max-width: 1180px; margin: 0 auto; padding: 24px 16px 96px; font-family: var(--font-body); }
.rpc-sso-head { padding-bottom: 20px; border-bottom: 1px solid var(--rpc-border-subtle); margin-bottom: 22px; }
.rpc-sso-eyebrow { font-family: var(--font-mono); font-size: 12px; letter-spacing: 4px; text-transform: uppercase; color: var(--rpc-red); margin-bottom: 10px; }
.rpc-sso-title-row { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
.rpc-sso-h1 { font-family: var(--font-display); font-weight: 800; font-size: clamp(32px, 5vw, 52px); letter-spacing: 0.5px; line-height: 1.04; margin: 0 0 12px; text-transform: uppercase; }
.rpc-sso-back { font-family: var(--font-mono); font-size: 13px; color: var(--rpc-text-muted); text-decoration: none; }
.rpc-sso-back:hover { color: var(--rpc-red); }
.rpc-sso-lede { font-size: 16px; line-height: 1.55; color: var(--rpc-text-secondary); max-width: 820px; margin: 0; }
.rpc-sso-lede strong { color: var(--rpc-text-primary); }

.rpc-sso-kpi-row { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-bottom: 24px; }
.rpc-sso-kpi { border: 1px solid var(--rpc-border-subtle); background: var(--rpc-surface-raised); padding: 14px 16px; border-radius: 2px; }
.rpc-sso-kpi-label { font-family: var(--font-mono); font-size: 10px; letter-spacing: 2.5px; text-transform: uppercase; color: var(--rpc-text-muted); margin-bottom: 6px; }
.rpc-sso-kpi-value { font-family: var(--font-display); font-weight: 800; font-size: 30px; color: var(--rpc-red); letter-spacing: 0.5px; }

.rpc-sso-controls { display: flex; flex-wrap: wrap; gap: 14px 22px; align-items: center; margin-bottom: 20px; }
.rpc-sso-pill-group { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.rpc-sso-pill-label { font-family: var(--font-mono); font-size: 10px; letter-spacing: 2px; text-transform: uppercase; color: var(--rpc-text-muted); margin-right: 4px; }
.rpc-sso-pill { font-family: var(--font-mono); font-size: 12px; letter-spacing: 1.5px; text-transform: uppercase; padding: 7px 14px; border: 1px solid var(--rpc-border); background: transparent; color: var(--rpc-text-secondary); cursor: pointer; border-radius: 2px; transition: border-color 120ms, color 120ms, background 120ms; }
.rpc-sso-pill:hover { border-color: var(--rpc-border-hover); color: var(--rpc-text-primary); }
.rpc-sso-pill-active { background: var(--rpc-red-bg); border-color: var(--rpc-red); color: var(--rpc-red); }
.rpc-sso-search, .rpc-sso-sort { display: inline-flex; align-items: center; gap: 8px; }
.rpc-sso-input { font-family: var(--font-mono); font-size: 12px; background: transparent; border: 1px solid var(--rpc-border); color: var(--rpc-text-primary); padding: 7px 10px; border-radius: 2px; min-width: 160px; }
.rpc-sso-select { font-family: var(--font-mono); font-size: 12px; letter-spacing: 1px; background: transparent; border: 1px solid var(--rpc-border); color: var(--rpc-text-primary); padding: 7px 10px; border-radius: 2px; cursor: pointer; }

.rpc-sso-list-wrap { }
.rpc-sso-state { padding: 48px 32px; text-align: center; font-family: var(--font-mono); font-size: 13px; letter-spacing: 2px; text-transform: uppercase; color: var(--rpc-text-muted); border: 1px solid var(--rpc-border-subtle); background: var(--rpc-surface); border-radius: 2px; }
.rpc-sso-list { display: flex; flex-direction: column; gap: 8px; }
.rpc-sso-row { display: grid; grid-template-columns: 32px 52px minmax(0, 1fr) 130px 110px; align-items: center; gap: 14px; border: 1px solid var(--rpc-border-subtle); background: var(--rpc-surface); border-radius: 4px; padding: 10px 16px 10px 10px; transition: border-color 120ms, background 120ms; }
.rpc-sso-row:hover { border-color: var(--rpc-red); background: var(--rpc-surface-hover); }
.rpc-sso-rank { font-family: var(--font-mono); font-size: 13px; color: var(--rpc-text-muted); text-align: center; }
.rpc-sso-row-art { width: 52px; height: 52px; border-radius: 3px; overflow: hidden; background: var(--rpc-surface-raised); display: block; }
.rpc-sso-img { width: 100%; height: 100%; object-fit: cover; display: block; }
.rpc-sso-img-fallback { width: 100%; height: 100%; background: linear-gradient(135deg, var(--rpc-surface-raised), var(--rpc-surface)); }
.rpc-sso-row-main { min-width: 0; }
.rpc-sso-row-name { display: block; font-family: var(--font-body); font-weight: 700; font-size: 15px; line-height: 1.2; color: var(--rpc-text-primary); text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
a.rpc-sso-row-name:hover { color: var(--rpc-red); }
.rpc-sso-row-sub { font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.5px; color: var(--rpc-text-muted); display: flex; flex-wrap: wrap; gap: 6px; margin-top: 3px; }
.rpc-sso-dot { color: var(--rpc-text-ghost); }
.rpc-sso-tag { color: var(--rpc-red); }
.rpc-sso-row-holder, .rpc-sso-row-fmv { min-width: 0; }
.rpc-sso-holder-label, .rpc-sso-fmv-label { font-family: var(--font-mono); font-size: 9px; letter-spacing: 2px; text-transform: uppercase; color: var(--rpc-text-muted); margin-bottom: 4px; }
.rpc-sso-holder-link { font-family: var(--font-mono); font-size: 13px; color: var(--rpc-text-secondary); text-decoration: none; }
.rpc-sso-holder-link:hover { color: var(--rpc-red); }
.rpc-sso-holder-none { font-family: var(--font-mono); font-size: 13px; color: var(--rpc-text-ghost); }
.rpc-sso-fmv-value { font-family: var(--font-display); font-weight: 800; font-size: 20px; color: var(--rpc-text-primary); letter-spacing: 0.5px; }

.rpc-sso-footer { margin-top: 40px; padding-top: 24px; border-top: 1px solid var(--rpc-border-subtle); }
.rpc-sso-h3 { font-family: var(--font-display); font-weight: 800; font-size: 20px; letter-spacing: 1px; text-transform: uppercase; margin: 0 0 10px; }
.rpc-sso-footer p { font-size: 14px; line-height: 1.65; color: var(--rpc-text-secondary); max-width: 820px; margin: 0; }
.rpc-sso-footer strong { color: var(--rpc-text-primary); }

@media (max-width: 760px) {
  .rpc-sso-row { grid-template-columns: 24px 44px minmax(0, 1fr) 84px; }
  .rpc-sso-row-holder { display: none; }
}
`;
