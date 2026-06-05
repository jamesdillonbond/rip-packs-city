import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

// Pinnacle metadata + catalog backfill via on-chain Cadence reads.
//
// Background: the Pinnacle public GQL endpoint (public-api.disneypinnacle.com)
// returns 404 from every IP we control — re-verified 2026-05-16 against
// pinnacle-proxy.tdillonbond.workers.dev. The existing
// scripts/fetch-missing-pinnacle-editions.ts left mint_count permanently NULL
// because it only had Flowty's per-NFT REST surface (which doesn't expose
// numberMinted) and the dead GQL path.
//
// This route routes around the dead GQL by reading the exact same data
// straight off Flow mainnet via Cadence:
//   - Pinnacle.NFT.editionID  → on-chain edition resource id
//   - Pinnacle.getEdition(id).numberMinted / maxMintSize / variant / printing / isChaser
//   - Pinnacle.getShape(edition.shapeID).getMetadata()["RoyaltyCodes" | "Characters" | "Franchises"]
//   - Pinnacle.getSet(edition.setID).name           (set_name)
//   - Pinnacle.getEditionType(edition.editionTypeID).name  (edition_type)
//
// edition_key is reconstructed as `${RoyaltyCodes[0]}:${variant}:${printing}`
// matching the existing convention used by buildEditionKey() and
// fetch-missing-pinnacle-editions.ts.
//
// ── IMAGES ARE A DOCUMENTED DEAD-END (verified on-chain 2026-06-05) ──────────
// This route does NOT and CANNOT fill thumbnail_url. The Pinnacle contract
// (0xedf9df96c92f4595) carries NO per-edition image on-chain: both
// NFT.resolveDisplayView().thumbnail and resolveMediasView() return the single
// hardcoded generic placeholder "https://assets.disneypinnacle.com/on-chain/pinnacle.jpg"
// for every NFT (contract source lines ~1604/1665/1765). The only per-edition
// image identifier is `renderID` (e.g. "OEV1-SWHM-BOUS-S2"/"OEV2-FROZ-ANNA-S3"),
// an opaque slug whose uniqueness the contract explicitly does NOT guarantee and
// for which no URL template is exposed — so it cannot deterministically build a
// real per-edition image URL without fabricating a CDN path (forbidden).
// The ~82 catalog rows that DO have a real http thumbnail are legacy artifacts
// from when the Pinnacle GQL / Flowty per-NFT REST were alive (both dead now:
// GQL 404 since 2026-05-16, Flowty marketplace shut 2026-05-13). With all three
// image sources dead, the ~396 NULL thumbnails will NOT grow from any source we
// control. Per the handoff: report the dead-end, never fabricate. Do not
// re-litigate a "GQL re-fetch" or "renderID → URL" approach — both verified dead.
//
// Four queues, sequential:
//   Q1: pinnacle_editions where mint_count IS NULL  (cap 100)
//   Q2: wallet_moments_cache (Pinnacle collection) where edition_key IS NULL  (cap 50)
//   Q3: composite edition_key disagreements between wmc and pinnacle_nft_map  (cap 25)
//   Q4: catalog create/repair — held wmc composite edition_keys with NO complete
//       pinnacle_editions row (missing entirely, OR a fetch-missing stub with
//       character_name='Unknown' / edition_key NULL). Upserts the row from
//       on-chain text (character/franchise/set/variant/edition_type/printing/
//       mint_count/is_serialized/is_chaser). thumbnail_url is NEVER written —
//       new rows keep the NULL default, existing rows keep their value.  (cap 60)
//
// All four queues share one Cadence script and dispatch per-wallet so a
// single Flow REST call covers up to PER_CADENCE_CHUNK moments for a wallet.
//
// Bearer auth on INGEST_SECRET_TOKEN. Trevor schedules at cron-job.org hourly
// at :22 (offset from populate-pinnacle-wmc-fmv and listing-alert).

