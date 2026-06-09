"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { LEAGUES, type League, type TeamMaster, type UserFavoriteTeam } from "@/lib/teams";

const condensedFont = "var(--font-display)";
const monoFont = "var(--font-mono)";
const ACCENT_RED = "#E03A2F"; // brand-exception: hex literal persisted as accent_color data + parsed by hexToRgba — must stay hex, not a CSS var

type BioForm = {
  username: string;
  display_name: string;
  tagline: string;
  twitter: string;
  discord: string;
  avatar_url: string;
  accent_color: string;
};

const EMPTY: BioForm = {
  username: "",
  display_name: "",
  tagline: "",
  twitter: "",
  discord: "",
  avatar_url: "",
  accent_color: ACCENT_RED,
};

const USERNAME_RE = /^[a-z0-9_-]{3,32}$/;

// Per-league pick state. team_slug === "" means no team for that league.
type Pick = { team_slug: string; is_primary: boolean };
type PickMap = Record<League, Pick>;

const EMPTY_PICKS: PickMap = {
  NBA:    { team_slug: "", is_primary: false },
  WNBA:   { team_slug: "", is_primary: false },
  NFL:    { team_slug: "", is_primary: false },
  LALIGA: { team_slug: "", is_primary: false },
};

export default function EditProfilePage() {
  const [form, setForm] = useState<BioForm>(EMPTY);
  const [picks, setPicks] = useState<PickMap>(EMPTY_PICKS);
  const [teamOptions, setTeamOptions] = useState<Record<League, TeamMaster[] | null>>({
    NBA: null, WNBA: null, NFL: null, LALIGA: null,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load bio + existing favorite teams together. The bio fetch carries the
  // username, which is the ownerKey we need to hydrate the team picks via
  // /api/profile/teams. Both team-options fetches and the existing-picks
  // fetch run in parallel after we have the bio response.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const bioRes = await fetch("/api/profile/bio", { cache: "no-store" });
        const bioJson = bioRes.ok ? await bioRes.json() : null;
        const bio = bioJson?.bio;
        if (cancelled) return;
        if (bio) {
          setForm({
            username: bio.username ?? "",
            display_name: bio.display_name ?? "",
            tagline: bio.tagline ?? "",
            twitter: bio.twitter ?? "",
            discord: bio.discord ?? "",
            avatar_url: bio.avatar_url ?? "",
            accent_color: bio.accent_color ?? ACCENT_RED,
          });
        }

        // Fetch all four league dropdowns in parallel and cache. These are
        // public reference data, so no ownerKey required.
        const optionFetches = LEAGUES.map((l) =>
          fetch(`/api/teams?league=${l.value}`)
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => ({ league: l.value, teams: (d?.teams ?? []) as TeamMaster[] }))
            .catch(() => ({ league: l.value, teams: [] as TeamMaster[] }))
        );

        // Existing picks — only meaningful if the user has a username.
        const existingP = bio?.username
          ? fetch(`/api/profile/teams?ownerKey=${encodeURIComponent(bio.username)}`)
              .then((r) => (r.ok ? r.json() : null))
              .then((d) => (d?.teams ?? []) as UserFavoriteTeam[])
              .catch(() => [] as UserFavoriteTeam[])
          : Promise.resolve([] as UserFavoriteTeam[]);

        const [optionsResults, existing] = await Promise.all([
          Promise.all(optionFetches),
          existingP,
        ]);
        if (cancelled) return;

        setTeamOptions((prev) => {
          const next = { ...prev };
          for (const r of optionsResults) next[r.league] = r.teams;
          return next;
        });

        if (existing.length > 0) {
          setPicks((prev) => {
            const next = { ...prev };
            for (const t of existing) {
              next[t.league] = { team_slug: t.team_slug, is_primary: t.is_primary };
            }
            return next;
          });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function update<K extends keyof BioForm>(key: K, value: BioForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function setPickTeam(league: League, slug: string) {
    setPicks((prev) => {
      const next = { ...prev };
      // Empty selection wipes both the slug and the primary flag for that
      // league — you can't be "primary" on a team you didn't pick.
      next[league] = {
        team_slug: slug,
        is_primary: slug ? prev[league].is_primary : false,
      };
      return next;
    });
  }

  function setPickPrimary(league: League) {
    // Selecting primary on one league deselects it on the others. Empty
    // slugs cannot become primary.
    setPicks((prev) => {
      const next: PickMap = { ...prev };
      for (const l of LEAGUES) {
        next[l.value] = { ...prev[l.value], is_primary: false };
      }
      if (prev[league].team_slug) {
        next[league] = { ...prev[league], is_primary: true };
      }
      return next;
    });
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
      // Bio first — establishes/updates the username row used as the
      // ownerKey for the teams POST below.
      const bioRes = await fetch("/api/profile/bio", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: username || null,
          displayName: form.display_name.trim() || null,
          tagline: form.tagline.trim() || null,
          twitter: form.twitter.trim() || null,
          discord: form.discord.trim() || null,
          avatarUrl: form.avatar_url.trim() || null,
          accentColor: form.accent_color || ACCENT_RED,
        }),
      });
      if (!bioRes.ok) {
        const data = await bioRes.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${bioRes.status}`);
      }
      const bioJson = await bioRes.json().catch(() => ({}));
      const ownerKey = bioJson?.bio?.username ?? username;

      if (ownerKey) {
        const teamsArray = LEAGUES
          .map((l) => ({ league: l.value, ...picks[l.value] }))
          .filter((p) => !!p.team_slug)
          .map((p) => ({ league: p.league, team_slug: p.team_slug, is_primary: p.is_primary }));

        const teamsRes = await fetch("/api/profile/teams", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ownerKey, teams: teamsArray }),
        });
        if (!teamsRes.ok) {
          const data = await teamsRes.json().catch(() => ({}));
          throw new Error(data.error || `teams HTTP ${teamsRes.status}`);
        }
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

  // Memoize the chip preview list so the display strip below the form stays
  // in sync with the current (unsaved) picks.
  const chipPreviews = useMemo(() => {
    return LEAGUES
      .map((l) => {
        const pick = picks[l.value];
        if (!pick.team_slug) return null;
        const team = (teamOptions[l.value] ?? []).find((t) => t.slug === pick.team_slug);
        if (!team) return null;
        return {
          league: l.value,
          emoji: l.emoji,
          abbreviation: team.abbreviation,
          primary_color: team.primary_color,
          is_primary: pick.is_primary,
        };
      })
      .filter(Boolean) as Array<{
        league: League;
        emoji: string;
        abbreviation: string;
        primary_color: string;
        is_primary: boolean;
      }>;
  }, [picks, teamOptions]);

  return (
    <div style={{ minHeight: "100vh", background: "var(--rpc-black)", color: "var(--rpc-text-primary)", paddingBottom: 80 }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@400;600;700;800;900&family=Share+Tech+Mono&display=swap');
        *{box-sizing:border-box;margin:0;padding:0;}
        .field { display:flex; flex-direction:column; gap:6px; }
        .field label { font-family:${monoFont}; font-size:11px; color:rgba(255,255,255,0.7); letter-spacing:0.04em; text-transform:uppercase; }
        .field input, .field textarea, .field select { background:#0d0d0d; border:1px solid var(--rpc-border); color:var(--rpc-text-primary); padding:10px 12px; border-radius:6px; font-family:${monoFont}; font-size:13px; }
        .field input:focus, .field textarea:focus, .field select:focus { outline:none; border-color:var(--rpc-red); }
        .hint { font-family:${monoFont}; font-size:10px; color:rgba(255,255,255,0.4); }
        .team-row { display:grid; grid-template-columns: 28px 80px 1fr auto; gap:10px; align-items:center; }
        .team-row select { width:100%; }
        .team-row .league-emoji { font-size:18px; text-align:center; }
        .team-row .league-label { font-family:${monoFont}; font-size:11px; color:rgba(255,255,255,0.7); letter-spacing:0.06em; }
        .primary-radio { display:flex; align-items:center; gap:6px; font-family:${monoFont}; font-size:10px; color:rgba(255,255,255,0.6); letter-spacing:0.05em; cursor:pointer; }
        .primary-radio input { accent-color: var(--rpc-red); }
      `}</style>

      <main style={{ maxWidth: 720, margin: "0 auto", padding: "24px 24px 60px", display: "flex", flexDirection: "column", gap: 18 }}>
        <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <h1 style={{ fontFamily: condensedFont, fontWeight: 800, fontSize: 22, letterSpacing: "0.04em", textTransform: "uppercase" }}>
            Edit Profile
          </h1>
          <Link href="/dashboard" style={{ fontFamily: monoFont, fontSize: 12, color: "rgba(255,255,255,0.6)", textDecoration: "none" }}>
            ← Back to dashboard
          </Link>
        </header>

        {loading ? (
          <div style={{ fontFamily: monoFont, fontSize: 12, color: "rgba(255,255,255,0.5)" }}>Loading…</div>
        ) : (
          <section style={{ background: "var(--rpc-surface)", border: "1px solid var(--rpc-border)", borderRadius: 10, padding: "18px 18px 22px", display: "flex", flexDirection: "column", gap: 16 }}>
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
                Public URL: {publicUrl ? <code>rippackscity.com{publicUrl}</code> : "set a username to enable"}
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

            {/* Fan Affinity — replaces the old free-text favorite_team field. */}
            <div className="field">
              <label>Fan Affinity</label>
              <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "10px 0" }}>
                {LEAGUES.map((l) => {
                  const options = teamOptions[l.value] ?? [];
                  const pick = picks[l.value];
                  return (
                    <div key={l.value} className="team-row">
                      <span className="league-emoji" aria-hidden>{l.emoji}</span>
                      <span className="league-label">{l.label}</span>
                      <select
                        value={pick.team_slug}
                        onChange={(e) => setPickTeam(l.value, e.target.value)}
                        aria-label={`${l.label} favorite team`}
                      >
                        <option value="">— None —</option>
                        {options.map((t) => (
                          <option key={t.slug} value={t.slug}>
                            {t.team_name}{t.has_moments ? "" : " · no moments yet"}
                          </option>
                        ))}
                      </select>
                      <label className="primary-radio">
                        <input
                          type="radio"
                          name="primary-team"
                          checked={pick.is_primary}
                          disabled={!pick.team_slug}
                          onChange={() => setPickPrimary(l.value)}
                        />
                        Primary
                      </label>
                    </div>
                  );
                })}
              </div>
              {chipPreviews.length > 0 && (
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
                  {chipPreviews.map((c) => (
                    <span
                      key={c.league}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                        padding: "3px 8px",
                        borderRadius: 999,
                        fontFamily: monoFont,
                        fontSize: 10,
                        letterSpacing: "0.08em",
                        color: "var(--rpc-text-primary)",
                        background: "rgba(255,255,255,0.04)",
                        border: c.is_primary ? `1px solid ${c.primary_color}` : "1px solid var(--rpc-border)",
                      }}
                    >
                      <span aria-hidden>{c.emoji}</span>
                      <span>{c.abbreviation}</span>
                    </span>
                  ))}
                </div>
              )}
              <div className="hint">Pick your team in each league. Primary appears highlighted on your public profile.</div>
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
                  style={{ width: 60, height: 32, padding: 0, border: "1px solid var(--rpc-border)", borderRadius: 4, background: "#0d0d0d" }}
                />
                <code style={{ fontFamily: monoFont, fontSize: 12, color: "rgba(255,255,255,0.6)" }}>{form.accent_color}</code>
              </div>
            </div>

            {error && (
              <div style={{ color: "var(--rpc-danger)", fontFamily: monoFont, fontSize: 12 }}>{error}</div>
            )}
            {savedAt && !error && (
              <div style={{ color: "var(--rpc-success)", fontFamily: monoFont, fontSize: 12 }}>
                Saved at {new Date(savedAt).toLocaleTimeString()}
                {publicUrl && (
                  <>
                    {" — "}
                    <Link href={publicUrl} style={{ color: "var(--rpc-success)" }}>
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
                  background: "var(--rpc-red)",
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
