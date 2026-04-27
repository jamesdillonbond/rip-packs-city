"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

const condensedFont = "'Barlow Condensed', sans-serif";
const monoFont = "'Share Tech Mono', monospace";
const ACCENT_RED = "#E03A2F";

type BioForm = {
  username: string;
  display_name: string;
  tagline: string;
  favorite_team: string;
  twitter: string;
  discord: string;
  avatar_url: string;
  accent_color: string;
};

const EMPTY: BioForm = {
  username: "",
  display_name: "",
  tagline: "",
  favorite_team: "",
  twitter: "",
  discord: "",
  avatar_url: "",
  accent_color: ACCENT_RED,
};

const USERNAME_RE = /^[a-z0-9_-]{3,32}$/;

export default function EditProfilePage() {
  const [form, setForm] = useState<BioForm>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/profile/bio", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled) return;
        const bio = d?.bio;
        if (bio) {
          setForm({
            username: bio.username ?? "",
            display_name: bio.display_name ?? "",
            tagline: bio.tagline ?? "",
            favorite_team: bio.favorite_team ?? "",
            twitter: bio.twitter ?? "",
            discord: bio.discord ?? "",
            avatar_url: bio.avatar_url ?? "",
            accent_color: bio.accent_color ?? ACCENT_RED,
          });
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function update<K extends keyof BioForm>(key: K, value: BioForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function save() {
    setError(null);
    const username = form.username.trim().toLowerCase();
    if (username && !USERNAME_RE.test(username)) {
      setError("Username must be 3–32 chars, lowercase letters/numbers/_/- only.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/profile/bio", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: username || null,
          displayName: form.display_name.trim() || null,
          tagline: form.tagline.trim() || null,
          favoriteTeam: form.favorite_team.trim() || null,
          twitter: form.twitter.trim() || null,
          discord: form.discord.trim() || null,
          avatarUrl: form.avatar_url.trim() || null,
          accentColor: form.accent_color || ACCENT_RED,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      setSavedAt(new Date().toISOString());
    } catch (err: any) {
      setError(err?.message ?? "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  const publicUrl = form.username.trim()
    ? `/profile/${form.username.trim().toLowerCase()}`
    : null;

  return (
    <div style={{ minHeight: "100vh", background: "#080808", color: "#fff", paddingBottom: 80 }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@400;600;700;800;900&family=Share+Tech+Mono&display=swap');
        *{box-sizing:border-box;margin:0;padding:0;}
        .field { display:flex; flex-direction:column; gap:6px; }
        .field label { font-family:${monoFont}; font-size:11px; color:rgba(255,255,255,0.7); letter-spacing:0.04em; text-transform:uppercase; }
        .field input, .field textarea { background:#0d0d0d; border:1px solid #27272a; color:#fff; padding:10px 12px; border-radius:6px; font-family:${monoFont}; font-size:13px; }
        .field input:focus, .field textarea:focus { outline:none; border-color:${ACCENT_RED}; }
        .hint { font-family:${monoFont}; font-size:10px; color:rgba(255,255,255,0.4); }
      `}</style>

      <main style={{ maxWidth: 720, margin: "0 auto", padding: "24px 24px 60px", display: "flex", flexDirection: "column", gap: 18 }}>
        <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <h1 style={{ fontFamily: condensedFont, fontWeight: 800, fontSize: 22, letterSpacing: "0.04em", textTransform: "uppercase" }}>
            Edit Profile
          </h1>
          <Link href="/profile" style={{ fontFamily: monoFont, fontSize: 12, color: "rgba(255,255,255,0.6)", textDecoration: "none" }}>
            ← Back to profile
          </Link>
        </header>

        {loading ? (
          <div style={{ fontFamily: monoFont, fontSize: 12, color: "rgba(255,255,255,0.5)" }}>Loading…</div>
        ) : (
          <section style={{ background: "#18181b", border: "1px solid #27272a", borderRadius: 10, padding: "18px 18px 22px", display: "flex", flexDirection: "column", gap: 16 }}>
            <div className="field">
              <label htmlFor="username">Public username</label>
              <input
                id="username"
                value={form.username}
                onChange={(e) => update("username", e.target.value)}
                placeholder="jamesdillonbond"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
              />
              <div className="hint">
                Public URL: {publicUrl ? <code>rip-packs-city.vercel.app{publicUrl}</code> : "set a username to enable"}
              </div>
            </div>

            <div className="field">
              <label htmlFor="display_name">Display name</label>
              <input
                id="display_name"
                value={form.display_name}
                onChange={(e) => update("display_name", e.target.value)}
                placeholder="Your name as it appears on the public profile"
              />
            </div>

            <div className="field">
              <label htmlFor="tagline">Tagline / bio</label>
              <textarea
                id="tagline"
                value={form.tagline}
                onChange={(e) => update("tagline", e.target.value)}
                placeholder="A short line about you and your collection"
                rows={3}
                maxLength={280}
              />
              <div className="hint">{form.tagline.length}/280</div>
            </div>

            <div className="field">
              <label htmlFor="favorite_team">Favorite team</label>
              <input
                id="favorite_team"
                value={form.favorite_team}
                onChange={(e) => update("favorite_team", e.target.value)}
                placeholder="Portland Trail Blazers"
              />
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div className="field">
                <label htmlFor="twitter">Twitter / X handle</label>
                <input
                  id="twitter"
                  value={form.twitter}
                  onChange={(e) => update("twitter", e.target.value)}
                  placeholder="@handle"
                />
              </div>
              <div className="field">
                <label htmlFor="discord">Discord</label>
                <input
                  id="discord"
                  value={form.discord}
                  onChange={(e) => update("discord", e.target.value)}
                  placeholder="username"
                />
              </div>
            </div>

            <div className="field">
              <label htmlFor="avatar_url">Avatar URL (optional)</label>
              <input
                id="avatar_url"
                value={form.avatar_url}
                onChange={(e) => update("avatar_url", e.target.value)}
                placeholder="https://..."
              />
            </div>

            <div className="field">
              <label htmlFor="accent_color">Accent color</label>
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <input
                  id="accent_color"
                  type="color"
                  value={form.accent_color}
                  onChange={(e) => update("accent_color", e.target.value)}
                  style={{ width: 60, height: 32, padding: 0, border: "1px solid #27272a", borderRadius: 4, background: "#0d0d0d" }}
                />
                <code style={{ fontFamily: monoFont, fontSize: 12, color: "rgba(255,255,255,0.6)" }}>{form.accent_color}</code>
              </div>
            </div>

            {error && (
              <div style={{ color: "#F87171", fontFamily: monoFont, fontSize: 12 }}>{error}</div>
            )}
            {savedAt && !error && (
              <div style={{ color: "#34D399", fontFamily: monoFont, fontSize: 12 }}>
                Saved at {new Date(savedAt).toLocaleTimeString()}
                {publicUrl && (
                  <>
                    {" — "}
                    <Link href={publicUrl} style={{ color: "#34D399" }}>
                      View public profile →
                    </Link>
                  </>
                )}
              </div>
            )}

            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button
                onClick={save}
                disabled={saving}
                style={{
                  fontFamily: condensedFont,
                  fontWeight: 700,
                  fontSize: 13,
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                  padding: "10px 22px",
                  background: ACCENT_RED,
                  color: "#fff",
                  border: "none",
                  borderRadius: 6,
                  cursor: saving ? "not-allowed" : "pointer",
                  opacity: saving ? 0.6 : 1,
                }}
              >
                {saving ? "Saving…" : "Save profile"}
              </button>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