export const maxDuration = 30
export const dynamic = "force-dynamic"

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
) as any

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""
const PIPELINE_NAME = "pinnacle-metadata-backfill"
const PINNACLE_COLLECTION_ID = "7dd9dd11-e8b6-45c4-ac99-71331f959714"
const FLOW_REST = "https://rest-mainnet.onflow.org/v1/scripts?block_height=sealed"

const Q1_CAP = 100
const Q2_CAP = 50
const Q3_CAP = 25
const Q4_CAP = 60
const PER_CADENCE_CHUNK = 50
const PER_CALL_TIMEOUT_MS = 15_000
const SOFT_DEADLINE_MS = 25_000

const PINNACLE_METADATA_SCRIPT = `
import NonFungibleToken from 0x1d7e57aa55817448
import Pinnacle from 0xedf9df96c92f4595

access(all) struct PinInfo {
    access(all) let editionId: Int
    access(all) let royaltyCode: String
    access(all) let variant: String
    access(all) let printing: UInt64
    access(all) let numberMinted: UInt64
    access(all) let maxMintSize: UInt64
    access(all) let isLimited: Bool
    access(all) let isChaser: Bool
    access(all) let characterName: String
    access(all) let franchise: String
    access(all) let setName: String
    access(all) let editionType: String

    init(editionId: Int, royaltyCode: String, variant: String, printing: UInt64, numberMinted: UInt64, maxMintSize: UInt64, isLimited: Bool, isChaser: Bool, characterName: String, franchise: String, setName: String, editionType: String) {
        self.editionId = editionId
        self.royaltyCode = royaltyCode
        self.variant = variant
        self.printing = printing
        self.numberMinted = numberMinted
        self.maxMintSize = maxMintSize
        self.isLimited = isLimited
        self.isChaser = isChaser
        self.characterName = characterName
        self.franchise = franchise
        self.setName = setName
        self.editionType = editionType
    }
}

// Pull the first element of a string-array metadata value (Characters/Franchises),
// tolerating a bare String or a missing key.
access(all) fun firstStr(_ v: AnyStruct?): String {
    if v == nil { return "" }
    if let a = v! as? [String] { return a.length > 0 ? a[0] : "" }
    if let s = v! as? String { return s }
    return ""
}

access(all) fun main(addr: Address, ids: [UInt64]): {UInt64: PinInfo} {
    let acct = getAccount(addr)
    let capRef = acct.capabilities
        .borrow<&{NonFungibleToken.CollectionPublic}>(/public/PinnacleCollection)
    if capRef == nil { return {} }
    let cap = capRef!
    let out: {UInt64: PinInfo} = {}
    for id in ids {
        let nftRef = cap.borrowNFT(id)
        if nftRef == nil { continue }
        let pinRef = nftRef! as! &Pinnacle.NFT
        let edition = Pinnacle.getEdition(id: pinRef.editionID)
        if edition == nil { continue }
        let shape = Pinnacle.getShape(id: edition!.shapeID)
        if shape == nil { continue }
        let meta = shape!.getMetadata()
        let royaltyArr = meta["RoyaltyCodes"]! as! [String]
        let royaltyCode = royaltyArr.length > 0 ? royaltyArr[0] : ""
        let set = Pinnacle.getSet(id: edition!.setID)
        let et = Pinnacle.getEditionType(id: edition!.editionTypeID)
        out[id] = PinInfo(
            editionId: pinRef.editionID,
            royaltyCode: royaltyCode,
            variant: edition!.variant ?? "",
            printing: edition!.printing,
            numberMinted: edition!.numberMinted,
            maxMintSize: edition!.maxMintSize ?? 0,
            isLimited: edition!.maxMintSize != nil,
            isChaser: edition!.isChaser,
            characterName: firstStr(meta["Characters"]),
            franchise: firstStr(meta["Franchises"]),
            setName: set == nil ? "" : set!.name,
            editionType: et == nil ? "" : et!.name
        )
    }
    return out
}
`.trim()

interface PinInfo {
  editionId: number
  royaltyCode: string
  variant: string
  printing: number
  numberMinted: number
  maxMintSize: number
  isLimited: boolean
  isChaser: boolean
  characterName: string
  franchise: string
  setName: string
  editionType: string
}

