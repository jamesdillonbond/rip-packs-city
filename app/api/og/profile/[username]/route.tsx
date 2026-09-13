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
import { editionKey, trophyMarks, type TrophyMark } from "@/lib/og/trophy-marks";
import { withOfficialArt } from "@/lib/og/official-mark-art";
import { trophyDetail } from "@/lib/og/trophy-detail";
import { GOLD_HEX } from "@/lib/badges/glyphs";
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
  /** Needed to attribute pack rips — `pack_rips` keys on the opener's address,
   *  not on a user id. Addresses are stored lowercase; query them with plain
   *  equality, NEVER `lower()` (a `lower()` join against `pack_rips` times out,
   *  57014). */
  wallet_addr: string | null;
  cached_moment_count: number | null;
  cached_badges: string[] | null;
}

/** One structured favourite-team pick, joined to the master catalog. */
interface TeamRow {
  league: string | null;
  is_primary: boolean | null;
  teams_master: { abbreviation: string | null; team_name: string | null } | null;
}

interface TrophyRow {
  slot: number;
  player_name: string | null;
  thumbnail_url: string | null;
  tier: string | null;
  /** Edition-wide badge titles, already rolled up by the RPC — see
   *  lib/og/trophy-marks.ts for why no extra read is made for these. */
  badges: string[] | null;
  serial_number: number | null;
  circulation_count: number | null;
  /** `editions.external_id`, e.g. "165:6563" — NOT the uuid. */
  edition_id: string | null;
  collection_id: string | null;
  /**
   * ⚠ PICKS THE BADGE ART TIER (lib/badges/official-art.ts) — Top Shot's marks
   * are inline in the repo, All Day's are official badgesV3 art, and the rest
   * keep RPC's glyphs. Also what stops the two leagues' same-titled badges
   * ("Rookie Year", "Championship Year") borrowing each other's art. The RPC
   * has always returned it; this card simply never read it.
   */
  collection_slug: string | null;
}

