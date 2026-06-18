"use client";

// app/alerts/page.tsx
//
// Auth-gated alerts hub. Create deal subscriptions, link delivery channels
// (email / Telegram / Discord), and preview matching deals live. The client
// never sends a user id — owner_key is resolved server-side from the session.
//
// NOT in proxy.ts isPublicPath() by design — it must require login.

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import MobileNav from "@/components/MobileNav";
import SupportChatConnected from "@/components/SupportChatConnected";

const DISPLAY = "var(--font-display)";
const MONO = "var(--font-mono)";
const RED = "var(--rpc-red)";

// Deal board collections (slug -> UUID). TS + Pinnacle are what the board
// carries today; the rest are wired for when they get a deal feed.
const COLLECTIONS: { slug: string; id: string; name: string }[] = [
  { slug: "nba_top_shot", id: "95f28a17-224a-4025-96ad-adf8a4c63bfd", name: "NBA Top Shot" },
  { slug: "disney_pinnacle", id: "7dd9dd11-e8b6-45c4-ac99-71331f959714", name: "Disney Pinnacle" },
];
const TS_TIERS = ["COMMON", "FANDOM", "RARE", "LEGENDARY"];
// Parallel / variant filter. Top Shot's formal parallels are rare special
// treatments (almost every TS edition is base); Disney Pinnacle's variant is its
// core concept and is the main use of this filter. Values match what's shown in
// the alert line.
const PARALLELS = [
  "Galactic", "Diced", // Top Shot
  "Silver Sparkle", "Digital Display", "Golden", "Luxe Marble", "Brushed Silver",
  "Embellished Enamel", "Colored Enamel", "Color Splash", "Radiant Chrome",
  "Apex", "Genesis", "Xenith", "Quartis", "Quinova", "Standard", // Disney Pinnacle
];
// Real Top Shot edition badge slugs (saved now; enforced once the live
// per-serial listing feed lands — see the "applies to live listings" note).
const BADGES = [
  { slug: "topshotdebut", label: "Top Shot Debut" },
  { slug: "rookieyear", label: "Rookie Year" },
  { slug: "rookiemint", label: "Rookie Mint" },
  { slug: "rookiepremiere", label: "Rookie Premiere" },
  { slug: "mvpyear", label: "MVP Year" },
  { slug: "championshipyear", label: "Championship Year" },
  { slug: "allstar", label: "All-Star" },
];
type ChannelName = "email" | "telegram" | "discord";
const CHANNEL_META: { name: ChannelName; label: string }[] = [
  { name: "email", label: "Email" },
  { name: "telegram", label: "Telegram" },
  { name: "discord", label: "Discord" },
];

interface ChannelState {
  channel: ChannelName;
  verified: boolean;
  username: string | null;
  target: string | null;
}
interface Subscription {
  id: string;
  label: string;
  channels: ChannelName[];
  collection_ids: string[] | null;
  min_discount: number;
  min_price: number | null;
  max_price: number | null;
  tiers: string[] | null;
  parallel_names: string[] | null;
  player_names: string[] | null;
  set_names: string[] | null;
  team_names: string[] | null;
  min_serial: number | null;
  max_serial: number | null;
  require_jersey_serial: boolean;
  require_last_mint: boolean;
  require_never_sold: boolean;
  require_low_ask: boolean;
  badges: string[] | null;
  cadence: "instant" | "daily" | "weekly";
  active: boolean;
  preview_count: number | null;
}

// Per-edition FMV alerts ("watch this edition"), created from the moment /
// edition pages and managed here. Backed by /api/alerts (fmv_alerts).
interface FmvAlert {
  id: number;
  edition_key: string;
  collection_id: string | null;
  player_name: string | null;
  set_name: string | null;
  alert_type: "price_below" | "fmv_below" | "fmv_above" | "discount_above";
  threshold: number;
  channel: string;
  active: boolean;
  fmv: number | null;
  low_ask: number | null;
  currently_triggered: boolean;
}

const FMV_ALERT_LABEL: Record<FmvAlert["alert_type"], (t: number) => string> = {
  price_below: (t) => `Ask ≤ $${t}`,
  fmv_below: (t) => `FMV ≤ $${t}`,
  fmv_above: (t) => `FMV ≥ $${t}`,
  discount_above: (t) => `Ask ≥ ${t}% below FMV`,
};

