// lib/concierge/edition-metadata.ts
//
// The concierge's window onto an edition's METADATA — the badges (Top Shot
// moment tags), team, series, parallel, and the supply picture (circulation /
// burned / locked / effective supply) — read from `badge_editions`, the table
// the Collection / Market / Sniper rows already render from.
//
// Why this exists (Trevor, 2026-06-25, logged as feedback #4064): the bot
// "lacks awareness of badge context (Rookie Year, Top Shot Debut) when
// surfacing or ranking moment value". The prompt rule that shipped for it
// could only use badges that a tool row already carried, and the two price
// tools a collector actually reaches for — get_fmv and get_edition_listings —
// carried none. So the model priced a Cooper Flagg Legendary without knowing
// it was his rookie, then told the user it "could not factor badges in".
// Every priced edition the concierge hands back now carries this block.
//
// ⚠ HONESTY: a FAILED read is not "no badges". `status: "error"` is distinct
// from an edition that genuinely carries no tag, and callers must forward that
// distinction (a `badges: []` produced by a timeout would let the model say
// "this moment has no badges" — the failed-read-as-answer class).
//
// Coverage (measured 2026-09-13, re-measure before quoting): play_tags are
// populated for NBA Top Shot only — 5,395 of 13,915 Top Shot rows carry at
// least one tag; every All Day and Golazos row carries none. Supply columns
// (circulation / burned / locked) exist for all three. Pinnacle and UFC have no
// badge_editions rows at all.

export type EditionMetadata = {
  external_id: string;
  /** Top Shot moment-tag titles, deduplicated ("Rookie Year", "Top Shot Debut"). */
  badges: string[];
  team: string | null;
  series_number: number | null;
  /** Parallel / subedition name; null when the edition is the base. */
  parallel_name: string | null;
  circulation_count: number | null;
  burned: number | null;
  locked: number | null;
  /** circulation minus burned — what still exists on chain. */
  effective_supply: number | null;
  /** Share of the effective supply that is challenge-locked or burned, 0..100. */
  squeeze_pct: number | null;
  has_rookie_mint: boolean | null;
  is_three_star_rookie: boolean | null;
  /** Retired on Flow — no further mints. */
  flow_retired: boolean | null;
  /** When this metadata row last changed. */
  metadata_as_of: string | null;
};

export type EditionMetadataResult = {
  /** ok = read succeeded (a key absent from byKey has NO metadata row) · error = read FAILED · skipped = not attempted (no collection / no keys / unsupported collection). */
  status: "ok" | "error" | "skipped";
  byKey: Map<string, EditionMetadata>;
  message?: string;
};

// The collections `badge_editions` carries rows for. Pinnacle keys are render
// ids and UFC has no rows; attempting the read there would return an honest
// empty that reads, to the model, like "no badges" — so skip and say why.
const METADATA_COLLECTION_UUIDS = new Set<string>([
  "95f28a17-224a-4025-96ad-adf8a4c63bfd", // nba_top_shot
  "dee28451-5d62-409e-a1ad-a83f763ac070", // nfl_all_day
  "06248cc4-b85f-47cd-af67-1855d14acd75", // laliga_golazos
]);
const TOP_SHOT_UUID = "95f28a17-224a-4025-96ad-adf8a4c63bfd";

export const BADGES_NOTE =
  "badges are NBA Top Shot moment tags (Rookie Year, Top Shot Debut, Championship Year, Rookie Premiere, MVP Year, Rookie of the Year, Challenge / Leaderboard Reward). Factor them into any ranking or 'why is this worth more' answer. An empty list on a Top Shot row means the edition carries no tag; other collections have parallels/variants rather than moment tags, so an empty list there says nothing.";