// Flow JSON-CDC unwrapper. The shape we expect is:
//   { type: "Dictionary", value: [{ key, value }, ...] }
// where each inner value is { type: "Struct", value: { id, fields: [...] } }
// Returns plain JS objects.
function decodeJsonCdc(raw: any): any {
  if (raw == null) return null
  if (typeof raw !== "object") return raw
  switch (raw.type) {
    case "Dictionary": {
      const out: Record<string, any> = {}
      for (const entry of raw.value ?? []) {
        out[String(decodeJsonCdc(entry.key))] = decodeJsonCdc(entry.value)
      }
      return out
    }
    case "Struct":
    case "Resource":
    case "Event": {
      const out: Record<string, any> = {}
      for (const field of raw.value?.fields ?? []) {
        out[field.name] = decodeJsonCdc(field.value)
      }
      return out
    }
    case "Optional":
      return raw.value == null ? null : decodeJsonCdc(raw.value)
    case "Array":
      return (raw.value ?? []).map(decodeJsonCdc)
    case "Bool":
      return Boolean(raw.value)
    case "Int":
    case "UInt":
    case "UInt8":
    case "UInt16":
    case "UInt32":
    case "UInt64":
    case "Int8":
    case "Int16":
    case "Int32":
    case "Int64":
      // Numeric Cadence types serialize their value as a decimal string.
      return Number(raw.value)
    default:
      return raw.value
  }
}

async function runCadenceFetch(wallet: string, ids: string[]): Promise<Record<string, PinInfo>> {
  const out: Record<string, PinInfo> = {}
  for (let i = 0; i < ids.length; i += PER_CADENCE_CHUNK) {
    const chunk = ids.slice(i, i + PER_CADENCE_CHUNK)
    const body = {
      script: btoa(PINNACLE_METADATA_SCRIPT),
      arguments: [
        btoa(JSON.stringify({ type: "Address", value: wallet })),
        btoa(JSON.stringify({
          type: "Array",
          value: chunk.map((id) => ({ type: "UInt64", value: String(id) })),
        })),
      ],
    }
    const res = await fetch(FLOW_REST, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PER_CALL_TIMEOUT_MS),
    })
    if (!res.ok) {
      throw new Error(`Flow ${res.status}: ${(await res.text()).slice(0, 200)}`)
    }
    const raw = await res.text()
    const decoded = JSON.parse(atob(raw.trim().replace(/^"|"$/g, "")))
    const dict = decodeJsonCdc(decoded) as Record<string, PinInfo>
    for (const [k, v] of Object.entries(dict)) {
      out[k] = v
    }
  }
  return out
}

function buildEditionKey(p: PinInfo): string {
  return `${p.royaltyCode}:${p.variant}:${p.printing}`
}

