/**
 * app/api/og/profile/[username]/route.tsx
 *
 * The collector's social card (1200×630 PNG) — what X, Discord, Slack and
 * iMessage render when someone shares their profile. Reads bio + saved-wallet
 * aggregates + trophies + achievements straight off PostgREST rather than
 * chaining through our own API.
 *
 * 2026-08-13 — three things this card was getting wrong, all in the "it should
 * look beautiful when shared" direction:
 *
 * (1) IT WAS NOT BRANDED. Every string rendered in `sans-serif`, i.e. whatever
 *     satori's bundled default is, even though Barlow Condensed Black and Share
 *     Tech Mono have been vendored under `public/fonts` since the trophy-case
 *     PDF shipped. The PDF — a file a handful of people download — was the only
 *     surface using them, while the card seen by everyone was generic. Now
 *     loaded here too, memoized across warm invocations and FAIL-SOFT: a font
 *     fetch that fails drops the `fonts` option and the card still renders,
 *     because an unbranded card beats no card.
 *
 * (2) IT IGNORED THE COLLECTOR'S ACTUAL FLAIR. `equipped_border` and
 *     `equipped_banner` — the cosmetics people spend Status on — were not even
 *     selected, so the one place that flair would be seen by other people
 *     showed none of it. Both now render (ring + glow on the avatar, gradient
 *     bar across the top), sharing `lib/cosmetics.ts` with the profile page so
 *     the card and the page can't drift.
 *
 * (3) THE TROPHIES WERE ILLEGIBLE. Six 220px-wide cards were absolutely
 *     positioned at 36px offsets inside a 420px box, so five of them showed a
 *     36px sliver — the fan hid the exact thing the card is meant to show off.
 *     Replaced with a real case: a grid that sizes itself to the number pinned,
 *     so one trophy reads big and six read as a set. Art also goes through
 *     `hiResThumb`, because Top Shot stills are stored at width=180 and were
 *     being upscaled into a 220px slot.
 *
 * 2026-08-14 — a fourth, found while building the trophy-case card:
 *
 * (4) IT READ PIN-TIME TROPHY DATA. The trophies came from `trophy_moments`
 *     directly, whose rows are snapshots taken at the moment of pinning —
 *     measured, **8 of 16 carried a NULL tier**, so half the tiles drew the
 *     default grey rather than their real tier colour, and (3) above made that
 *     MORE visible by switching to `tierAccent`. Now read through
 *     `get_trophy_slab_data_by_username`, the same RPC the profile page and the
 *     trophy-case card use, which resolves live tier and art.
 *
 * The `ok`-vs-empty discipline below predates this and is load-bearing; see
 * `fetchJson`.
 */

import { ImageResponse } from "next/og";
import { NextRequest } from "next/server";
import { ogImageDataUri } from "@/lib/og/img-data";
import { borderCosmetic, bannerCosmetic } from "@/lib/cosmetics";
import { resolveAvatarUrl } from "@/lib/profile/default-avatar";
import { tierAccent, hiResThumb } from "@/lib/trophy/slab-style";
import {
  brandFonts,
  brandFamilies,
  DISPLAY_FONT,
  MONO_FONT,
  OG_CACHE_HEADERS,
  type OgFont,
} from "@/lib/og/brand-fonts";
import { OgMark, type MarkName } from "@/lib/og/marks";
import { ogFetch } from "@/lib/og/og-fetch";

export const runtime = "edge";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const BASE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ?? "https://www.rippackscity.com";


interface BioRow {
  user_id: string | null;
  display_name: string | null;
  tagline: string | null;
  accent_color: string | null;
  avatar_url: string | null;
  favorite_team: string | null;
  equipped_border: string | null;
  equipped_banner: string | null;
}

interface WalletRow {
  cached_fmv_usd: number | null;
  /** Stale-priced portion of cached_fmv_usd — held out of the headline, as
   *  the dashboard does (2026-09-02, QA finding #6). */
  cached_fmv_stale_usd?: number | null;
  cached_moment_count: number | null;
  cached_badges: string[] | null;
}

