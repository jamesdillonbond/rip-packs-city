"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { LEAGUES, type League, type TeamMaster, type UserFavoriteTeam } from "@/lib/teams";
import ProfileHeaderPreview from "@/components/profile/ProfileHeaderPreview";
import { avatarUrlWarning } from "@/lib/profile/avatar-url";
import AvatarMomentPicker from "@/components/profile/AvatarMomentPicker";

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
  /** Equipped at /rewards, read-only here — the preview needs them to be
   *  truthful, and a preview that disagrees with the page is worse than none. */
  equipped_border: string | null;
  equipped_banner: string | null;
};

const EMPTY: BioForm = {
  username: "",
  display_name: "",
  tagline: "",
  twitter: "",
  discord: "",
  avatar_url: "",
  accent_color: ACCENT_RED,
  equipped_border: null,
  equipped_banner: null,
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

export default function ProfileEditClient() {
  const [form, setForm] = useState<BioForm>(EMPTY);
  const [picks, setPicks] = useState<PickMap>(EMPTY_PICKS);
  const [teamOptions, setTeamOptions] = useState<Record<League, TeamMaster[] | null>>({
    NBA: null, WNBA: null, NFL: null, LALIGA: null,
  });
  const [loading, setLoading] = useState(true);
  /**
   * ⚠ NOT cosmetic, and not the same thing as `error` (which reports a failed
   * SAVE). Without it a failed READ left the form at its EMPTY initial state
   * and rendered it as an editable profile, so a collector who changed one
   * field and hit Save would POST nulls over their display name, tagline,
   * socials and avatar — `save()` sends every field unconditionally. The
   * failure is not "we showed you the wrong thing", it is "we deleted your
   * profile because you trusted what we showed you".
   */
  const [loadFailed, setLoadFailed] = useState(false);
  /**
   * ⚠ Tracked SEPARATELY, because it is a second and independent loss vector:
   * the teams POST sends the full list, so an empty `picks` map wipes every
   * favourite team — which is exactly what /my-teams reads. A failed teams
   * read used to `.catch(() => [])`, indistinguishable from "no favourites".
   */
  const [teamsLoadFailed, setTeamsLoadFailed] = useState(false);
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
        if (!bioRes.ok) {
          // ⚠ A failed read is NOT an empty profile. Falling through would hand
          // the user a blank editable form over their real data.
          if (!cancelled) setLoadFailed(true);
          return;
        }
        const bioJson = await bioRes.json();
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
            equipped_border: bio.equipped_border ?? null,
            equipped_banner: bio.equipped_banner ?? null,
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
        const existingP: Promise<UserFavoriteTeam[] | null> = bio?.username
          ? fetch(`/api/profile/teams?ownerKey=${encodeURIComponent(bio.username)}`)
              // ⚠ `null` means WE COULD NOT READ; `[]` means "no favourites".
              // Collapsing them is what let a failed read wipe the user's teams
              // on the next save.
              .then((r) => (r.ok ? r.json() : null))
              .then((d) => (d ? ((d.teams ?? []) as UserFavoriteTeam[]) : null))
              .catch(() => null)
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

        if (existing === null) setTeamsLoadFailed(true);
        if (existing && existing.length > 0) {
          setPicks((prev) => {
            const next = { ...prev };
            for (const t of existing) {
              next[t.league] = { team_slug: t.team_slug, is_primary: t.is_primary };
            }
            return next;
          });
        }
      } catch {
        // ⚠ REQUIRED, not defensive. `fetch` THROWS on a network failure rather
        // than resolving non-ok, and without this the rejection escaped the
        // effect while `loading` still went false in the `finally` — rendering
        // the same blank editable form the !ok branch above exists to prevent.
        if (!cancelled) setLoadFailed(true);
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

  /**
   * What (if anything) is wrong with the avatar URL, in words the collector can
   * act on. Derived rather than held in state — it is a pure function of the
   * field, so state would be a second copy to keep in sync.
   *
   * ⚠ It WARNS, it does not block. A host can be down for a minute and an
   * avatar that fails today may be fine tomorrow; refusing the save would
   * strand someone over a transient failure. What was missing was any signal at
   * all — a collector pasted an OpenSea item page, we saved it, said nothing,
   * and their profile fell back to initials, which looks identical to never
   * having set one.
   */
  const avatarWarning = useMemo(() => avatarUrlWarning(form.avatar_url), [form.avatar_url]);

  const [pickerOpen, setPickerOpen] = useState(false);

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

      // ⚠ SUPPRESSED when the existing picks could not be read: `teamsArray`
      // would be built from an empty `picks` map and the POST replaces the full
      // list, so saving anything else on the page would silently delete every
      // favourite team. Skipping the leg leaves them untouched, which is the
      // only safe answer when we do not know what they are.
      if (ownerKey && !teamsLoadFailed) {
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

  // Preview only a handle that would actually save; echoing "qa 0903!" as a
  // URL was a false promise (2026-09-02, QA #9). The regex mirrors the save
  // guard below.
  const usernameTrimmed = form.username.trim();
  const usernameValid = /^[a-z0-9_-]{3,32}$/.test(usernameTrimmed.toLowerCase());
  const publicUrl = usernameTrimmed && usernameValid
    ? `/profile/${usernameTrimmed.toLowerCase()}`
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
        *{box-sizing:border-box;margin:0;padding:0;}
        .field { display:flex; flex-direction:column; gap:6px; }
        .field label { font-family:${monoFont}; font-size:11px; color:rgba(255,255,255,0.7); letter-spacing:0.04em; text-transform:uppercase; }
        /* Section heading for a field that has more than one input path (the
           avatar: pick a Moment, or paste a URL). Matches .field label so the
           form still reads as one consistent ladder. */
        .field-heading { font-family:${monoFont}; font-size:11px; color:rgba(255,255,255,0.7); letter-spacing:0.04em; text-transform:uppercase; }
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
        ) : loadFailed ? (
          /* ⚠ The form is WITHHELD, not merely annotated. A banner over an
             editable blank form still lets a save go out, and this page's save
             POSTs every field — so the failure has to remove the ability to
             submit, not just describe itself. */
          <section
            role="status"
            style={{ background: "var(--rpc-surface)", border: "1px solid var(--rpc-border)", borderRadius: 10, padding: "18px 18px 22px" }}
          >
            <div style={{ fontFamily: condensedFont, fontSize: 18, fontWeight: 700, marginBottom: 8 }}>
              Couldn&rsquo;t load your profile
            </div>
            <div style={{ fontFamily: monoFont, fontSize: 12, color: "rgba(255,255,255,0.6)", lineHeight: 1.6 }}>
              This is a problem on our side and says nothing about what&rsquo;s saved — your profile is untouched.
              The editor stays hidden until it loads, so nothing can be overwritten with a blank form. Reload in a moment.
            </div>
          </section>
        ) : (
          <section style={{ background: "var(--rpc-surface)", border: "1px solid var(--rpc-border)", borderRadius: 10, padding: "18px 18px 22px", display: "flex", flexDirection: "column", gap: 16 }}>
            {/* ⚠ Every control on this page used to be set BLIND — accent
                colour through a bare colour input, the avatar as a raw URL,
                the tagline as a textarea — with nothing showing what any of it
                would look like. The cosmetics were not even fetched here,
                because they are equipped from /rewards. */}
            <ProfileHeaderPreview
              username={form.username}
              displayName={form.display_name}
              tagline={form.tagline}
              avatarUrl={form.avatar_url}
              accentColor={form.accent_color}
              equippedBorder={form.equipped_border}
              equippedBanner={form.equipped_banner}
            />

            {/* ⚠ THIS USED TO LINK TO /rewards, WHICH IS A HARD 404
                (app/rewards/layout.tsx calls notFound() unconditionally). So the
                one instruction on this page for getting a cosmetic sent every
                collector to a dead end — and 19 of 20 have none equipped, i.e.
                it was a dead end for almost everyone who read it.
                The line is now shown ONLY to someone who already HAS a cosmetic,
                where it is purely descriptive and true. Restore the link when
                /rewards is reachable again. */}
            {(form.equipped_border || form.equipped_banner) && (
              <div className="hint" style={{ marginTop: -6 }}>
                Your equipped border and banner show in the preview above.
              </div>
            )}

            <div className="field">
              <label htmlFor="username">Public username</label>
              <input
                id="username"
                value={form.username}
                onChange={(e) => update("username", e.target.value)}
                placeholder="yourusername"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
              />
              <div className="hint">
                Public URL:{" "}
                {publicUrl ? (
                  <code>rippackscity.com{publicUrl}</code>
                ) : usernameTrimmed ? (
                  "3–32 chars, lowercase letters, numbers, _ and - only"
                ) : (
                  "set a username to enable"
                )}
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

            {/* Socials sit ABOVE the five league pickers (2026-09-02, QA #9): the
                X handle is what the share card credits, and it was buried under
                ~90 team options a new collector had to scroll past. */}
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

            {/* Fan Affinity — replaces the old free-text favorite_team field. */}
            <div className="field">
              <label>Fan Affinity</label>
              {/* ⚠ The teams POST sends the FULL list, so an empty picker is a
                  DELETE. When the existing picks could not be read, the pickers
                  show "— None —" for a user who has favourites, and saving
                  would wipe them — which is exactly what /my-teams reads. The
                  save is suppressed for the team leg while this is set (see
                  save()), and the notice says so rather than letting the UI
                  imply the state is real. */}
              {teamsLoadFailed && (
                <div
                  role="status"
                  className="hint"
                  style={{ color: "var(--rpc-red)", lineHeight: 1.6, marginBottom: 4 }}
                >
                  Your saved teams couldn&rsquo;t be loaded, so these show as empty. Saving will leave them
                  exactly as they are — reload to edit them.
                </div>
              )}
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

            <div className="field">
              <div className="field-heading">Avatar</div>
              {/* ⚠ THE PICKER IS THE PRIMARY PATH AND SITS ABOVE THE FIELD.
                  Asking a collector for an image URL asks them to do a job
                  browsers make hard — the obvious thing to copy is the PAGE
                  address, which is valid, serves HTML, and fails silently. We
                  already know every Moment they own and already have its art,
                  so the field is the ESCAPE HATCH, not the main road. */}
              <button
                type="button"
                onClick={() => setPickerOpen(true)}
                style={{
                  alignSelf: "flex-start",
                  background: "transparent",
                  border: "1px solid var(--rpc-red)",
                  color: "var(--rpc-red)",
                  borderRadius: 4,
                  padding: "6px 12px",
                  fontFamily: monoFont,
                  fontSize: 11,
                  letterSpacing: "0.08em",
                  cursor: "pointer",
                  marginBottom: 8,
                }}
              >
                CHOOSE FROM YOUR MOMENTS →
              </button>
              <label htmlFor="avatar_url" className="hint" style={{ marginBottom: 4 }}>
                Or paste an image URL
              </label>
              <input
                id="avatar_url"
                value={form.avatar_url}
                onChange={(e) => update("avatar_url", e.target.value)}
                placeholder="https://..."
              />
              {/* Blank used to mean "show my initials"; it now means "show the
                  RPC logo", so the field has to say so — the live preview above
                  shows it, but only once you look away from the input. */}
              {avatarWarning ? (
                <div className="hint" data-testid="avatar-url-warning" style={{ color: "var(--rpc-warning)" }}>
                  {avatarWarning}
                </div>
              ) : (
                <div className="hint">Leave blank to use the RPC logo.</div>
              )}
            </div>

            {pickerOpen && (
              <AvatarMomentPicker
                onClose={() => setPickerOpen(false)}
                onPick={(url) => {
                  // Writes the SAME field a typed URL writes, so the default,
                  // the warning, the preview and the OG card all apply unchanged.
                  update("avatar_url", url);
                  setPickerOpen(false);
                }}
              />
            )}

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
