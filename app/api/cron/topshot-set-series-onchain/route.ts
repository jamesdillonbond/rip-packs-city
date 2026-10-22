import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { writeInvocationHeartbeat } from "@/lib/pipeline/heartbeat"
import { logTerminalRun } from "@/lib/pipeline/terminal-run"
import { SERIES_DISPLAY } from "@/lib/series-label"
import { SERIES_INT_TO_SEASON } from "@/lib/collection/helpers"

// Top Shot sets that have NO SERIES get one from the chain, and their editions
// follow.
//
// WHY THIS EXISTS (2026-09-25, known-issues #137 h). `catalog_topshot_from_atlas`
// creates a `sets` row with `series NULL` by construction — Atlas' badge_editions
// carries no series, and its `series_number` is read back FROM editions,
// circularly — so every set it discovers (13 on 09-24: "WNBA Bag Work", "WNBA
// Rookie Revelation", "Signature Style", …) and every edition under it (154)
// arrived without a series, and the site's series filters, share-card bars
// and the analytics split counted them as "No series". The chain has it:
// `TopShot.getSetSeries(setID)` (verified through Flow REST: 253/275/278/279 →
// 8, 140 → 6, 1 → 0, unknown → nil). The 09-25 migration filled the backlog;
// this keeps every future discovery filled within an hour (vercel.json
// `35 * * * *` since 2026-10-15 — was daily, so a set discovered on a launch day
// carried "No series" until ~9:35 PM PT; an idle run is one bounded read, ~150 ms).
//
// HOW. Read the Top Shot sets with `series IS NULL AND set_id_onchain IS NOT
// NULL` (bounded), one Cadence script for up to SETS_PER_SCRIPT ids (a single
// contract read per id — nowhere near the 40-pair ceiling the circulation
// route measured for its two-call pairs), write `sets.series` fill-only, then
// fill `editions.series` from the set for editions still NULL. ⚠ The DB stores
// the on-chain UInt32 VERBATIM — 0 and 1 are both real values (Series 1 is 0
// on chain) — so nothing here remaps; the display map owns that.
//
// HONESTY. A Flow REST failure is a pipeline failure (ok=false); a set the
// chain does not know is `not_on_chain` and stays NULL; the written counts are
// the rows the UPDATEs returned; a write error fails the run.
//
// Auth: `Bearer $CRON_SECRET` (Vercel cron) or `Bearer $INGEST_SECRET_TOKEN`.
// 202 + after(): heartbeat FIRST, terminal row LAST.

export const dynamic = "force-dynamic"
export const maxDuration = 120

const PIPELINE_NAME = "topshot-set-series-onchain"
const COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const FLOW_REST = process.env.FLOW_REST_URL ?? "https://rest-mainnet.onflow.org"
const SCRIPT_TIMEOUT_MS = 15_000
const MAX_SETS_PER_RUN = 200
const SETS_PER_SCRIPT = 40

/** `getSetSeries` returned nil — the set id is not a set on chain. */
export const NOT_ON_CHAIN = 4294967295

// Verified on mainnet 2026-09-25 through Flow REST against 0x0b2a3299cc857e29.
// Re-verify with the cadence MCP before any change — the repo's Cadence lint
// gate does not see scripts embedded in routes.
export const SET_SERIES_SCRIPT = `
import TopShot from 0x0b2a3299cc857e29
access(all) fun main(setIDs: [UInt32]): [UInt32] {
  let out: [UInt32] = []
  for id in setIDs { out.append(TopShot.getSetSeries(setID: id) ?? 4294967295) }
  return out
}
`

type SetRow = { id: string; set_id_onchain: number }

/** Decode the script's JSON-Cadence `[UInt32]`. Throws on any shape surprise. */
export function decodeSeriesArray(decoded: unknown, expected: number): number[] {
  const node = decoded as { type?: string; value?: unknown }
  if (!node || node.type !== "Array" || !Array.isArray(node.value)) {
    throw new Error("script result is not a JSON-Cadence Array")
  }
  const nums = (node.value as Array<{ value?: unknown }>).map((v) => {
    const n = Number(v?.value)
    if (!Number.isFinite(n)) throw new Error("non-numeric element in script result")
    return n
  })
  if (nums.length !== expected) throw new Error(`script returned ${nums.length} values for ${expected} sets`)
  return nums
}