/** One `editions` row, read only for the jersey-match glyph. */
interface JerseyRow {
  external_id: string | null;
  collection_id: string | null;
  jersey_number: number | null;
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

/**
 * Tile width for the stat row, sized so the tiles fill the 700px left column
 * at each count and WRAP to a 2×2 block at four rather than orphaning one.
 *
 * ⚠ The count is not fixed: the TEAMS tile is suppressed for a collector with
 * no picks, which today is 21 of 25 accounts. Building the row at a hardcoded
 * width would have shipped either a gap or a wrapped orphan for almost everyone.
 */
export function statTileWidth(count: number): number {
  const n = Math.min(4, Math.max(1, count));
  // 4 wraps: 2×300 + 16 = 616 fits, a third would need 916 and does not.
  return [0, 300, 300, 222, 300][n];
}

/**
 * ⚠ Returns `ok` alongside the rows, and the distinction is load-bearing.
 *
 * This card makes counted claims about a NAMED collector. Before 2026-08-13 a
 * failed `saved_wallets` read returned `[]`, the FMV reduce collapsed to 0, and
 * the card published "$0" as that person's portfolio — a false financial claim
 * about an identifiable individual, baked into an edge-cached PNG and shared
 * socially. The portfolio figure came OFF the card on 2026-09-12, but the same
 * hazard rides on every tile that replaced it (Moments, packs ripped), which is
 * why this contract stayed.
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
 * Read a COUNT through PostgREST without pulling the rows, same `ok`-vs-value
 * contract as the readers above.
 *
 * ⚠ `?? 0` on a supabase count is one of this repo's two named fabricated-number
 * shapes, and it is exactly the shape this card must not have: a failed read
 * publishing "0 PACKS RIPPED" about a named collector, baked into a cached PNG
 * and shared into other people's timelines where nobody can check it. So the
 * count comes back as `null` when the read failed, and the tile says "—".
 *
 * The total rides in `Content-Range` (`0-0/503`), which is why this asks for one
 * row rather than none — `limit=0` returns `*\/503` on some paths and there is no
 * reason to depend on which.
 */
async function fetchCount(url: string): Promise<{ count: number | null; ok: boolean }> {
  try {
    const r = await ogFetch(url, {
      headers: {
        apikey: SERVICE_KEY,
        Authorization: "Bearer " + SERVICE_KEY,
        Prefer: "count=exact",
      },
      cache: "no-store",
    });
    if (!r.ok) return { count: null, ok: false };
    const total = (r.headers.get("content-range") || "").split("/")[1];
    const n = Number(total);
    if (!total || !Number.isFinite(n)) return { count: null, ok: false };
    return { count: n, ok: true };
  } catch {
    return { count: null, ok: false };
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
  // ⚠ FOUR IS ITS OWN CASE, and it is the count this card hits most often once
  // an upstream drops one tile. `Math.min(3, …)` gave 4 trophies a row of three
  // with a single orphan slab beneath it and a 280px hole beside that — the
  // most broken-looking arrangement the grid can produce. A 2×2 block reads as
  // a case. The width is HEIGHT-bound, not width-bound: two rows plus the 12px
  // gap have to clear the 380px column, so 138 is the ceiling (2×182+12=376),
  // which is still wider than the 130 a row of three would have given.
  const cols = count === 4 ? 2 : Math.min(3, Math.max(1, count));
  const w = count === 4 ? 138 : cols === 1 ? 240 : cols === 2 ? 195 : 130;
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
    const [walletsRes, trophiesRes, achievementsRes, teamsRes] = await Promise.all([
      uidEnc
        ? fetchJson<WalletRow>(
            `${SUPABASE_URL}/rest/v1/saved_wallets?user_id=eq.${uidEnc}&select=wallet_addr,cached_moment_count,cached_badges&limit=25`,
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
      // ⚠ `user_favorite_teams`, NOT `profile_bio.favorite_team`. The handoff
      // that specified this tile called for a new `favorite_teams text[]` column
      // and a picker in /profile/edit — both already exist, in a different
      // shape: a per-league table with a `is_primary` flag, an inner join to
      // `teams_master`, and the "Fan Affinity" picker that replaced the legacy
      // free-text field. Re-derived 2026-09-12 before building anything, which
      // is the only reason no redundant column shipped.
      // `!inner` drops picks whose slug has left the master catalog, matching
      // /api/profile/teams so the card and the profile page cannot disagree.
      uidEnc
        ? fetchJson<TeamRow>(
            `${SUPABASE_URL}/rest/v1/user_favorite_teams?user_id=eq.${uidEnc}` +
              `&select=league,is_primary,teams_master!inner(abbreviation,team_name)` +
              `&order=is_primary.desc.nullslast,league.asc&limit=4`,
          )
        : Promise.resolve({ rows: [] as TeamRow[], ok: true }),
    ]);
    const wallets = walletsRes.rows;
    const trophies = trophiesRes.rows;
    const achievements = achievementsRes.rows;
    const walletsOk = walletsRes.ok;
    const trophiesOk = trophiesRes.ok;

    // ── PACKS RIPPED ──────────────────────────────────────────────────────
    // Sequential rather than in the batch above, because `pack_rips` keys on
    // the OPENER'S ADDRESS and the addresses only exist once `saved_wallets`
    // has answered. Measured 2026-09-12: an Index Only Scan on
    // `idx_pack_rips_opener`, 22 shared buffers for a 4-wallet / 503-rip
    // profile — cheap enough that a `cached_pack_rips` column (and the writer
    // and staleness handling it would need) is not worth its own ingest.
    const walletAddrs = wallets
      .map((w) => (w.wallet_addr ?? "").trim())
      .filter((a) => /^0x[0-9a-fA-F]{6,}$/.test(a));
    // ── JERSEY NUMBERS, for the jersey-match glyph ────────────────────────
    // The trophy RPC reads `editions.jersey_number` (to feed
    // serial_fmv_estimate) but does not return it, and it is the ONE thing a
    // badge row needs that is not already on the trophy row — the unified
    // edition badges, the serial and the circulation all are.
    //
    // ⚠ Runs in the SAME round trip as the pack count rather than after it.
    // Both became available at the same moment (this one needs the trophies,
    // that one needs the wallets, and both of those resolved together above),
    // so pairing them costs the crawler one hop instead of two.
    const trophyExtIds = Array.from(
      new Set(trophies.map((t) => (t.edition_id ?? "").trim()).filter(Boolean)),
    ).slice(0, 12);
    const [ripsRes, jerseyRes] = await Promise.all([
      walletsOk && walletAddrs.length > 0
        ? fetchCount(
            `${SUPABASE_URL}/rest/v1/pack_rips?opener_address=in.(${walletAddrs
              .map((a) => encodeURIComponent(a))
              .join(",")})&select=id&limit=1`,
          )
        : Promise.resolve({ count: null as number | null, ok: false }),
      trophyExtIds.length > 0
        ? fetchJson<JerseyRow>(
            `${SUPABASE_URL}/rest/v1/editions?external_id=in.(${trophyExtIds
              .map((e) => encodeURIComponent(`"${e}"`))
              .join(",")})&select=external_id,collection_id,jersey_number&limit=200`,
          )
        : Promise.resolve({ rows: [] as JerseyRow[], ok: true }),
    ]);

    // ⚠ Keyed on (collection_id, external_id), never external_id alone — that
    // column is unique per COLLECTION, so an unqualified map would hand one
    // player's jersey number to another collection's Moment.
    const jerseyByKey = new Map<string, number>();
    for (const e of jerseyRes.rows) {
      if (e.jersey_number != null) {
        jerseyByKey.set(editionKey(e.collection_id, e.external_id), Number(e.jersey_number));
      }
    }
    if (!jerseyRes.ok) {
      // Costs exactly the jersey glyph; `first` and `perfect` are computed from
      // the trophy row and are unaffected. Said out loud rather than swallowed,
      // because a Moment quietly missing a badge it has earned is the mirror of
      // the defect this card was just fixed for.
      console.warn(`[og/profile] jersey lookup failed; jersey glyphs suppressed (${username})`);
    }

    // ⚠ Abbreviations, because that is what the profile page's chips show and a
    // full team name does not fit a 300px tile at this weight. `is_primary`
    // first, which the `order=` above already applied.
    // ⚠ DEDUPED, and this is not hypothetical tidiness: abbreviations are unique
    // per LEAGUE, not globally, and the two most-picked teams in the data share
    // one. Trevor's own picks are Blazers (NBA), Portland Fire (WNBA) and Lions
    // (NFL) — three rows, and undeduped the tile reads "POR · POR · DET".
    const teamLabels = [
      ...new Set(
        teamsRes.rows.map((t) => (t.teams_master?.abbreviation || "").trim()).filter(Boolean),
      ),
    ].slice(0, 3);
    // The legacy free-text field is still the fallback, exactly as
    // ProfileClient does it — a collector who set one before the picker existed
    // should not read as having no team.
    const legacyTeam = (bio?.favorite_team || "").trim();
    const teamsValue = teamLabels.length > 0 ? teamLabels.join(" · ") : legacyTeam;

    const accent = (bio?.accent_color || "#E03A2F").trim() || "#E03A2F";
    const border = borderCosmetic(bio?.equipped_border);
    const banner = bannerCosmetic(bio?.equipped_banner);
    // An equipped border outranks the accent for the avatar ring — it is the
    // thing the collector chose, and it is the same precedence the profile page
    // applies (ProfileClient's Avatar).
    const ringColor = border?.ring ?? accent;

    // ⭐ PORTFOLIO FMV IS GONE FROM THIS CARD — Trevor's call, 2026-09-12.
    // It is also a privacy repair: every share of a profile was broadcasting
    // that collector's net worth into a public timeline, which is not something
    // most people would opt into if they were asked. The stale-split arithmetic
    // that used to live here went with it; `saved_wallets.cached_fmv_*` is no
    // longer read by this route at all.
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
    // ⚠ THE CARD USED TO CLAIM SIX AND DRAW FOUR, and nothing said so.
    // `filledTrophyCount` counts the RPC's rows; the grid used to count the
    // post-filter array, and the two were never compared — so a trophy whose
    // ART failed vanished from the case while the label kept asserting it. Two
    // did, permanently, for every collector holding a Pinnacle or All Day
    // Moment (both causes fixed in lib/og/img-data.ts on 2026-09-12), and the
    // only way anyone found out was by counting slabs in a rendered PNG.
    //
    // The trophy IS pinned — only its picture is unavailable — so the tile
    // stays and says that. Silently drawing a shorter case is the empty-state-
    // that-concludes defect wearing a picture frame.
    // Gold special serials first, then edition badges — the Trophy Case PDF's
    // order, and now the trophy-case card's, so all three artefacts of the
    // same six Moments read the same way.
    //
    // ⭐ ONE deduped pass swaps in OFFICIAL platform art where it exists. Six
    // Top Shot Moments share one badge vocabulary, so resolving across the
    // whole card rather than per tile is what keeps this to a handful of
    // same-origin fetches — see lib/og/official-mark-art.ts.
    const profileMarkRows = await withOfficialArt(
      rawTrophies.map((t) =>
        trophyMarks(t, jerseyByKey.get(editionKey(t.collection_id, t.edition_id)) ?? null, 3),
      ),
    );
    const thumbTrophies = rawTrophies.map((t, i) => ({
      ...t,
      thumbnail_url: trophyDataUris[i] ?? null,
      marks: profileMarkRows[i],
      // ⚠ THE NARROW COLUMN GETS THE SCARCITY FACT AND NOTHING ELSE. The
      // trophy-case card has room for a four-line stack; a 130px profile slab
      // does not, and this card is about the collector rather than about each
      // player. "#1 / 1" is the line that earns its pixels here — five
      // characters that say more to a collector than the thumbnail does at
      // this size. (Deviation from the ordering spec, which asked for a name
      // line too: there is no name on these slabs today and adding one at
      // 130px would crowd the art Trevor just had re-cut.)
      detail: trophyDetail(
        t,
        jerseyByKey.get(editionKey(t.collection_id, t.edition_id)) ?? null,
      ),
    }));
    const artless = thumbTrophies.filter((t) => !t.thumbnail_url);
    if (artless.length > 0) {
      // The one line that would have turned both of the 09-12 drops into a log
      // search instead of a visual inspection. Names the Moment AND the URL —
      // the URL is the whole diagnosis in both cases (relative path / webp).
      console.warn(
        `[og/profile] trophy art unavailable for ${artless.length}/${rawTrophies.length} (${username}):`,
        rawTrophies
          .filter((_, i) => !trophyDataUris[i])
          .map((t) => `${t.player_name ?? "?"} <- ${t.thumbnail_url}`)
          .join(" | "),
      );
    }
    const filledTrophyCount = trophies.length;
    const grid = trophyGrid(thumbTrophies.length);
    // Scales with the slab, capped at 20 so a single hero trophy does not get a
    // billboard. Floored at 15 — below that the monoline geometry stops
    // resolving and the strip reads as smudge rather than as a badge. Three
    // marks at 19 plus their gaps occupy 65 of the 130px six-slab slot.
    const markSize = Math.max(15, Math.min(20, Math.round(grid.w / 7)));
    // ⭐ THE CAPTION SCALES WITH THE SLAB, AND UNTIL 2026-09-12 IT WAS THE ONE
    // THING THAT DID NOT. Everything else on a tile is derived from `grid.w` —
    // the slab, the art, the badge glyphs — but the serial/tier strip was a
    // hardcoded 10px in a 15px band. On the six-slab case that is correct and
    // deliberate; on `trophyGrid(1)` the slab is 240×317, nearly four times the
    // area, and the line that says "#1 / 1 ULTIMATE" stayed a sliver.
    //
    // ⚠ AND THE HERO IS THE COMMON CASE, not the edge one. Measured live
    // 2026-09-12: of the 7 collectors who have pinned anything, **4 have
    // exactly one trophy** and 3 have six. There is no one in between, so the
    // 2- and 3-column widths below are untested by the live population and are
    // deliberately left to fall out of the same formula rather than tuned.
    //
    // Floored at 10 — today's value — so the six-slab and four-slab cases are
    // BYTE-IDENTICAL to what shipped before (130/17 and 138/17 both round to 8,
    // which the floor lifts back to 10). Capped at 14: past that the mono strip
    // starts competing with the art it is captioning.
    const capSize = Math.max(10, Math.min(14, Math.round(grid.w / 17)));
    const capHeight = Math.round(capSize * 1.5);

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
    // ── THE STAT TILES, in Trevor's order (2026-09-12) ────────────────────
    //
    // ⚠ "—" MEANS THE READ FAILED, NEVER THAT THE VALUE IS ZERO. This card
    // makes claims about a NAMED person and bakes them into an edge-cached PNG
    // that lands in other people's timelines, so every figure here is withheld
    // rather than guessed.
    //
    // ⭐ TILE 2 KEEPS ONE COMBINED TOTAL AND CHANGES ONLY ITS LABEL. Trevor:
    // the label should "encompass all of the naming nomenclatures of the
    // individual collectibles" — Moments (Top Shot, All Day, LaLiga), Pins
    // (Pinnacle), Cards (Candy/Panini when they land). Do NOT split it per
    // collection.
    //
    // ⭐ PACKS STAND ALONE. Trevor: "Packs should standalone. This is on brand
    // for Rip Packs City." Not a sub-line of the Moments tile.
    //
    // ⛔ THE FIFTH TILE TREVOR ASKED FOR — PACKS UNOPENED — IS DELIBERATELY NOT
    // HERE, and it is not an oversight. Nothing in this database answers it:
    // `pack_purchases` is not an acquisition ledger (Trevor has 503 rips against
    // 133 purchase rows), packs LEAVE a wallet sealed (5 of those 133 were
    // opened by a different address), so `purchases − rips` is wrong in both
    // directions at once; and every `total_unopened` / `total_sealed` column in
    // the schema is distribution-level SUPPLY, not per-wallet holdings. It needs
    // a Flow chain read for sealed pack NFTs per wallet, cached like
    // `cached_moment_count` — an ingest, not a card change. A "close enough"
    // number on the most-shared surface in the product is precisely what the
    // accuracy gate exists to stop, and this is the one surface where nobody
    // looking at it can check.
    const statTiles: Array<{ label: string; value: string; small?: boolean }> = [
      // TEAMS is SUPPRESSED rather than drawn empty. 4 of 25 accounts have a
      // pick today, so an always-present tile would ship 21 empty boxes — which
      // is why the reflow (statTileWidth + flexWrap) had to exist before the
      // tile, not after it.
      ...(teamsValue
        ? [{ label: "TEAMS", value: teamsValue.toUpperCase(), small: true }]
        : []),
      {
        label: "MOMENTS / PINS / CARDS",
        value: walletsOk && totalMoments > 0 ? totalMoments.toLocaleString() : "—",
      },
      {
        label: "PACKS RIPPED",
        // `ripsRes.count` is null when the read failed AND when there was no
        // address to ask about — both are "we do not know", never "zero".
        value: ripsRes.ok && ripsRes.count != null ? ripsRes.count.toLocaleString() : "—",
      },
      {
        label: "TROPHY CASE",
        value: trophiesOk ? filledTrophyCount + " / 6" : "—",
      },
    ];
    const tileWidth = statTileWidth(statTiles.length);

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
                  flexWrap: "wrap",
                  gap: 16,
                  marginTop: 26,
                  maxWidth: 700,
                }}
              >
                {statTiles.map((s) => (
                  <div
                    key={s.label}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      padding: "16px 20px",
                      background: "rgba(255,255,255,0.03)",
                      border: "1px solid rgba(255,255,255,0.07)",
                      borderRadius: 10,
                      width: tileWidth,
                    }}
                  >
                    <div
                      style={{
                        color: "#fff",
                        // Team abbreviations are a string, not a figure — three
                        // of them do not fit the tile at 36.
                        fontSize: s.small ? 26 : 36,
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
                      // The badge strip below is absolutely positioned against
                      // this slab, not the case, so it tracks the tile at every
                      // grid size.
                      position: "relative",
                      background: "#111",
                      boxShadow: "0 10px 24px rgba(0,0,0,0.5)",
                    }}
                  >
                    {t.thumbnail_url ? (
                      <img
                        src={t.thumbnail_url}
                        width={grid.w}
                        height={grid.h}
                        style={{ width: grid.w, height: grid.h, objectFit: "cover" }}
                      />
                    ) : (
                      <div
                        style={{
                          width: grid.w,
                          height: grid.h,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          padding: 8,
                          textAlign: "center",
                          color: "rgba(255,255,255,0.3)",
                          fontSize: 10,
                          fontFamily: mono,
                          letterSpacing: 2,
                        }}
                      >
                        ART UNAVAILABLE
                      </div>
                    )}
                    {/* Serial + tier, sitting directly on top of the badge
                        strip. ⭐ A special serial is GOLD — a 1-of-1 is the
                        most impressive object in a case and this card was
                        silent about it until 2026-09-12.
                        ⚠ ABSOLUTELY POSITIONED, like the badge strip below it
                        and for the same reason: the slab is a fixed-size tile
                        and an in-flow line would change its height, which is
                        how a Moment ends up sitting lower than its neighbours.
                        Absolute costs the grid nothing. */}
                    {t.detail.serial !== "" && (
                      <div
                        style={{
                          position: "absolute",
                          left: 0,
                          right: 0,
                          bottom: t.marks.length > 0 ? markSize + 8 : 0,
                          height: capHeight,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          gap: 4,
                          background: "rgba(0,0,0,0.72)",
                          fontFamily: mono,
                          fontSize: capSize,
                          letterSpacing: 0.4,
                          // ⚠ BOUNDED TO THE SLAB. This strip had no width and
                          // no overflow, so a long pair simply spilled outside
                          // the tile it captions. It FITS TODAY and the guard is
                          // for the pins that do not exist yet: measured over
                          // every moment anyone actually holds, the longest
                          // serial line is 18 characters and the longest tier
                          // 10, which at 0.54em + 0.4 letter-spacing is
                          // 28 x 5.8 + the 4px gap = 166px inside a 130px
                          // six-slab tile. The widest live pair today is 20
                          // characters (120px), so nothing visible changes.
                          // ⛔ nowrap, not just overflow: WRAPPING is the worse
                          // failure — a second line in a fixed-height strip is
                          // sliced through the middle (the sibling card's Simba
                          // case, same day).
                          maxWidth: grid.w,
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                        }}
                      >
                        <span
                          style={{
                            color: t.detail.special ? GOLD_HEX : "rgba(255,255,255,0.75)",
                            fontWeight: t.detail.special ? 900 : 400,
                          }}
                        >
                          {t.detail.serial}
                        </span>
                        {t.detail.tier !== "" && (
                          <span style={{ color: tierAccent(t.tier) }}>{t.detail.tier}</span>
                        )}
                      </div>
                    )}
                    {/* Badge strip. ⚠ Over a SCRIM, not over bare art — these
                        are monoline glyphs and Top Shot stills are frequently
                        near-white at the bottom edge, where a gold medal on a
                        white jersey is invisible. The scrim is what makes the
                        badge legible on every Moment rather than on most. */}
                    {t.marks.length > 0 && (
                      <div
                        style={{
                          position: "absolute",
                          left: 0,
                          right: 0,
                          bottom: 0,
                          height: markSize + 8,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          gap: 4,
                          background: "rgba(0,0,0,0.72)",
                        }}
                      >
                        {t.marks.map((m: TrophyMark) => (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            key={m.label}
                            src={m.uri}
                            alt={m.label}
                            width={markSize}
                            height={markSize}
                            style={{ width: markSize, height: markSize }}
                          />
                        ))}
                      </div>
                    )}
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