interface TrophyRow {
  slot: number;
  player_name: string | null;
  thumbnail_url: string | null;
  tier: string | null;
}

interface AchievementRow {
  achievement_key: string;
  tier: string;
}

// ⚠ THESE WERE EMOJI, AND AN EMOJI HERE WAS A THIRD-PARTY NETWORK CALL ON THE
// PATH X's CRAWLER WAITS ON. next/og resolves 🎒💎🎯🏆⚡📚💰 by fetching an SVG
// from cdn.jsdelivr.net at RENDER time, and the "★" that stood in for an
// unrecognised key was worse still — it is not an emoji, so it fell through to
// next/og's OTHER remote fallback, a Google Fonts stylesheet for Noto Sans
// Symbols. Two third-party dependencies in one seven-entry map, neither
// declared, neither bounded. See lib/og/marks.tsx for the measurement.
const ACH_MARK: Record<string, MarkName> = {
  pack_hunter: "bag",
  diamond_hands: "diamond",
  serial_sniper: "target",
  trophy_curator: "trophy",
  challenge_accepted: "bolt",
  series_collector: "stack",
  big_spender: "coin",
};

function achTierColor(tier: string): string {
  switch ((tier || "").toLowerCase()) {
    case "bronze":
      return "#CD7F32";
    case "silver":
      return "#C0C0C0";
    case "gold":
      return "#F59E0B";
    case "platinum":
      return "#E0E0FF";
    default:
      return "#FFFFFF";
  }
}

function fmtDollars(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0";
  if (n >= 1_000_000) return "$" + (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1000) return "$" + (n / 1000).toFixed(1) + "K";
  return "$" + n.toFixed(2);
}

/**
 * ⚠ Returns `ok` alongside the rows, and the distinction is load-bearing.
 *
 * This card renders a PORTFOLIO FMV for a named collector. Before 2026-08-13 a
 * failed `saved_wallets` read returned `[]`, `totalFmv` reduced to 0, and the
 * card published "$0" as that person's portfolio — a false financial claim about
 * an identifiable individual, baked into an edge-cached PNG and shared socially.
 *
 * THREE states, not two: a read that failed (`ok:false` — withhold the figure),
 * a profile with no linked wallets (`ok:true`, empty — a real answer), and rows.
 */
async function fetchJson<T>(url: string): Promise<{ rows: T[]; ok: boolean }> {
  try {
    const r = await ogFetch(url, {
      headers: {
        apikey: SERVICE_KEY,
        Authorization: "Bearer " + SERVICE_KEY,
      },
      cache: "no-store",
    });
    if (!r.ok) return { rows: [], ok: false };
    const data = await r.json();
    return { rows: Array.isArray(data) ? (data as T[]) : [], ok: true };
  } catch {
    return { rows: [], ok: false };
  }
}

/**
 * Call a Postgres function through PostgREST, same `{ rows, ok }` contract as
 * `fetchJson` — a failed read must stay distinguishable from an empty answer.
 *
 * A `RETURNS jsonb` function returns the VALUE itself here, not a row set, so
 * the body is the array rather than something wrapping it.
 */
async function fetchRpc<T>(fn: string, body: unknown): Promise<{ rows: T[]; ok: boolean }> {
  try {
    const r = await ogFetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: "Bearer " + SERVICE_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    if (!r.ok) return { rows: [], ok: false };
    const data = await r.json();
    return { rows: Array.isArray(data) ? (data as T[]) : [], ok: true };
  } catch {
    return { rows: [], ok: false };
  }
}

/**
 * Trophy-case geometry. A grid, not a fan — the previous layout stacked
 * 220px-wide cards at 36px offsets, so all but the last showed a sliver.
 *
 * The card sizes itself to what is actually pinned so a single trophy reads as
 * a hero rather than as a lonely thumbnail, and six read as a case. Widths are
 * chosen to fill the 420px column exactly at each column count.
 */