// collection UUID -> entity-page URL slug (the editions+fmv_snapshots
// collections the watch button is offered on).
const COLLECTION_URL_SLUG: Record<string, string> = {
  "95f28a17-224a-4025-96ad-adf8a4c63bfd": "nba-top-shot",
  "dee28451-5d62-409e-a1ad-a83f763ac070": "nfl-all-day",
  "06248cc4-b85f-47cd-af67-1855d14acd75": "laliga-golazos",
  "9b4824a8-736d-4a96-b450-8dcc0c46b023": "ufc-strike",
};
function editionHref(a: FmvAlert): string {
  const slug = COLLECTION_URL_SLUG[a.collection_id ?? ""] ?? "nba-top-shot";
  return `/${slug}/edition/${encodeURIComponent(a.edition_key)}`;
}

interface FormState {
  id: string | null;
  label: string;
  channels: ChannelName[];
  collection_ids: string[];
  min_discount: string;
  min_price: string;
  max_price: string;
  tiers: string[];
  parallel_names: string[];
  player_names: string;
  set_names: string;
  team_names: string;
  min_serial: string;
  max_serial: string;
  require_jersey_serial: boolean;
  require_last_mint: boolean;
  require_never_sold: boolean;
  require_low_ask: boolean;
  badges: string[];
  cadence: "instant" | "daily" | "weekly";
}

const EMPTY_FORM: FormState = {
  id: null,
  label: "My deal alert",
  channels: ["email"],
  collection_ids: [],
  min_discount: "25",
  min_price: "",
  max_price: "",
  tiers: [],
  parallel_names: [],
  player_names: "",
  set_names: "",
  team_names: "",
  min_serial: "",
  max_serial: "",
  require_jersey_serial: false,
  require_last_mint: false,
  require_never_sold: false,
  require_low_ask: false,
  badges: [],
  cadence: "instant",
};

function csvToArr(s: string): string[] {
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}
function arrToCsv(a: string[] | null): string {
  return (a ?? []).join(", ");
}
function toggle<T>(list: T[], v: T): T[] {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
}