interface WorkItem {
  wallet: string
  momentId: string
  // What this lookup is for. A single moment_id can serve multiple queues if
  // it happens to hit; we tag here for the apply phase.
  jobs: Array<
    | { kind: "mint_count"; edition_pk: string; edition_key: string }
    | { kind: "edition_key_resolve"; wmc_id: string }
    | { kind: "disagreement"; wmc_id: string; wmc_edition_key: string; map_edition_key: string }
    | { kind: "catalog_upsert"; wmc_edition_key: string }
  >
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? ""
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : ""
  const tokenQuery = req.nextUrl.searchParams.get("token") ?? ""
  if (!TOKEN || (bearer !== TOKEN && tokenQuery !== TOKEN)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const started = Date.now()
  const startedAtIso = new Date(started).toISOString()

  // ── Build work list ────────────────────────────────────────────────────
  const workByWallet = new Map<string, Map<string, WorkItem>>()
  const tagJob = (wallet: string, momentId: string, job: WorkItem["jobs"][number]) => {
    const wmap = workByWallet.get(wallet) ?? new Map<string, WorkItem>()
    const existing = wmap.get(momentId)
    if (existing) {
      existing.jobs.push(job)
    } else {
      wmap.set(momentId, { wallet, momentId, jobs: [job] })
    }
    workByWallet.set(wallet, wmap)
  }

  // Q1: pinnacle_editions where mint_count IS NULL. We need a sample wmc row
  // per edition_key so we can borrow the NFT on-chain.
  const q1: Array<{ id: string; edition_key: string }> = []
  const q1Skipped: Array<{ edition_pk: string; reason: string }> = []
  {
    const { data: peRows, error } = await supabaseAdmin
      .from("pinnacle_editions")
      .select("id, edition_key")
      .is("mint_count", null)
      .not("edition_key", "is", null)
      .order("created_at", { ascending: true })
      .limit(Q1_CAP)
    if (error) {
      return NextResponse.json({ ok: false, error: `q1 load: ${error.message}` }, { status: 500 })
    }
    const candidates = (peRows ?? []) as Array<{ id: string; edition_key: string }>
    if (candidates.length > 0) {
      const keys = candidates.map((r) => r.edition_key)
      const { data: wmcRows, error: wmcErr } = await supabaseAdmin
        .from("wallet_moments_cache")
        .select("wallet_address, moment_id, edition_key")
        .eq("collection_id", PINNACLE_COLLECTION_ID)
        .in("edition_key", keys)
        .limit(keys.length * 5)
      if (wmcErr) {
        return NextResponse.json({ ok: false, error: `q1 wmc lookup: ${wmcErr.message}` }, { status: 500 })
      }
      const sampleByKey = new Map<string, { wallet: string; momentId: string }>()
      for (const row of (wmcRows ?? []) as Array<{ wallet_address: string; moment_id: string; edition_key: string }>) {
        if (!sampleByKey.has(row.edition_key)) {
          sampleByKey.set(row.edition_key, { wallet: row.wallet_address, momentId: row.moment_id })
        }
      }
      for (const pe of candidates) {
        const sample = sampleByKey.get(pe.edition_key)
        if (!sample) {
          q1Skipped.push({ edition_pk: pe.id, reason: "no_sample_wmc_row" })
          continue
        }
        q1.push({ id: pe.id, edition_key: pe.edition_key })
        tagJob(sample.wallet, sample.momentId, {
          kind: "mint_count",
          edition_pk: pe.id,
          edition_key: pe.edition_key,
        })
      }
    }
  }

  // Q2: wmc where edition_key IS NULL on the Pinnacle collection.
  const q2: Array<{ wmc_id: string; wallet: string; momentId: string }> = []
  {
    const { data, error } = await supabaseAdmin
      .from("wallet_moments_cache")
      .select("id, wallet_address, moment_id")
      .eq("collection_id", PINNACLE_COLLECTION_ID)
      .is("edition_key", null)
      .order("last_seen_at", { ascending: false })
      .limit(Q2_CAP)
    if (error) {
      return NextResponse.json({ ok: false, error: `q2 load: ${error.message}` }, { status: 500 })
    }
    for (const row of (data ?? []) as Array<{ id: string; wallet_address: string; moment_id: string }>) {
      q2.push({ wmc_id: row.id, wallet: row.wallet_address, momentId: row.moment_id })
      tagJob(row.wallet_address, row.moment_id, { kind: "edition_key_resolve", wmc_id: row.id })
    }
  }

  // Q3: disagreements — composite keys on both sides that don't match. Use an
  // RPC-free approach: pull a small page of wmc + map joined in app code.
  // First pull candidate wmc rows, then look up corresponding map rows.
  const q3: Array<{ wmc_id: string; wallet: string; momentId: string; wmcKey: string; mapKey: string }> = []
  {
    // Pull a wider pool of wmc rows with composite keys to give the JS-side
    // join a fair shot at finding disagreements (the disagreement rate is
    // small, ~39 across the whole collection per CLAUDE.md).
    const { data: wmcPool, error: wmcErr } = await supabaseAdmin
      .from("wallet_moments_cache")
      .select("id, wallet_address, moment_id, edition_key")
      .eq("collection_id", PINNACLE_COLLECTION_ID)
      .not("edition_key", "is", null)
      .ilike("edition_key", "%:%") // composite keys contain colons; cheap pre-filter to skip integer-only keys
      .limit(5000)
    if (wmcErr) {
      return NextResponse.json({ ok: false, error: `q3 wmc pool: ${wmcErr.message}` }, { status: 500 })
    }
    const wmcRows = (wmcPool ?? []) as Array<{ id: string; wallet_address: string; moment_id: string; edition_key: string }>
    const composite = wmcRows.filter((r) => !/^\d+$/.test(r.edition_key))
    const idsToCheck = composite.map((r) => r.moment_id)
    if (idsToCheck.length > 0) {
      const { data: mapRows, error: mapErr } = await supabaseAdmin
        .from("pinnacle_nft_map")
        .select("nft_id, edition_key")
        .in("nft_id", idsToCheck)
      if (mapErr) {
        return NextResponse.json({ ok: false, error: `q3 map lookup: ${mapErr.message}` }, { status: 500 })
      }
      const mapByNft = new Map<string, string>()
      for (const m of (mapRows ?? []) as Array<{ nft_id: string; edition_key: string }>) {
        mapByNft.set(m.nft_id, m.edition_key)
      }
      for (const r of composite) {
        if (q3.length >= Q3_CAP) break
        const mapKey = mapByNft.get(r.moment_id)
        if (!mapKey) continue
        if (mapKey === r.edition_key) continue
        if (/^\d+$/.test(mapKey)) continue // only composite-vs-composite per spec
        q3.push({ wmc_id: r.id, wallet: r.wallet_address, momentId: r.moment_id, wmcKey: r.edition_key, mapKey })
        tagJob(r.wallet_address, r.moment_id, {
          kind: "disagreement",
          wmc_id: r.id,
          wmc_edition_key: r.edition_key,
          map_edition_key: mapKey,
        })
      }
    }
  }

  // Q4: catalog create/repair. Held wmc composite edition_keys (Pinnacle) that
  // have NO complete pinnacle_editions row — either missing entirely, or a
  // fetch-missing stub (character_name='Unknown' / edition_key NULL). We read the
  // authoritative fields straight off chain and upsert (onConflict id). This is
  // the on-chain replacement for the dead GQL catalog fetch. thumbnail_url is
  // never written here (see the dead-end note in the header).
  const q4: Array<{ wmc_edition_key: string; wallet: string; momentId: string }> = []
  {
    // The set of pinnacle_editions ids that are already COMPLETE (real name +
    // edition_key present). Anything not in this set is a create-or-repair target.
    // pinnacle_editions is ~hundreds of rows, comfortably under the 1000 cap.
    const { data: peRows, error: peErr } = await supabaseAdmin
      .from("pinnacle_editions")
      .select("id, character_name, edition_key")
      .limit(10000)
    if (peErr) {
      return NextResponse.json({ ok: false, error: `q4 pe load: ${peErr.message}` }, { status: 500 })
    }
    const completeIds = new Set<string>()
    for (const r of (peRows ?? []) as Array<{ id: string; character_name: string | null; edition_key: string | null }>) {
      if (r.character_name && r.character_name !== "Unknown" && r.edition_key) {
        completeIds.add(r.id)
      }
    }

    // Pull a pool of Pinnacle wmc rows with composite (royaltyCode:variant:printing)
    // edition_keys; pick the first unseen sample per key that lacks a complete row.
    const { data: wmcPool, error: wmcErr } = await supabaseAdmin
      .from("wallet_moments_cache")
      .select("wallet_address, moment_id, edition_key")
      .eq("collection_id", PINNACLE_COLLECTION_ID)
      .not("edition_key", "is", null)
      .ilike("edition_key", "%:%:%") // composite keys have two colons; skips integer-only keys
      .limit(8000)
    if (wmcErr) {
      return NextResponse.json({ ok: false, error: `q4 wmc pool: ${wmcErr.message}` }, { status: 500 })
    }
    const seenKeys = new Set<string>()
    for (const row of (wmcPool ?? []) as Array<{ wallet_address: string; moment_id: string; edition_key: string }>) {
      if (q4.length >= Q4_CAP) break
      const key = row.edition_key
      if (seenKeys.has(key)) continue
      if (completeIds.has(key)) continue // already fully catalogued
      seenKeys.add(key)
      q4.push({ wmc_edition_key: key, wallet: row.wallet_address, momentId: row.moment_id })
      tagJob(row.wallet_address, row.moment_id, { kind: "catalog_upsert", wmc_edition_key: key })
    }
  }

  // ── Fan out Cadence reads, then apply per-queue updates ───────────────
  const corrections: {
    mint_count_filled: Array<{ edition_pk: string; mint_count: number; is_serialized: boolean }>
    edition_keys_resolved: Array<{ wmc_id: string; moment_id: string; edition_key: string }>
    disagreements_corrected: Array<{ wmc_id: string; moment_id: string; from: string; to: string; corrected_side: "wmc" | "map" }>
    catalog_upserted: Array<{ edition_key: string; character_name: string; mint_count: number; created_or_repaired: string }>
  } = { mint_count_filled: [], edition_keys_resolved: [], disagreements_corrected: [], catalog_upserted: [] }
  let gqlErrors = 0
  const errorSamples: Array<{ wallet: string; error: string }> = []

  for (const [wallet, wmap] of workByWallet.entries()) {
    if (Date.now() - started > SOFT_DEADLINE_MS) break
    const ids = Array.from(wmap.keys())
    let result: Record<string, PinInfo> = {}
    try {
      result = await runCadenceFetch(wallet, ids)
    } catch (e) {
      gqlErrors++
      if (errorSamples.length < 3) {
        errorSamples.push({ wallet, error: e instanceof Error ? e.message : String(e) })
      }
      continue
    }

    for (const [momentId, item] of wmap.entries()) {
      const info = result[momentId]
      if (!info) continue
      const authoritativeKey = buildEditionKey(info)

      for (const job of item.jobs) {
        if (job.kind === "mint_count") {
          if (info.numberMinted == null) continue
          const { error } = await supabaseAdmin
            .from("pinnacle_editions")
            .update({
              mint_count: info.numberMinted,
              is_serialized: info.isLimited,
              updated_at: new Date().toISOString(),
            })
            .eq("id", job.edition_pk)
          if (!error) {
            corrections.mint_count_filled.push({
              edition_pk: job.edition_pk,
              mint_count: info.numberMinted,
              is_serialized: info.isLimited,
            })
          }
        } else if (job.kind === "edition_key_resolve") {
          if (!info.royaltyCode || !info.variant) continue
          const { error: wmcUpErr } = await supabaseAdmin
            .from("wallet_moments_cache")
            .update({ edition_key: authoritativeKey })
            .eq("id", job.wmc_id)
          if (wmcUpErr) continue
          await supabaseAdmin
            .from("pinnacle_nft_map")
            .upsert({ nft_id: momentId, edition_key: authoritativeKey }, { onConflict: "nft_id" })
          corrections.edition_keys_resolved.push({
            wmc_id: job.wmc_id,
            moment_id: momentId,
            edition_key: authoritativeKey,
          })
        } else if (job.kind === "disagreement") {
          if (!info.royaltyCode || !info.variant) continue
          if (authoritativeKey === job.wmc_edition_key && authoritativeKey === job.map_edition_key) continue
          if (authoritativeKey === job.wmc_edition_key) {
            // wmc is right, map is wrong
            const { error } = await supabaseAdmin
              .from("pinnacle_nft_map")
              .update({ edition_key: authoritativeKey })
              .eq("nft_id", momentId)
            if (!error) {
              corrections.disagreements_corrected.push({
                wmc_id: job.wmc_id,
                moment_id: momentId,
                from: job.map_edition_key,
                to: authoritativeKey,
                corrected_side: "map",
              })
            }
          } else {
            // map is right OR both wrong — overwrite wmc with authoritative
            const { error } = await supabaseAdmin
              .from("wallet_moments_cache")
              .update({ edition_key: authoritativeKey })
              .eq("id", job.wmc_id)
            if (!error) {
              corrections.disagreements_corrected.push({
                wmc_id: job.wmc_id,
                moment_id: momentId,
                from: job.wmc_edition_key,
                to: authoritativeKey,
                corrected_side: "wmc",
              })
            }
          }
        } else if (job.kind === "catalog_upsert") {
          // Need the core key components to form a valid composite row.
          if (!info.royaltyCode || !info.variant) continue
          // NOTE: thumbnail_url is intentionally omitted — never written here.
          // On INSERT it keeps the NULL default; on UPDATE (stub repair) the
          // existing value is preserved (supabase-js upsert only sets supplied
          // columns). Images are a documented dead-end (see header).
          const { error } = await supabaseAdmin
            .from("pinnacle_editions")
            .upsert(
              {
                id: authoritativeKey,
                edition_key: authoritativeKey,
                character_name: info.characterName || "Unknown",
                franchise: info.franchise || "Unknown",
                set_name: (info.setName || "Unknown").trim(),
                royalty_code: info.royaltyCode,
                variant_type: info.variant,
                edition_type: info.editionType || "Unknown",
                printing: info.printing,
                mint_count: info.numberMinted,
                is_serialized: info.isLimited,
                is_chaser: info.isChaser,
                updated_at: new Date().toISOString(),
              },
              { onConflict: "id" },
            )
          if (!error) {
            corrections.catalog_upserted.push({
              edition_key: authoritativeKey,
              character_name: info.characterName || "Unknown",
              mint_count: info.numberMinted,
              created_or_repaired: authoritativeKey === job.wmc_edition_key ? "match" : "remapped",
            })
          }
        }
      }
    }
  }

  // ── Log pipeline run ───────────────────────────────────────────────────
  const durationMs = Date.now() - started
  await supabaseAdmin.rpc("log_pipeline_run", {
    p_pipeline: PIPELINE_NAME,
    p_started_at: startedAtIso,
    p_rows_found: q1.length + q2.length + q3.length + q4.length,
    p_rows_written:
      corrections.mint_count_filled.length +
      corrections.edition_keys_resolved.length +
      corrections.disagreements_corrected.length +
      corrections.catalog_upserted.length,
    p_rows_skipped: q1Skipped.length,
    p_ok: gqlErrors === 0,
    p_error: errorSamples[0] ? `cadence: ${errorSamples[0].error}` : null,
    p_collection_slug: "disney_pinnacle",
    p_cursor_before: null,
    p_cursor_after: null,
    p_extra: {
      duration_ms: durationMs,
      wallets_touched: workByWallet.size,
      q1_eligible: q1.length,
      q2_eligible: q2.length,
      q3_eligible: q3.length,
      q4_eligible: q4.length,
      catalog_upserted: corrections.catalog_upserted.length,
      q1_skipped_no_sample: q1Skipped.length,
      // thumbnail_url is never filled — Pinnacle images are a documented
      // dead-end (no per-edition image on-chain; GQL 404; Flowty dead).
      images_filled: 0,
      gql_errors: gqlErrors,
      error_samples: errorSamples,
    },
  })

  return NextResponse.json({
    ok: gqlErrors === 0,
    mint_count_filled: corrections.mint_count_filled.length,
    edition_keys_resolved: corrections.edition_keys_resolved.length,
    disagreements_corrected: corrections.disagreements_corrected.length,
    catalog_upserted: corrections.catalog_upserted.length,
    images_filled: 0, // dead-end: no per-edition Pinnacle image exists on-chain
    gql_errors: gqlErrors,
    samples: {
      mint_count: corrections.mint_count_filled.slice(0, 3),
      edition_key: corrections.edition_keys_resolved.slice(0, 3),
      disagreement: corrections.disagreements_corrected.slice(0, 3),
      catalog: corrections.catalog_upserted.slice(0, 5),
    },
    duration_ms: durationMs,
  })
}