export function trophyGrid(count: number): { cols: number; w: number; h: number } {
  const cols = Math.min(3, Math.max(1, count));
  const w = cols === 1 ? 240 : cols === 2 ? 195 : 130;
  return { cols, w, h: Math.round(w * 1.32) };
}

function renderFallback(fonts?: OgFont[]) {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background:
            "linear-gradient(135deg, #080808 0%, #111116 60%, #0d0d12 100%)",
          fontFamily: fonts ? DISPLAY_FONT : "sans-serif",
          gap: 20,
        }}
      >
        <div
          style={{
            display: "flex",
            gap: 12,
            fontSize: 56,
            fontWeight: 900,
            letterSpacing: 6,
            textTransform: "uppercase",
          }}
        >
          <span style={{ color: "#fff" }}>RIP PACKS</span>
          <span style={{ color: "#E03A2F" }}>CITY</span>
        </div>
        <div
          style={{
            color: "rgba(255,255,255,0.5)",
            fontSize: 18,
            letterSpacing: 2,
            textTransform: "uppercase",
            fontFamily: fonts ? MONO_FONT : "sans-serif",
          }}
        >
          rippackscity.com
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
      ...(fonts ? { fonts } : {}),
      headers: OG_CACHE_HEADERS,
    },
  );
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ username: string }> },
) {
  // Resolved before the try so the fallback can be branded too; `fontOptions`
  // never rejects.
  const fonts = await brandFonts();
  const { display, mono } = brandFamilies(fonts);

  try {
    const { username: rawUsername } = await params;
    const username = decodeURIComponent(rawUsername ?? "").trim();
    if (!username || !SUPABASE_URL || !SERVICE_KEY) return renderFallback(fonts);

    const enc = encodeURIComponent(username);

    // Lookup pattern mirrors /api/public/profile: username -> user_id (via the
    // denormalized profile_bio.username cache), then wallets/trophies key on
    // user_id (their only canonical FK). profile_achievements is still keyed
    // by owner_key = username, so it stays on the username lookup.
    //
    // equipped_border/equipped_banner ride along on this SAME row — the flair
    // costs no extra round trip, which is why there is no excuse for the card
    // having ignored it.
    const bios = await fetchJson<BioRow>(
      `${SUPABASE_URL}/rest/v1/profile_bio?username=ilike.${enc}&select=user_id,display_name,tagline,accent_color,avatar_url,favorite_team,equipped_border,equipped_banner&limit=1`,
    );
    const bio: BioRow | null = bios.rows[0] ?? null;
    const userId = bio?.user_id ?? null;
    const uidEnc = userId ? encodeURIComponent(userId) : null;

    // ⚠ A profile with no resolvable user_id has no wallets to read — that is
    // `ok: true` with no rows (a real answer), NOT a failure. Only a read that
    // actually errored may suppress the figures below.
    const [walletsRes, trophiesRes, achievementsRes] = await Promise.all([
      uidEnc
        ? fetchJson<WalletRow>(
            `${SUPABASE_URL}/rest/v1/saved_wallets?user_id=eq.${uidEnc}&select=cached_fmv_usd,cached_fmv_stale_usd,cached_moment_count,cached_badges&limit=25`,
          )
        : Promise.resolve({ rows: [] as WalletRow[], ok: true }),
      // ⚠ THE RPC, NOT `trophy_moments`. Those rows are PIN-TIME snapshots:
      // measured 2026-08-14, **8 of 16** carried a NULL tier, so half the tiles
      // on the most-shared card in the product drew the default grey instead of
      // their real tier colour — and today's switch from a 3-case border map to
      // `tierAccent` made that more visible, not less. The same RPC the profile
      // PAGE and the trophy-case card already use returns live tier + art.
      // Keyed on username because that is what the function takes; the wallets
      // above still key on user_id.
      fetchRpc<TrophyRow>("get_trophy_slab_data_by_username", { p_username: username }),
      fetchJson<AchievementRow>(
        `${SUPABASE_URL}/rest/v1/profile_achievements?owner_key=eq.${enc}&select=achievement_key,tier&order=unlocked_at.asc`,
      ),
    ]);
    const wallets = walletsRes.rows;
    const trophies = trophiesRes.rows;
    const achievements = achievementsRes.rows;
    const walletsOk = walletsRes.ok;
    const trophiesOk = trophiesRes.ok;

    const accent = (bio?.accent_color || "#E03A2F").trim() || "#E03A2F";
    const border = borderCosmetic(bio?.equipped_border);
    const banner = bannerCosmetic(bio?.equipped_banner);
    // An equipped border outranks the accent for the avatar ring — it is the
    // thing the collector chose, and it is the same precedence the profile page
    // applies (ProfileClient's Avatar).
    const ringColor = border?.ring ?? accent;

    // Headline = total minus the stale-priced portion — the dashboard's
    // definition. The card used to publish the flat total, 80% above the
    // number the collector had just read on their own dashboard.
    const totalFmv = Math.max(
      0,
      wallets.reduce(
        (s, w) => s + (Number(w.cached_fmv_usd) || 0) - (Number(w.cached_fmv_stale_usd) || 0),
        0,
      ),
    );
    const totalMoments = wallets.reduce(
      (s, w) => s + (Number(w.cached_moment_count) || 0),
      0,
    );

    // Pre-fetch trophy art + avatar to data URIs (timeout/byte-capped,
    // failures dropped) so one dead upstream can never 500 the whole card.
    // hiResThumb first: Top Shot stills are stored at width=180 and were being
    // upscaled into the slot, which is most of why the old fan looked soft.
    const rawTrophies = trophies.filter((t) => !!t.thumbnail_url).slice(0, 6);
    const trophyDataUris = await Promise.all(
      rawTrophies.map((t) => ogImageDataUri(hiResThumb(t.thumbnail_url) ?? null)),
    );
    const thumbTrophies = rawTrophies
      .map((t, i) => ({ ...t, thumbnail_url: trophyDataUris[i] }))
      .filter((t) => !!t.thumbnail_url);
    const filledTrophyCount = trophies.length;
    const grid = trophyGrid(thumbTrophies.length);

    const displayName = (bio?.display_name || username).toUpperCase();
    const tagline = bio?.tagline || "";
    const initials = username.slice(0, 2).toUpperCase();
    // A collector who has not set an avatar gets the RPC logo, same as the
    // profile page — a card is the one surface where the monogram was most
    // visible, since it is what someone ELSE sees in their timeline.
    //
    // ⚠ The `startsWith("https://")` gate stays: it guards a value a collector
    // typed, and DEFAULT_AVATAR_URL is deliberately absolute so it passes.
    // ⚠ `hasAvatar` still means "we fetched BYTES", not "a URL existed" — a
    // dead host (or a dead logo) must fall through to the monogram rather than
    // baking a broken <img> into a cached PNG.
    const avatarSrc = resolveAvatarUrl(bio?.avatar_url);
    const avatarDataUri = avatarSrc.startsWith("https://")
      ? await ogImageDataUri(avatarSrc)
      : null;
    const hasAvatar = !!avatarDataUri;

    return new ImageResponse(
      (
        <div
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            flexDirection: "column",
            background:
              "linear-gradient(135deg, #080808 0%, #111116 60%, #0d0d12 100%)",
            fontFamily: display,
            position: "relative",
            padding: "40px 48px",
          }}
        >
          {/* Equipped banner — a full-bleed gradient bar pinned to the very top
              edge, so the cosmetic reads instantly at thumbnail size. Absolute
              so it escapes the page padding. */}
          {banner && (
            <div
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                height: 10,
                display: "flex",
                background: banner.background,
              }}
            />
          )}

          {/* Header */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginBottom: 10,
            }}
          >
            <span
              style={{
                color: "#fff",
                fontSize: 20,
                fontWeight: 900,
                letterSpacing: 4,
                textTransform: "uppercase",
              }}
            >
              RIP PACKS
            </span>
            <span
              style={{
                color: accent,
                fontSize: 20,
                fontWeight: 900,
                letterSpacing: 4,
                textTransform: "uppercase",
              }}
            >
              CITY
            </span>
          </div>
          <div
            style={{
              width: "100%",
              height: 1,
              background: "rgba(255,255,255,0.08)",
              display: "flex",
              marginBottom: 32,
            }}
          />

          {/* Body row: left content + right trophy case */}
          <div style={{ display: "flex", flex: 1 }}>
            {/* LEFT */}
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                width: 700,
                gap: 18,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
                {hasAvatar ? (
                  <img
                    // The prefetched data URI, NOT `bio.avatar_url`. It used to
                    // read the row after mutating it in place, which now would
                    // also dereference a null `bio` — the default renders an
                    // avatar even for a profile whose row did not come back.
                    src={avatarDataUri as string}
                    width={80}
                    height={80}
                    style={{
                      width: 80,
                      height: 80,
                      borderRadius: "50%",
                      objectFit: "cover",
                      border: (border ? 3 : 2) + "px solid " + ringColor,
                    }}
                  />
                ) : (
                  <div
                    style={{
                      width: 80,
                      height: 80,
                      borderRadius: "50%",
                      background: accent + "22",
                      border: (border ? 3 : 1) + "px solid " + ringColor,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      color: accent,
                      fontSize: 30,
                      fontWeight: 900,
                    }}
                  >
                    {initials}
                  </div>
                )}
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 4,
                    maxWidth: 580,
                  }}
                >
                  <div
                    style={{
                      color: "#fff",
                      fontSize: 52,
                      fontWeight: 900,
                      letterSpacing: 1,
                      textTransform: "uppercase",
                      lineHeight: 1.05,
                      display: "flex",
                    }}
                  >
                    {displayName}
                  </div>
                  {tagline && (
                    <div
                      style={{
                        color: "rgba(255,255,255,0.55)",
                        fontSize: 17,
                        fontFamily: mono,
                        display: "flex",
                      }}
                    >
                      {tagline}
                    </div>
                  )}
                </div>
              </div>

              {/* Stats row */}
              <div
                style={{
                  display: "flex",
                  gap: 16,
                  marginTop: 26,
                }}
              >
                {[
                  // ⚠ "—" when the READ failed, not when the value is zero. A
                  // collector with an empty wallet genuinely has $0; a collector
                  // whose wallet row we could not read does not, and publishing
                  // "$0" for them on a shareable card is a false claim about a
                  // named person.
                  {
                    label: "PORTFOLIO FMV",
                    value: walletsOk ? fmtDollars(totalFmv) : "—",
                  },
                  {
                    label: "MOMENTS",
                    value:
                      walletsOk && totalMoments > 0
                        ? totalMoments.toLocaleString()
                        : "—",
                  },
                  {
                    label: "TROPHY CASE",
                    value: trophiesOk ? filledTrophyCount + " / 6" : "—",
                  },
                ].map((s) => (
                  <div
                    key={s.label}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      padding: "16px 20px",
                      background: "rgba(255,255,255,0.03)",
                      border: "1px solid rgba(255,255,255,0.07)",
                      borderRadius: 10,
                      minWidth: 196,
                    }}
                  >
                    <div
                      style={{
                        color: "#fff",
                        fontSize: 36,
                        fontWeight: 900,
                        lineHeight: 1,
                        display: "flex",
                      }}
                    >
                      {s.value}
                    </div>
                    <div
                      style={{
                        color: "rgba(255,255,255,0.4)",
                        fontSize: 11,
                        fontFamily: mono,
                        letterSpacing: 2,
                        textTransform: "uppercase",
                        marginTop: 10,
                        display: "flex",
                      }}
                    >
                      {s.label}
                    </div>
                  </div>
                ))}
              </div>

              {/* Achievement badges row */}
              {achievements.length > 0 && (
                <div
                  style={{
                    display: "flex",
                    gap: 14,
                    marginTop: 18,
                    alignItems: "center",
                  }}
                >
                  {achievements.slice(0, 6).map((a, i) => {
                    const mark = ACH_MARK[a.achievement_key] ?? "star";
                    // The mark now CARRIES the tier instead of standing next to
                    // it. The 6px dot in the corner encoded exactly one variable
                    // — tier — while the emoji beside it encoded none of it, and
                    // at the 28px this badge actually occupies a 6px dot is the
                    // least legible thing on the card. A 20px mark in the tier
                    // colour says the same thing at three times the size, and
                    // one encoding of one variable is not clutter.
                    const tint = achTierColor(a.tier);
                    return (
                      <div
                        key={i}
                        style={{
                          display: "flex",
                          width: 28,
                          height: 28,
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <OgMark name={mark} size={20} color={tint} weight={2} />
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* RIGHT: the trophy case, as a case */}
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignContent: "center",
                justifyContent: "flex-end",
                gap: 12,
                width: 420,
                height: 380,
              }}
            >
              {thumbTrophies.length > 0 ? (
                thumbTrophies.map((t, i) => (
                  <div
                    key={i}
                    style={{
                      width: grid.w,
                      height: grid.h,
                      borderRadius: 8,
                      overflow: "hidden",
                      border: "2px solid " + tierAccent(t.tier),
                      display: "flex",
                      background: "#111",
                      boxShadow: "0 10px 24px rgba(0,0,0,0.5)",
                    }}
                  >
                    <img
                      src={t.thumbnail_url as string}
                      width={grid.w}
                      height={grid.h}
                      style={{ width: grid.w, height: grid.h, objectFit: "cover" }}
                    />
                  </div>
                ))
              ) : (
                <div
                  style={{
                    display: "flex",
                    width: "100%",
                    height: "100%",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "rgba(255,255,255,0.2)",
                    fontSize: 20,
                    fontFamily: mono,
                    letterSpacing: 3,
                    textTransform: "uppercase",
                    border: "1px dashed rgba(255,255,255,0.08)",
                    borderRadius: 12,
                  }}
                >
                  NO TROPHIES PINNED
                </div>
              )}
            </div>
          </div>

          {/* Bottom bar */}
          <div
            style={{
              width: "100%",
              height: 1,
              background: accent + "33",
              display: "flex",
              marginTop: 16,
            }}
          />
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginTop: 12,
            }}
          >
            <div
              style={{
                color: "rgba(255,255,255,0.4)",
                fontSize: 11,
                fontFamily: mono,
                letterSpacing: 2,
                textTransform: "uppercase",
                display: "flex",
              }}
            >
              COLLECTOR INTELLIGENCE
            </div>
            <div
              style={{
                color: "rgba(255,255,255,0.5)",
                fontSize: 14,
                fontFamily: mono,
                display: "flex",
              }}
            >
              rippackscity.com
            </div>
          </div>
        </div>
      ),
      {
        width: 1200,
        height: 630,
        ...(fonts ? { fonts } : {}),
        headers: OG_CACHE_HEADERS,
      },
    );
  } catch {
    // ⚠ This catch covers the DATA path — a Supabase read that throws, a bad
    // param — and nothing else. It does NOT and cannot cover a font satori
    // rejects: `new ImageResponse(...)` returns a Response whose body is a
    // STREAM, so satori runs when the body is consumed, after this handler has
    // returned. An earlier version of this file wrapped the fallback in a
    // second try/catch to "retry without fonts" on exactly that failure; it was
    // inert, because the throw never passes through here. The real defence is
    // `isSupportedFontBuffer` in lib/og/brand-fonts, which rejects non-font
    // bytes BEFORE they reach the renderer — so by the time `fonts` is non-null
    // it has already been validated, and passing it here is safe.
    return renderFallback(fonts);
  }
}