async function readSeries(sets: SetRow[]): Promise<number[]> {
  const arg = { type: "Array", value: sets.map((s) => ({ type: "UInt32", value: String(s.set_id_onchain) })) }
  const body = {
    script: Buffer.from(SET_SERIES_SCRIPT, "utf8").toString("base64"),
    arguments: [Buffer.from(JSON.stringify(arg), "utf8").toString("base64")],
  }
  const res = await fetch(`${FLOW_REST}/v1/scripts?block_height=sealed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SCRIPT_TIMEOUT_MS),
  })
  if (!res.ok) {
    const snippet = await res.text().then((t) => t.slice(0, 200).replace(/\s+/g, " ")).catch(() => "")
    throw new Error(`Flow REST HTTP ${res.status}${snippet ? `: ${snippet}` : ""}`)
  }
  const json = (await res.json()) as { value?: string } | string
  const raw = typeof json === "string" ? json : String(json.value ?? "")
  if (!raw) throw new Error("Flow REST returned an empty script result")
  const decoded = JSON.parse(Buffer.from(raw.trim().replace(/^"|"$/g, ""), "base64").toString("utf8"))
  return decodeSeriesArray(decoded, sets.length)
}

async function readUnseriesedSets(): Promise<{ rows: SetRow[]; complete: boolean }> {
  const { data, error } = await (supabaseAdmin as any)
    .from("sets")
    .select("id,set_id_onchain")
    .eq("collection_id", COLLECTION_ID)
    .is("series", null)
    .not("set_id_onchain", "is", null)
    .order("set_id_onchain", { ascending: true })
    .limit(MAX_SETS_PER_RUN + 1)
  if (error) throw new Error(`sets read failed: ${error.message}`)
  const rows = (data ?? []) as SetRow[]
  return { rows: rows.slice(0, MAX_SETS_PER_RUN), complete: rows.length <= MAX_SETS_PER_RUN }
}

/**
 * Catch-up: editions still NULL whose set ALREADY carries a series. The main
 * loop fills a set's editions only in the run that writes the set, and the next
 * run no longer selects that set — so an editions write that failed after its
 * set write landed would leave those editions NULL for good. This pass does not
 * depend on this run's set writes. Returns rows that LANDED, or throws.
 */
async function fillStrandedEditions(): Promise<{ written: number; sets: number }> {
  const { data: eds, error } = await (supabaseAdmin as any)
    .from("editions")
    .select("set_id_onchain")
    .eq("collection_id", COLLECTION_ID)
    .is("series", null)
    .not("set_id_onchain", "is", null)
    .order("set_id_onchain", { ascending: true })
    .limit(1000)
  if (error) throw new Error(`stranded editions read failed: ${error.message}`)
  const setIds = [...new Set(((eds ?? []) as { set_id_onchain: number }[]).map((r) => r.set_id_onchain))]
  if (setIds.length === 0) return { written: 0, sets: 0 }
  const { data: sets, error: setErr } = await (supabaseAdmin as any)
    .from("sets")
    .select("set_id_onchain,series")
    .eq("collection_id", COLLECTION_ID)
    .in("set_id_onchain", setIds)
    .not("series", "is", null)
    .limit(setIds.length)
  if (setErr) throw new Error(`stranded sets read failed: ${setErr.message}`)
  let written = 0
  let filledSets = 0
  for (const st of (sets ?? []) as { set_id_onchain: number; series: number }[]) {
    const { data, error: upErr } = await (supabaseAdmin as any)
      .from("editions")
      .update({ series: st.series })
      .eq("collection_id", COLLECTION_ID)
      .eq("set_id_onchain", st.set_id_onchain)
      .is("series", null)
      .select("id")
    if (upErr) throw new Error(`stranded editions write failed: ${upErr.message}`)
    const n = Array.isArray(data) ? data.length : 0
    written += n
    if (n > 0) filledSets++
  }
  return { written, sets: filledSets }
}

/**
 * A NEW Top Shot series needs a `collection_series` row before the site can show
 * it: the series page (`get_series_detail` resolves a slug from its label), the
 * Collection tab's series filter (/api/collection-series) and the sitemap all
 * read that table, and nothing else writes it. Added 2026-10-15 ahead of Series
 * 2026-27: once a set on chain carries a series the table lacks, register it —
 * but only with a label the repo's canonical map KNOWS (SERIES_DISPLAY). A series
 * with no known label is reported (`unlabelled_series`) and left alone, so a
 * surprise series number becomes an alarm, never a guessed page title.
 */
async function registerNewSeries(): Promise<{ registered: number[]; unlabelled: number[] }> {
  const { data: setRows, error: setErr } = await (supabaseAdmin as any)
    .from("sets")
    .select("series")
    .eq("collection_id", COLLECTION_ID)
    .not("series", "is", null)
    .limit(1000)
  if (setErr) throw new Error(`series census read failed: ${setErr.message}`)
  const present = [...new Set(((setRows ?? []) as { series: number | null }[])
    .map((r) => r.series)
    .filter((n): n is number => typeof n === "number" && Number.isFinite(n)))]
  if (present.length === 0) return { registered: [], unlabelled: [] }

  const { data: known, error: knownErr } = await (supabaseAdmin as any)
    .from("collection_series")
    .select("series_number")
    .eq("collection_id", COLLECTION_ID)
    .limit(1000)
  if (knownErr) throw new Error(`collection_series read failed: ${knownErr.message}`)
  const have = new Set(((known ?? []) as { series_number: number }[]).map((r) => Number(r.series_number)))

  const missing = present.filter((n) => !have.has(n)).sort((a, b) => a - b)
  const labelled = missing.filter((n) => SERIES_DISPLAY[n])
  const unlabelled = missing.filter((n) => !SERIES_DISPLAY[n])
  if (labelled.length === 0) return { registered: [], unlabelled }

  const { data: ins, error: insErr } = await (supabaseAdmin as any)
    .from("collection_series")
    .upsert(
      labelled.map((n) => ({
        collection_id: COLLECTION_ID,
        series_number: n,
        display_label: SERIES_DISPLAY[n],
        season: SERIES_INT_TO_SEASON[n] ?? null,
      })),
      { onConflict: "collection_id,series_number", ignoreDuplicates: true },
    )
    .select("series_number")
  if (insErr) throw new Error(`collection_series write failed: ${insErr.message}`)
  const registered = ((ins ?? []) as { series_number: number }[]).map((r) => Number(r.series_number))
  return { registered, unlabelled }
}

// ── Play metadata (game_date / play_type / play_category) ────────────────────
//
// WHY (2026-10-21, Series 2026-27 launch day). `catalog_topshot_from_atlas`
// creates editions WITHOUT `game_date`, `play_type` or `play_category` (Atlas'
// badge_editions carries none of them), and the only writer that ever filled
// them from chain — POST /api/backfill-edition-names — has no scheduled caller
// (and also overwrites `circulation_count` with the raw mint count, which would
// undo topshot_normalize_circulation, so it must NOT be revived as-is). Result:
// every Top Shot edition catalogued since ~2026-09-04 (1,460 rows / 685 plays on
// 10-21, incl. all of Series 2026-27) had `game_date` NULL, and the Team
// Checklist's 'contemporary' scope (`play_season = series_season`, play_season
// derived from game_date) silently dropped them. Probed 10-21 via Flow REST over
// those 685 plays: 488 carry a DateOfMoment in one of THREE formats (ISO
// "2026-10-20T23:00:00Z" 13, "2022-10-24 00:30:00 +0000 UTC" 284, US
// "9/27/2026" 191 — month ≤ 10 and day up to 31 across all 191, so M/D, never
// D/M); 197 OLD plays (ids 3506–6363) carry an EMPTY DateOfMoment and stay NULL
// (counted as `no_date`, never guessed).
//
// HOW. Read editions still missing `game_date` (newest play first, so a launch
// day's plays go first), take up to MAX_PLAYS_PER_RUN distinct plays, one script
// per PLAYS_PER_SCRIPT ids, then FILL-ONLY writes keyed on the column being NULL.
// The date is the UTC calendar date of `DateOfMoment` (`slice(0,10)`) — the
// convention every already-filled row uses (verified 10-21 on 9 plays across
// 2022 and 2026); a US date carries no time, so it is taken as written. Counts
// are rows the UPDATEs RETURNED; a script or write error fails the run. ⚠ The
// dateless plays never leave the read, so the cap must stay ABOVE their count
// (197 on 10-21) or they choke everything older than them (at 200 the old
// backlog advanced 3 plays a run). `play_meta.no_date` watches it; if it nears
// MAX_PLAYS_PER_RUN, move this lane to a cursor.
const MAX_PLAYS_PER_RUN = 400
const PLAYS_PER_SCRIPT = 40
const PLAY_META_CONCURRENCY = 8

// Verified on mainnet 2026-10-21 through Flow REST (685 plays, 18 calls).
export const PLAY_META_SCRIPT = `
import TopShot from 0x0b2a3299cc857e29
access(all) fun main(playIDs: [UInt32]): [[String?]] {
  let out: [[String?]] = []
  for id in playIDs {
    let m = TopShot.getPlayMetaData(playID: id) ?? {}
    out.append([m["DateOfMoment"], m["PlayType"], m["PlayCategory"]])
  }
  return out
}
`

export type PlayMeta = { gameDate: string | null; playType: string | null; playCategory: string | null }

/** `DateOfMoment` → a calendar date, or null. ISO forms ("2026-10-20T23:00:00Z",
 *  "2022-10-23 02:00:00 +0000 UTC") → their UTC date (the first 10 chars); the
 *  US form "9/27/2026" → "2026-09-27". Anything else (incl. "") → null. */
export function toGameDate(raw: string | null | undefined): string | null {
  if (!raw) return null
  const t = raw.trim()
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t)
  if (us) {
    const [mo, da, yr] = [Number(us[1]), Number(us[2]), Number(us[3])]
    if (mo < 1 || mo > 12 || da < 1 || da > 31) return null
    return `${yr}-${String(mo).padStart(2, "0")}-${String(da).padStart(2, "0")}`
  }
  const d = t.slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null
}

/** Decode the script's JSON-Cadence `[[String?]]`. Throws on any shape surprise. */
export function decodePlayMetaArray(decoded: unknown, expected: number): PlayMeta[] {
  const node = decoded as { type?: string; value?: unknown }
  if (!node || node.type !== "Array" || !Array.isArray(node.value)) {
    throw new Error("play-meta result is not a JSON-Cadence Array")
  }
  const rows = (node.value as Array<{ type?: string; value?: unknown }>).map((row) => {
    if (!row || row.type !== "Array" || !Array.isArray(row.value) || row.value.length !== 3) {
      throw new Error("play-meta row is not a 3-element Array")
    }
    const str = (cell: any): string | null => {
      // Optional(String) → { type: "Optional", value: null | { type: "String", value } }
      const inner = cell?.type === "Optional" ? cell.value : cell
      if (inner == null) return null
      if (inner.type !== "String" || typeof inner.value !== "string") throw new Error("play-meta cell is not a String")
      return inner.value.trim() === "" ? null : inner.value
    }
    const [date, type, category] = (row.value as unknown[]).map(str)
    return { gameDate: toGameDate(date), playType: type, playCategory: category }
  })
  if (rows.length !== expected) throw new Error(`play-meta script returned ${rows.length} rows for ${expected} plays`)
  return rows
}

async function readPlayMeta(playIds: number[]): Promise<PlayMeta[]> {
  const arg = { type: "Array", value: playIds.map((p) => ({ type: "UInt32", value: String(p) })) }
  const body = {
    script: Buffer.from(PLAY_META_SCRIPT, "utf8").toString("base64"),
    arguments: [Buffer.from(JSON.stringify(arg), "utf8").toString("base64")],
  }
  const res = await fetch(`${FLOW_REST}/v1/scripts?block_height=sealed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SCRIPT_TIMEOUT_MS),
  })
  if (!res.ok) {
    const snippet = await res.text().then((t) => t.slice(0, 200).replace(/\s+/g, " ")).catch(() => "")
    throw new Error(`Flow REST HTTP ${res.status}${snippet ? `: ${snippet}` : ""}`)
  }
  const json = (await res.json()) as { value?: string } | string
  const raw = typeof json === "string" ? json : String(json.value ?? "")
  if (!raw) throw new Error("Flow REST returned an empty script result")
  const decoded = JSON.parse(Buffer.from(raw.trim().replace(/^"|"$/g, ""), "base64").toString("utf8"))
  return decodePlayMetaArray(decoded, playIds.length)
}

