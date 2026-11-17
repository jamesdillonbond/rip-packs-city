// Pinnacle catalog rows read straight from the Flow chain (2026-11-09).
//
// The catalog backfill copies Dapper's `searchPinnacleEditions`. On 11-08 a new drop (Walt
// Disney Mugs Vol.1 + five Friends-Giving Vol.2 chasers, 30 renders) was minted on chain and
// Dapper's search still returned NONE of it a day later, so every pin from it rendered with no
// name, set or value. The Pinnacle contract itself holds everything a catalog row needs
// (edition → shape → set → series → edition type), and RPC's mint records carry each render's
// on-chain edition id (the same id the catalog stores as `edition_id`: 394/394 checked).
//
// This module reads those editions in one Cadence script and builds rows in exactly the shape
// `buildRow` in app/api/admin/backfill-pinnacle-catalog/route.ts writes, tagged
// `source: "flow-chain"`. The caller inserts them FILL-ONLY, so Dapper's row replaces a chain
// row on the next sweep that returns it, and a chain row never overwrites a Dapper one.

export const FLOW_REST = "https://rest-mainnet.onflow.org/v1/scripts";
const PER_REQUEST_TIMEOUT_MS = 20_000;
export const CHAIN_BATCH = 50;

export const CHAIN_EDITIONS_SCRIPT = `import Pinnacle from 0xedf9df96c92f4595
access(all) fun main(ids: [Int]): [AnyStruct] {
  let out: [AnyStruct] = []
  for id in ids {
    if let e = Pinnacle.getEdition(id: id) {
      if let s = Pinnacle.getShape(id: e.shapeID) {
        if let st = Pinnacle.getSet(id: s.setID) {
          out.append({"edition": e, "shape": s, "set": st,
                      "series": Pinnacle.getSeries(id: e.seriesID),
                      "editionType": Pinnacle.getEditionType(id: e.editionTypeID)})
        }
      }
    }
  }
  return out
}`;

type Cdc = { type?: string; value?: unknown };

/** JSON-Cadence → plain JS (structs/resources to objects, dictionaries keyed by their string form). */
export function decodeCdc(v: Cdc | null | undefined): unknown {
  if (!v || typeof v !== "object") return null;
  const t = v.type;
  const x = v.value as any;
  switch (t) {
    case "Struct":
    case "Resource":
      return Object.fromEntries((x?.fields ?? []).map((f: { name: string; value: Cdc }) => [f.name, decodeCdc(f.value)]));
    case "Dictionary":
      return Object.fromEntries((x ?? []).map((kv: { key: Cdc; value: Cdc }) => [String(decodeCdc(kv.key)), decodeCdc(kv.value)]));
    case "Array":
      return (x ?? []).map((i: Cdc) => decodeCdc(i));
    case "Optional":
      return x == null ? null : decodeCdc(x);
    default:
      return x ?? null;
  }
}

function strList(v: unknown): string[] | null {
  if (v == null) return null;
  const arr = Array.isArray(v) ? v : [v];
  const out = arr.map((s) => String(s).trim()).filter((s) => s.length > 0);
  return out.length ? out : null;
}
function jsonList(v: unknown): string | null {
  const l = strList(v);
  return l ? JSON.stringify(l) : null;
}
function int(v: unknown): number | null {
  if (v == null) return null;
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : null;
}

/** One decoded {edition, shape, set, series, editionType} entry → a pinnacle_catalog row. */
export function chainEntryToRow(entry: any, nowIso: string) {
  const e = entry?.edition, s = entry?.shape, st = entry?.set;
  const renderId: string | null = e?.renderID ?? null;
  if (!renderId || !s || !st) return null;
  const md = (s.metadata ?? {}) as Record<string, unknown>;
  const royaltyCodes = strList(md.RoyaltyCodes);
  const royaltyCode = royaltyCodes?.[0] ?? null;
  const variant: string | null = e.variant ?? null;
  const printing = int(e.printing);
  const traits = (e.traits ?? {}) as Record<string, unknown>;
  const str = (k: string) => (traits[k] == null ? null : String(traits[k]));
  return {
    render_id: renderId,
    edition_id: String(e.id),
    shape_render_id: s.renderID ?? null,
    character_name: s.name ?? null,
    set_name: st.name ?? null,
    set_render_id: st.renderID ?? null,
    variant,
    parallel_type: null,
    printing,
    total_minted: int(e.numberMinted),
    edition_type: entry?.editionType?.name ?? null,
    limited_edition: entry?.editionType?.isLimited ?? null,
    series_name: entry?.series?.name ?? null,
    royalty_code: royaltyCode,
    royalty_codes: royaltyCodes,
    franchises: strList(md.Franchises),
    characters: strList(md.Characters),
    color: str("Color"),
    effects: jsonList(traits.Effects),
    materials: jsonList(traits.Materials),
    size: str("Size"),
    thickness: str("Thickness"),
    is_chaser: typeof e.isChaser === "boolean" ? e.isChaser : null,
    legacy_edition_key:
      royaltyCode && variant != null && printing != null ? `${royaltyCode}:${variant}:${printing}` : null,
    thumbnail_url: `/api/public/pinnacle-image/${renderId}`,
    front_anim_url: `https://assets.disneypinnacle.com/render/${renderId}/front_anim.webp`,
    source: "flow-chain",
    updated_at: nowIso,
  };
}

export type ChainCatalogRow = NonNullable<ReturnType<typeof chainEntryToRow>>;

function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}

/**
 * Read catalog rows for these on-chain edition ids. Never throws: a failed batch is reported in
 * `errors` and the rows from the batches that worked are still returned.
 */
export async function fetchChainCatalogRows(
  editionIds: number[],
  fetchImpl: typeof fetch = fetch,
): Promise<{ rows: ChainCatalogRow[]; errors: string[] }> {
  const ids = [...new Set(editionIds.filter((n) => Number.isInteger(n) && n > 0))];
  const rows: ChainCatalogRow[] = [];
  const errors: string[] = [];
  const nowIso = new Date().toISOString();
  for (let i = 0; i < ids.length; i += CHAIN_BATCH) {
    const batch = ids.slice(i, i + CHAIN_BATCH);
    const arg = { type: "Array", value: batch.map((n) => ({ type: "Int", value: String(n) })) };
    try {
      const res = await fetchImpl(FLOW_REST, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ script: b64(CHAIN_EDITIONS_SCRIPT), arguments: [b64(JSON.stringify(arg))] }),
        signal: AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS),
      });
      const text = await res.text();
      if (!res.ok) {
        errors.push(`flow script HTTP ${res.status}: ${text.slice(0, 160)}`);
        continue;
      }
      const decoded = decodeCdc(JSON.parse(Buffer.from(JSON.parse(text), "base64").toString("utf8")));
      for (const entry of Array.isArray(decoded) ? decoded : []) {
        const row = chainEntryToRow(entry, nowIso);
        if (row) rows.push(row);
      }
    } catch (e) {
      errors.push(`flow script: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { rows, errors };
}