/** Dedupe a `play_tags` jsonb array ([{id,title}, …]) to its titles. */
export function badgeTitles(playTags: unknown): string[] {
  if (!Array.isArray(playTags)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of playTags) {
    const title = typeof t === "string" ? t : t && typeof t === "object" ? (t as { title?: unknown }).title : null;
    if (typeof title !== "string") continue;
    const clean = title.trim();
    if (!clean || seen.has(clean.toLowerCase())) continue;
    seen.add(clean.toLowerCase());
    out.push(clean);
  }
  return out;
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function bool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

export function squeezePct(circulation: number | null, burned: number | null, locked: number | null): number | null {
  if (circulation == null || circulation <= 0) return null;
  const b = burned ?? 0;
  const l = locked ?? 0;
  return Math.round(((b + l) / circulation) * 1000) / 10;
}

/** Shape one raw badge_editions row into the model-facing block. */
export function toEditionMetadata(row: Record<string, unknown>): EditionMetadata {
  const circulation = num(row.circulation_count);
  const burned = num(row.burned);
  const locked = num(row.locked);
  const parallel = typeof row.parallel_name === "string" && row.parallel_name.trim() ? row.parallel_name.trim() : null;
  return {
    external_id: String(row.external_id),
    badges: badgeTitles(row.play_tags),
    team: typeof row.team === "string" && row.team ? row.team : null,
    series_number: num(row.series_number),
    parallel_name: parallel,
    circulation_count: circulation,
    burned,
    locked,
    effective_supply: num(row.effective_supply) ?? (circulation != null ? circulation - (burned ?? 0) : null),
    squeeze_pct: squeezePct(circulation, burned, locked),
    has_rookie_mint: bool(row.has_rookie_mint),
    is_three_star_rookie: bool(row.is_three_star_rookie),
    flow_retired: bool(row.flow_retired),
    metadata_as_of: typeof row.updated_at === "string" ? row.updated_at : null,
  };
}

const SELECT_COLS =
  "external_id, play_tags, team, series_number, parallel_name, circulation_count, burned, locked, effective_supply, has_rookie_mint, is_three_star_rookie, flow_retired, updated_at";

/**
 * Read metadata for up to a few hundred edition keys in one collection.
 * Chunked at 200 keys so a bare `.in()` never blows PostgREST's URL cap.
 * Never throws: an error is REPORTED, never swallowed into an empty map.
 */
// The minimal query surface this module uses — keeps the file free of `any`.
type MetadataQuery = {
  select: (cols: string) => MetadataQuery;
  eq: (col: string, v: string) => MetadataQuery;
  in: (col: string, v: string[]) => PromiseLike<{ data: Array<Record<string, unknown>> | null; error: { message: string } | null }>;
};
export type MetadataClient = { from: (t: string) => MetadataQuery };

export async function fetchEditionMetadata(
  supabase: MetadataClient,
  collectionUuid: string | null | undefined,
  externalIds: Array<string | null | undefined>,
): Promise<EditionMetadataResult> {
  const keys = Array.from(new Set(externalIds.filter((k): k is string => typeof k === "string" && k.length > 0)));
  const byKey = new Map<string, EditionMetadata>();
  if (!collectionUuid || keys.length === 0) {
    return { status: "skipped", byKey, message: "no collection or no edition keys" };
  }
  if (!METADATA_COLLECTION_UUIDS.has(collectionUuid)) {
    return { status: "skipped", byKey, message: "badge/supply metadata is indexed for Top Shot, All Day and Golazos only" };
  }
  try {
    for (let i = 0; i < keys.length; i += 200) {
      const { data, error } = await supabase
        .from("badge_editions")
        .select(SELECT_COLS)
        .eq("collection_id", collectionUuid)
        .in("external_id", keys.slice(i, i + 200));
      if (error) {
        return { status: "error", byKey: new Map(), message: "edition metadata read failed" };
      }
      for (const row of (data ?? []) as Array<Record<string, unknown>>) {
        if (typeof row.external_id !== "string") continue;
        byKey.set(row.external_id, toEditionMetadata(row));
      }
    }
    return { status: "ok", byKey };
  } catch {
    return { status: "error", byKey: new Map(), message: "edition metadata read failed" };
  }
}

/**
 * The fields a tool attaches to ONE edition row. `badges` is only ever null
 * when the read failed or was skipped — a Top Shot edition with no tag gets
 * `[]`, so the model can tell "none" from "could not check".
 */
export function metadataFieldsFor(
  result: EditionMetadataResult,
  externalId: string | null | undefined,
  collectionUuid: string | null | undefined,
): {
  badges: string[] | null;
  badges_status: "ok" | "unavailable" | "not_tracked";
  team: string | null;
  series_number: number | null;
  parallel_name: string | null;
  supply: { circulation: number | null; burned: number | null; locked: number | null; effective: number | null; squeeze_pct: number | null } | null;
  rookie_flags: { has_rookie_mint: boolean | null; is_three_star_rookie: boolean | null } | null;
  metadata_as_of: string | null;
} {
  const m = externalId ? result.byKey.get(externalId) : undefined;
  if (result.status === "error") {
    return { badges: null, badges_status: "unavailable", team: null, series_number: null, parallel_name: null, supply: null, rookie_flags: null, metadata_as_of: null };
  }
  if (result.status === "skipped" || !m) {
    // Not tracked for this collection, or no metadata row for this key. Both
    // are "we hold nothing", never "it has nothing" — except on Top Shot, where
    // a missing row is rare and still not a claim about tags.
    return { badges: null, badges_status: "not_tracked", team: null, series_number: null, parallel_name: null, supply: null, rookie_flags: null, metadata_as_of: null };
  }
  const tagsTracked = collectionUuid === TOP_SHOT_UUID;
  return {
    badges: tagsTracked ? m.badges : m.badges.length ? m.badges : null,
    badges_status: tagsTracked || m.badges.length ? "ok" : "not_tracked",
    team: m.team,
    series_number: m.series_number,
    parallel_name: m.parallel_name,
    supply: {
      circulation: m.circulation_count,
      burned: m.burned,
      locked: m.locked,
      effective: m.effective_supply,
      squeeze_pct: m.squeeze_pct,
    },
    rookie_flags: { has_rookie_mint: m.has_rookie_mint, is_three_star_rookie: m.is_three_star_rookie },
    metadata_as_of: m.metadata_as_of,
  };
}