type PlayMetaResult = {
  plays: number
  editions_dated: number
  editions_typed: number
  editions_categorised: number
  no_date: number
  script_calls: number
  script_errors: number
  write_errors: number
  complete: boolean
  error: string | null
}

async function fillPlayMetadata(): Promise<PlayMetaResult> {
  const out: PlayMetaResult = {
    plays: 0, editions_dated: 0, editions_typed: 0, editions_categorised: 0, no_date: 0,
    script_calls: 0, script_errors: 0, write_errors: 0, complete: true, error: null,
  }
  const { data, error } = await (supabaseAdmin as any)
    .from("editions")
    .select("play_id_onchain,play_type,play_category")
    .eq("collection_id", COLLECTION_ID)
    .is("game_date", null)
    .not("play_id_onchain", "is", null)
    .order("play_id_onchain", { ascending: false })
    .limit(1000)
  if (error) throw new Error(`play-meta editions read failed: ${error.message}`)
  const rows = (data ?? []) as { play_id_onchain: unknown; play_type: string | null; play_category: string | null }[]

  // Per play: does any NULL-date edition also lack a type / a category?
  const needs = new Map<number, { type: boolean; category: boolean }>()
  for (const r of rows) {
    const p = Number(r.play_id_onchain)
    if (!Number.isInteger(p) || p <= 0) continue
    const n = needs.get(p) ?? { type: false, category: false }
    if (r.play_type == null) n.type = true
    if (r.play_category == null) n.category = true
    needs.set(p, n)
  }
  const all = [...needs.keys()]
  const plays = all.slice(0, MAX_PLAYS_PER_RUN)
  out.plays = plays.length
  out.complete = all.length <= MAX_PLAYS_PER_RUN && rows.length < 1000
  if (plays.length === 0) return out

  const fill = async (playId: number, col: "game_date" | "play_type" | "play_category", value: string) => {
    const { data: upd, error: upErr } = await (supabaseAdmin as any)
      .from("editions")
      .update({ [col]: value })
      .eq("collection_id", COLLECTION_ID)
      .eq("play_id_onchain", playId)
      .is(col, null)
      .select("id")
    if (upErr) {
      out.write_errors++
      out.error = out.error ?? `play-meta ${col} write: ${upErr.message}`
      return 0
    }
    return Array.isArray(upd) ? upd.length : 0
  }

  for (let i = 0; i < plays.length; i += PLAYS_PER_SCRIPT) {
    const chunk = plays.slice(i, i + PLAYS_PER_SCRIPT)
    let meta: PlayMeta[]
    try {
      out.script_calls++
      meta = await readPlayMeta(chunk)
    } catch (e) {
      out.script_errors++
      out.error = out.error ?? `play-meta flow rest: ${e instanceof Error ? e.message : String(e)}`
      continue
    }
    // `x += await f()` reads x BEFORE the await, so concurrent tasks would overwrite
    // each other's counts: await into a local first (caught by the route test, 10-21).
    const tasks: Array<() => Promise<void>> = []
    chunk.forEach((playId, k) => {
      const m = meta[k]
      const need = needs.get(playId)!
      if (!m.gameDate) out.no_date++
      else tasks.push(async () => { const n = await fill(playId, "game_date", m.gameDate!); out.editions_dated += n })
      if (need.type && m.playType) tasks.push(async () => { const n = await fill(playId, "play_type", m.playType!); out.editions_typed += n })
      if (need.category && m.playCategory) tasks.push(async () => { const n = await fill(playId, "play_category", m.playCategory!); out.editions_categorised += n })
    })
    for (let j = 0; j < tasks.length; j += PLAY_META_CONCURRENCY) {
      await Promise.all(tasks.slice(j, j + PLAY_META_CONCURRENCY).map((t) => t()))
    }
  }
  return out
}