export default function AlertsPage() {
  const [channels, setChannels] = useState<ChannelState[]>([]);
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [fmvAlerts, setFmvAlerts] = useState<FmvAlert[]>([]);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [linkInfo, setLinkInfo] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [chRes, subRes, fmvRes] = await Promise.all([
        fetch("/api/alerts/channels"),
        fetch("/api/alerts/subscriptions"),
        fetch("/api/alerts"),
      ]);
      if (chRes.ok) setChannels((await chRes.json()).channels ?? []);
      if (subRes.ok) setSubs((await subRes.json()).subscriptions ?? []);
      if (fmvRes.ok) {
        const j = await fmvRes.json();
        setFmvAlerts(Array.isArray(j) ? j : []);
      }
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const channelStatus = useCallback(
    (name: ChannelName): ChannelState | undefined => channels.find((c) => c.channel === name),
    [channels]
  );

  async function startLink(channel: ChannelName) {
    setMsg(null);
    try {
      const res = await fetch("/api/alerts/channels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMsg(data.error ?? "Could not start link");
        return;
      }
      if (channel === "email") {
        setLinkInfo((p) => ({ ...p, email: data.message }));
      } else {
        const detail = [data.instruction, data.deep_link ? `Open: ${data.deep_link}` : ""]
          .filter(Boolean)
          .join("  •  ");
        setLinkInfo((p) => ({ ...p, [channel]: detail }));
      }
    } catch {
      setMsg("Network error starting link");
    }
  }

  async function unlink(channel: ChannelName) {
    await fetch(`/api/alerts/channels?channel=${channel}`, { method: "DELETE" });
    setLinkInfo((p) => ({ ...p, [channel]: "" }));
    load();
  }

  function payloadFromForm() {
    return {
      id: form.id ?? undefined,
      label: form.label,
      channels: form.channels,
      collection_ids: form.collection_ids.length ? form.collection_ids : null,
      min_discount: form.min_discount === "" ? 25 : Number(form.min_discount),
      min_price: form.min_price === "" ? null : Number(form.min_price),
      max_price: form.max_price === "" ? null : Number(form.max_price),
      tiers: form.tiers.length ? form.tiers : null,
      parallel_names: form.parallel_names.length ? form.parallel_names : null,
      player_names: csvToArr(form.player_names),
      set_names: csvToArr(form.set_names),
      team_names: csvToArr(form.team_names),
      min_serial: form.min_serial === "" ? null : Number(form.min_serial),
      max_serial: form.max_serial === "" ? null : Number(form.max_serial),
      require_jersey_serial: form.require_jersey_serial,
      require_last_mint: form.require_last_mint,
      require_never_sold: form.require_never_sold,
      require_low_ask: form.require_low_ask,
      badges: form.badges.length ? form.badges : null,
      cadence: form.cadence,
    };
  }

  async function save() {
    if (form.channels.length === 0) {
      setMsg("Pick at least one delivery channel.");
      return;
    }
    setSaving(true);
    setMsg(null);
    try {
      const res = await fetch("/api/alerts/subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payloadFromForm()),
      });
      const data = await res.json();
      if (!res.ok) {
        setMsg(data.error ?? "Could not save");
        return;
      }
      setForm(EMPTY_FORM);
      setMsg(
        data.subscription?.preview_count != null
          ? `Saved. ${data.subscription.preview_count} deal(s) match right now.`
          : "Saved."
      );
      load();
    } catch {
      setMsg("Network error saving");
    } finally {
      setSaving(false);
    }
  }

  function editSub(s: Subscription) {
    setForm({
      id: s.id,
      label: s.label,
      channels: s.channels,
      collection_ids: s.collection_ids ?? [],
      min_discount: String(s.min_discount ?? 25),
      min_price: s.min_price != null ? String(s.min_price) : "",
      max_price: s.max_price != null ? String(s.max_price) : "",
      tiers: s.tiers ?? [],
      parallel_names: s.parallel_names ?? [],
      player_names: arrToCsv(s.player_names),
      set_names: arrToCsv(s.set_names),
      team_names: arrToCsv(s.team_names),
      min_serial: s.min_serial != null ? String(s.min_serial) : "",
      max_serial: s.max_serial != null ? String(s.max_serial) : "",
      require_jersey_serial: s.require_jersey_serial,
      require_last_mint: s.require_last_mint,
      require_never_sold: s.require_never_sold,
      require_low_ask: s.require_low_ask,
      badges: s.badges ?? [],
      cadence: s.cadence,
    });
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function toggleActive(s: Subscription) {
    await fetch("/api/alerts/subscriptions", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: s.id, active: !s.active }),
    });
    load();
  }

  async function removeSub(s: Subscription) {
    if (!confirm(`Delete "${s.label}"?`)) return;
    await fetch(`/api/alerts/subscriptions?id=${s.id}`, { method: "DELETE" });
    if (form.id === s.id) setForm(EMPTY_FORM);
    load();
  }

  async function removeFmvAlert(a: FmvAlert) {
    if (!confirm(`Stop watching ${a.player_name ?? a.edition_key}?`)) return;
    await fetch(`/api/alerts?id=${a.id}`, { method: "DELETE" });
    load();
  }

  const anyLiveListingFilter = useMemo(
    () =>
      form.require_jersey_serial ||
      form.require_last_mint ||
      form.require_never_sold ||
      form.min_serial !== "" ||
      form.max_serial !== "",
    [form]
  );

  return (
    <div style={{ minHeight: "100vh", background: "var(--rpc-black)", color: "#fafafa" }}>
      <MobileNav />
      <main style={{ maxWidth: 880, margin: "0 auto", padding: "24px 16px 96px" }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <h1 style={{ fontFamily: DISPLAY, fontSize: 30, letterSpacing: "0.04em", textTransform: "uppercase", margin: 0 }}>
            Alerts
          </h1>
          <Link href="/dashboard" style={{ color: "rgba(255,255,255,0.6)", fontSize: 13, textDecoration: "none" }}>
            ← Dashboard
          </Link>
        </div>
        <p style={{ color: "rgba(255,255,255,0.6)", fontSize: 14, marginTop: 4, lineHeight: 1.5 }}>
          Get notified when a listing drops below FMV. Match by player, set, team, tier, price, and discount —
          delivered to email, Telegram, or Discord.
        </p>

        {msg && (
          <div style={{ marginTop: 12, padding: "10px 14px", borderRadius: 8, background: "rgba(224,58,47,0.12)", border: `1px solid ${RED}`, fontSize: 13 }}>
            {msg}
          </div>
        )}

        {/* ── Delivery channels ─────────────────────────────────────────── */}
        <section style={cardStyle}>
          <h2 style={h2Style}>Delivery channels</h2>
          <div style={{ display: "grid", gap: 10 }}>
            {CHANNEL_META.map(({ name, label }) => {
              const st = channelStatus(name);
              return (
                <div key={name} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                  <div>
                    <span style={{ fontWeight: 700 }}>{label}</span>{" "}
                    {st?.verified ? (
                      <span style={{ color: "#34d399", fontSize: 12, fontFamily: MONO }}>
                        ✓ linked {st.target ? `(${st.target})` : ""}
                      </span>
                    ) : (
                      <span style={{ color: "rgba(255,255,255,0.45)", fontSize: 12 }}>not linked</span>
                    )}
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    {st?.verified ? (
                      <button onClick={() => unlink(name)} style={btnGhost}>Unlink</button>
                    ) : (
                      <button onClick={() => startLink(name)} style={btnGhost}>Link {label}</button>
                    )}
                  </div>
                  {linkInfo[name] && (
                    <div style={{ flexBasis: "100%", fontSize: 12, color: "rgba(255,255,255,0.7)", fontFamily: MONO, wordBreak: "break-all" }}>
                      {linkInfo[name]}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        {/* ── Subscription form ─────────────────────────────────────────── */}
        <section style={cardStyle}>
          <h2 style={h2Style}>{form.id ? "Edit alert" : "New alert"}</h2>

          <label style={labelStyle}>Name</label>
          <input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} style={inputStyle} />

          <label style={labelStyle}>Deliver to</label>
          <div style={chipRow}>
            {CHANNEL_META.map(({ name, label }) => (
              <Chip key={name} on={form.channels.includes(name)} onClick={() => setForm({ ...form, channels: toggle(form.channels, name) })}>
                {label}
              </Chip>
            ))}
          </div>

          <label style={labelStyle}>Collections (none = all)</label>
          <div style={chipRow}>
            {COLLECTIONS.map((c) => (
              <Chip key={c.id} on={form.collection_ids.includes(c.id)} onClick={() => setForm({ ...form, collection_ids: toggle(form.collection_ids, c.id) })}>
                {c.name}
              </Chip>
            ))}
          </div>

          <div style={grid2}>
            <div>
              <label style={labelStyle}>Min discount % below FMV</label>
              <input type="number" min={0} value={form.min_discount} onChange={(e) => setForm({ ...form, min_discount: e.target.value })} style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>Cadence</label>
              <select value={form.cadence} onChange={(e) => setForm({ ...form, cadence: e.target.value as FormState["cadence"] })} style={inputStyle}>
                <option value="instant">Instant</option>
                <option value="daily">Daily digest</option>
                <option value="weekly">Weekly digest</option>
              </select>
            </div>
          </div>

          <div style={grid2}>
            <div>
              <label style={labelStyle}>Min price $</label>
              <input type="number" min={0} value={form.min_price} onChange={(e) => setForm({ ...form, min_price: e.target.value })} style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>Max price $</label>
              <input type="number" min={0} value={form.max_price} onChange={(e) => setForm({ ...form, max_price: e.target.value })} style={inputStyle} />
            </div>
          </div>

          <label style={labelStyle}>Tiers (Top Shot)</label>
          <div style={chipRow}>
            {TS_TIERS.map((t) => (
              <Chip key={t} on={form.tiers.includes(t)} onClick={() => setForm({ ...form, tiers: toggle(form.tiers, t) })}>
                {t}
              </Chip>
            ))}
          </div>

          <label style={labelStyle}>Parallel / variant (Pinnacle variants · rare Top Shot parallels)</label>
          <div style={chipRow}>
            {PARALLELS.map((p) => (
              <Chip key={p} on={form.parallel_names.includes(p)} onClick={() => setForm({ ...form, parallel_names: toggle(form.parallel_names, p) })}>
                {p}
              </Chip>
            ))}
          </div>

          <div style={grid2}>
            <div>
              <label style={labelStyle}>Players (comma-separated)</label>
              <input value={form.player_names} onChange={(e) => setForm({ ...form, player_names: e.target.value })} placeholder="LeBron James, Victor Wembanyama" style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>Sets (comma-separated)</label>
              <input value={form.set_names} onChange={(e) => setForm({ ...form, set_names: e.target.value })} placeholder="Base Set, Metallic Gold LE" style={inputStyle} />
            </div>
          </div>

          <label style={labelStyle}>Teams (comma-separated)</label>
          <input value={form.team_names} onChange={(e) => setForm({ ...form, team_names: e.target.value })} placeholder="Los Angeles Lakers" style={inputStyle} />

          {/* Live-listing-only filters — saved now, enforced once the per-serial feed lands */}
          <div style={{ marginTop: 16, paddingTop: 12, borderTop: "1px solid #27272a" }}>
            <div style={{ fontSize: 11, letterSpacing: "0.16em", textTransform: "uppercase", color: "rgba(255,255,255,0.45)", fontWeight: 700 }}>
              Serial & live-listing filters
            </div>
            <div style={grid2}>
              <div>
                <label style={labelStyle}>Min serial</label>
                <input type="number" min={0} value={form.min_serial} onChange={(e) => setForm({ ...form, min_serial: e.target.value })} style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Max serial</label>
                <input type="number" min={0} value={form.max_serial} onChange={(e) => setForm({ ...form, max_serial: e.target.value })} style={inputStyle} />
              </div>
            </div>
            <div style={chipRow}>
              <Chip on={form.require_jersey_serial} onClick={() => setForm({ ...form, require_jersey_serial: !form.require_jersey_serial })}>Jersey serial</Chip>
              <Chip on={form.require_last_mint} onClick={() => setForm({ ...form, require_last_mint: !form.require_last_mint })}>Last mint</Chip>
              <Chip on={form.require_never_sold} onClick={() => setForm({ ...form, require_never_sold: !form.require_never_sold })}>Never sold</Chip>
            </div>
            <label style={labelStyle}>Badges</label>
            <div style={chipRow}>
              {BADGES.map((b) => (
                <Chip key={b.slug} on={form.badges.includes(b.slug)} onClick={() => setForm({ ...form, badges: toggle(form.badges, b.slug) })}>
                  {b.label}
                </Chip>
              ))}
            </div>
            {anyLiveListingFilter && (
              <p style={{ fontSize: 12, color: "rgba(255,255,255,0.55)", marginTop: 8, lineHeight: 1.5 }}>
                Serial, jersey, last-mint, never-sold and badge filters apply to the per-serial underpriced-deals
                feed. The jersey filter matches the number worn in that specific moment (Top Shot&apos;s own
                jersey-match), indexed for ~6 in 10 editions today.
              </p>
            )}
          </div>

          <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
            <button onClick={save} disabled={saving} style={btnPrimary}>
              {saving ? "Saving…" : form.id ? "Update alert" : "Create alert"}
            </button>
            {form.id && (
              <button onClick={() => setForm(EMPTY_FORM)} style={btnGhost}>Cancel</button>
            )}
          </div>
        </section>

        {/* ── Existing subscriptions ────────────────────────────────────── */}
        <section style={{ marginTop: 24 }}>
          <h2 style={h2Style}>Your alerts</h2>
          {loading ? (
            <p style={{ color: "rgba(255,255,255,0.5)" }}>Loading…</p>
          ) : subs.length === 0 ? (
            <p style={{ color: "rgba(255,255,255,0.5)" }}>No alerts yet. Create one above.</p>
          ) : (
            <div style={{ display: "grid", gap: 10 }}>
              {subs.map((s) => (
                <div key={s.id} style={{ ...cardStyle, marginTop: 0, opacity: s.active ? 1 : 0.55 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                    <div>
                      <div style={{ fontWeight: 800, fontSize: 16 }}>{s.label}</div>
                      <div style={{ fontSize: 12, color: "rgba(255,255,255,0.55)", fontFamily: MONO, marginTop: 2 }}>
                        ≥{s.min_discount}% off · {s.channels.join(", ")} · {s.cadence}
                        {s.preview_count != null && ` · ${s.preview_count} match now`}
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button onClick={() => editSub(s)} style={btnGhost}>Edit</button>
                      <button onClick={() => toggleActive(s)} style={btnGhost}>{s.active ? "Pause" : "Resume"}</button>
                      <button onClick={() => removeSub(s)} style={{ ...btnGhost, color: RED }}>Delete</button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* ── Watched editions (per-edition FMV alerts) ─────────────────── */}
        <section style={{ marginTop: 24 }}>
          <h2 style={h2Style}>Watched editions</h2>
          <p style={{ color: "rgba(255,255,255,0.55)", fontSize: 13, marginTop: -6, marginBottom: 12, lineHeight: 1.5 }}>
            Watch a specific edition for a target price or FMV. Add one from any moment or edition page
            with the “Watch this edition” button.
          </p>
          {loading ? (
            <p style={{ color: "rgba(255,255,255,0.5)" }}>Loading…</p>
          ) : fmvAlerts.length === 0 ? (
            <p style={{ color: "rgba(255,255,255,0.5)" }}>No watched editions yet.</p>
          ) : (
            <div style={{ display: "grid", gap: 10 }}>
              {fmvAlerts.map((a) => (
                <div key={a.id} style={{ ...cardStyle, marginTop: 0, opacity: a.active ? 1 : 0.55 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                    <div>
                      <div style={{ fontWeight: 800, fontSize: 15 }}>
                        {a.player_name ?? a.edition_key}
                        {a.set_name ? <span style={{ color: "rgba(255,255,255,0.5)", fontWeight: 500 }}>{" "}· {a.set_name}</span> : null}
                      </div>
                      <div style={{ fontSize: 12, color: "rgba(255,255,255,0.55)", fontFamily: MONO, marginTop: 2 }}>
                        {FMV_ALERT_LABEL[a.alert_type](a.threshold)} · {a.channel}
                        {a.fmv != null && <> · FMV ${a.fmv}</>}
                        {a.low_ask != null && <> · ask ${a.low_ask}</>}
                        {a.currently_triggered && (
                          <span style={{ color: "#34d399", fontWeight: 700 }}> · triggered now</span>
                        )}
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <Link href={editionHref(a)} style={{ ...btnGhost, textDecoration: "none" }}>View</Link>
                      <button onClick={() => removeFmvAlert(a)} style={{ ...btnGhost, color: RED }}>Delete</button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </main>
      <SupportChatConnected />
    </div>
  );
}

// ── Styles + small components ─────────────────────────────────────────────
const cardStyle: React.CSSProperties = {
  marginTop: 20,
  padding: 20,
  background: "#18181b",
  border: "1px solid #27272a",
  borderRadius: 14,
};
const h2Style: React.CSSProperties = {
  fontFamily: DISPLAY,
  fontSize: 18,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  margin: "0 0 14px 0",
};
const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 12,
  color: "rgba(255,255,255,0.6)",
  margin: "12px 0 4px",
};
const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  background: "#0a0a0a",
  border: "1px solid #27272a",
  borderRadius: 8,
  color: "#fafafa",
  fontSize: 14,
  fontFamily: MONO,
  boxSizing: "border-box",
};
const grid2: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(2, minmax(0,1fr))", gap: 12 };
const chipRow: React.CSSProperties = { display: "flex", flexWrap: "wrap", gap: 8, marginTop: 4 };
const btnPrimary: React.CSSProperties = {
  padding: "11px 22px",
  background: RED,
  color: "#0a0a0a",
  border: "none",
  borderRadius: 8,
  fontWeight: 800,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  fontSize: 13,
  cursor: "pointer",
};
const btnGhost: React.CSSProperties = {
  padding: "8px 14px",
  background: "transparent",
  color: "rgba(255,255,255,0.8)",
  border: "1px solid #3f3f46",
  borderRadius: 8,
  fontSize: 13,
  cursor: "pointer",
};

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: "7px 14px",
        borderRadius: 999,
        border: `1px solid ${on ? RED : "#3f3f46"}`,
        background: on ? "rgba(224,58,47,0.15)" : "transparent",
        color: on ? "#fafafa" : "rgba(255,255,255,0.7)",
        fontSize: 13,
        fontWeight: on ? 700 : 500,
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}