function authorized(request: NextRequest): boolean {
  const auth = request.headers.get("authorization") ?? ""
  const cron = process.env.CRON_SECRET
  const ingest = process.env.INGEST_SECRET_TOKEN
  return (!!cron && auth === `Bearer ${cron}`) || (!!ingest && auth === `Bearer ${ingest}`)
}

async function run(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const startedMs = Date.now()

  after(async () => {
    await writeInvocationHeartbeat({ pipeline: PIPELINE_NAME, startedAtMs: startedMs })

    let ok = true
    let errMsg: string | null = null
    let complete = true
    let unseriesed = 0
    let notOnChain = 0
    let setsWritten = 0
    let editionsWritten = 0
    let scriptCalls = 0
    let scriptErrors = 0
    let writeErrors = 0
    let strandedWritten: number | null = null
    let strandedError: string | null = null
    let seriesRegistered: number[] | null = null
    let unlabelledSeries: number[] | null = null
    let registerError: string | null = null

    try {
      const read = await readUnseriesedSets()
      complete = read.complete
      unseriesed = read.rows.length
      for (let i = 0; i < read.rows.length; i += SETS_PER_SCRIPT) {
        const chunk = read.rows.slice(i, i + SETS_PER_SCRIPT)
        let series: number[]
        try {
          scriptCalls++
          series = await readSeries(chunk)
        } catch (e) {
          scriptErrors++
          ok = false
          errMsg = errMsg ?? `flow rest: ${e instanceof Error ? e.message : String(e)}`
          continue
        }
        for (let k = 0; k < chunk.length; k++) {
          const s = series[k]
          if (s === NOT_ON_CHAIN) {
            notOnChain++
            continue
          }
          // Fill-only under a concurrent writer; the returned rows are what LANDED.
          const { data, error } = await (supabaseAdmin as any)
            .from("sets")
            .update({ series: s })
            .eq("id", chunk[k].id)
            .is("series", null)
            .select("id")
          if (error) {
            writeErrors++
            ok = false
            errMsg = errMsg ?? `sets write: ${error.message}`
            continue
          }
          const landed = Array.isArray(data) ? data.length : 0
          setsWritten += landed
          if (landed === 0) continue
          const { data: eds, error: edErr } = await (supabaseAdmin as any)
            .from("editions")
            .update({ series: s })
            .eq("collection_id", COLLECTION_ID)
            .eq("set_id_onchain", chunk[k].set_id_onchain)
            .is("series", null)
            .select("id")
          if (edErr) {
            writeErrors++
            ok = false
            errMsg = errMsg ?? `editions write: ${edErr.message}`
            continue
          }
          editionsWritten += Array.isArray(eds) ? eds.length : 0
        }
      }
    } catch (e) {
      ok = false
      errMsg = e instanceof Error ? e.message : String(e)
    }

    // Runs every time, after the main loop, whatever it did.
    try {
      const r = await fillStrandedEditions()
      strandedWritten = r.written
      editionsWritten += r.written
    } catch (e) {
      ok = false
      strandedError = e instanceof Error ? e.message : String(e)
      errMsg = errMsg ?? strandedError
    }

    // Play metadata for editions the Atlas catalog created without it.
    let playMeta: PlayMetaResult | null = null
    let playMetaError: string | null = null
    try {
      playMeta = await fillPlayMetadata()
      editionsWritten += playMeta.editions_dated
      if (playMeta.error) {
        ok = false
        errMsg = errMsg ?? playMeta.error
      }
    } catch (e) {
      ok = false
      playMetaError = e instanceof Error ? e.message : String(e)
      errMsg = errMsg ?? playMetaError
    }

    // A new series becomes visible site-wide only once it has a collection_series row.
    try {
      const r = await registerNewSeries()
      seriesRegistered = r.registered
      unlabelledSeries = r.unlabelled
      if (r.unlabelled.length > 0) {
        ok = false
        errMsg = errMsg ?? `series with no known label: ${r.unlabelled.join(", ")} — add it to SERIES_DISPLAY`
      }
    } catch (e) {
      ok = false
      registerError = e instanceof Error ? e.message : String(e)
      errMsg = errMsg ?? registerError
    }

    await logTerminalRun({
      pipeline: PIPELINE_NAME,
      startedAt: startedMs,
      ok,
      error: errMsg,
      rowsFound: unseriesed,
      rowsWritten: setsWritten + editionsWritten,
      rowsSkipped: notOnChain,
      collectionSlug: "nba-top-shot",
      extra: {
        complete,
        unseriesed,
        sets_written: setsWritten,
        editions_written: editionsWritten,
        not_on_chain: notOnChain,
        script_calls: scriptCalls,
        script_errors: scriptErrors,
        write_errors: writeErrors,
        stranded_editions_filled: strandedWritten,
        stranded_editions_error: strandedError,
        series_registered: seriesRegistered,
        unlabelled_series: unlabelledSeries,
        register_error: registerError,
        play_meta: playMeta,
        play_meta_error: playMetaError,
        duration_ms: Date.now() - startedMs,
      },
    })
  })

  return NextResponse.json({ ok: true, accepted: true, pipeline: PIPELINE_NAME }, { status: 202 })
}

export async function POST(request: NextRequest) {
  return run(request)
}

export async function GET(request: NextRequest) {
  return run(request)
}
