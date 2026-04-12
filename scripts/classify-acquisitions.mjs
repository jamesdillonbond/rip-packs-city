#!/usr/bin/env node
/**
 * classify-acquisitions.mjs
 *
 * Classifies how each moment in a wallet was acquired and upserts into moment_acquisitions.
 *
 * Usage:
 *   node scripts/classify-acquisitions.mjs --wallet 0xbd94cade097e50ac
 *   node scripts/classify-acquisitions.mjs --wallet 0xbd94cade097e50ac --dry-run
 */

import { readFileSync } from "fs"
import { resolve } from "path"
import { createClient } from "@supabase/supabase-js"

/* ── env ─────────────────────────────────────────────────────────── */

function loadEnv() {
  try {
    const envPath = resolve(process.cwd(), ".env.local")
    const lines = readFileSync(envPath, "utf-8").split("\n")
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      const eq = trimmed.indexOf("=")
      if (eq === -1) continue
      const key = trimmed.slice(0, eq).trim()
      let val = trimmed.slice(eq + 1).trim()
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
        val = val.slice(1, -1)
      if (!process.env[key]) process.env[key] = val
    }
  } catch {
    console.error("[classify] Could not read .env.local — run from project root")
    process.exit(1)
  }
}
loadEnv()

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("[classify] Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY")
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

// For bulk classification, hit the public API directly to avoid proxy rate limits.
// The proxy is only needed for Vercel runtime (Cloudflare blocks Vercel IPs).
// Local scripts can hit the public API fine.
const TS_GQL = "https://public-api.nbatopshot.com/graphql"
const GQL_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
}

const FLOWTY_HEADERS = {
  "Content-Type": "application/json",
  Origin: "https://www.flowty.io",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
}

const COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"

/* ── CLI args ────────────────────────────────────────────────────── */

function parseArgs() {
  const args = process.argv.slice(2)
  let wallet = "0xbd94cade097e50ac"
  let dryRun = false
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--wallet" && args[i + 1]) wallet = args[i + 1]
    if (args[i] === "--dry-run") dryRun = true
  }
  return { wallet, dryRun }
}

/* ── helpers ─────────────────────────────────────────────────────── */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function fetchJSON(url, opts = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000), ...opts })
  if (!res.ok) throw new Error(`${opts.method || "GET"} ${url} → ${res.status} ${await res.text().catch(() => "")}`)
  return res.json()
}

/* ── Phase 0: Flowty event discovery ─────────────────────────────── */

async function phase0_discovery() {
  console.log("\n[classify] ═══ Phase 0: Flowty Event Discovery ═══")
  const firestoreUrl =
    "https://firestore.googleapis.com/v1/projects/flowty-prod/databases/(default)/documents:runQuery"

  try {
    const body = {
      structuredQuery: {
        from: [{ collectionId: "events" }],
        orderBy: [{ field: { fieldPath: "blockTimestamp" }, direction: "DESCENDING" }],
        limit: 500,
      },
    }

    const results = await fetchJSON(firestoreUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })

    const eventTypes = new Set()
    for (const doc of results) {
      const fields = doc?.document?.fields
      if (!fields) continue
      // Look for event type fields
      for (const key of ["type", "eventType", "event_type", "kind"]) {
        if (fields[key]?.stringValue) eventTypes.add(fields[key].stringValue)
      }
      // Also check nested data
      if (fields.data?.mapValue?.fields) {
        const dataFields = fields.data.mapValue.fields
        for (const key of ["type", "eventType", "event_type", "kind"]) {
          if (dataFields[key]?.stringValue) eventTypes.add(dataFields[key].stringValue)
        }
      }
    }

    if (eventTypes.size > 0) {
      console.log(`[classify] Found ${eventTypes.size} distinct event types:`)
      for (const t of eventTypes) console.log(`  - ${t}`)
    } else {
      console.log("[classify] No event type fields found in Firestore docs. Sample keys:")
      const sampleDoc = results[0]?.document?.fields
      if (sampleDoc) console.log(`  Fields: ${Object.keys(sampleDoc).join(", ")}`)
      else console.log("  (no documents returned — Firestore may restrict unauthenticated queries)")
    }

    return [...eventTypes]
  } catch (err) {
    console.warn(`[classify] Firestore query failed: ${err.message}`)
    console.log("[classify] Continuing without Firestore event discovery")
    return []
  }
}

/* ── Phase 1: GQL lastPurchasePrice classification ───────────────── */

const GET_MINTED_MOMENT = `
query GetMintedMoment($momentId: ID!) {
  getMintedMoment(momentId: $momentId) {
    data {
      id
      flowId
      createdAt
      price
      play { stats { playerName } }
      setPlay { circulationCount }
    }
  }
}`

async function fetchMomentGQL(momentId, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(TS_GQL, {
        method: "POST",
        headers: GQL_HEADERS,
        body: JSON.stringify({
          operationName: "GetMintedMoment",
          query: GET_MINTED_MOMENT,
          variables: { momentId },
        }),
        signal: AbortSignal.timeout(15000),
      })
      if (res.status === 429) {
        const backoff = Math.min(5000 * 2 ** attempt, 60000)
        if (attempt < retries) {
          await sleep(backoff)
          continue
        }
        throw new Error(`429 after ${retries + 1} attempts`)
      }
      if (!res.ok) throw new Error(`GQL ${res.status}`)
      const json = await res.json()
      if (json.errors?.length) throw new Error(json.errors[0]?.message || "GQL error")
      return json.data?.getMintedMoment?.data
    } catch (err) {
      if (attempt < retries && (err.message.includes("429") || err.message.includes("timeout"))) {
        await sleep(5000 * 2 ** attempt)
        continue
      }
      throw err
    }
  }
}

async function phase1_gql(unclassifiedIds) {
  console.log(`\n[classify] ═══ Phase 1: GQL Classification (${unclassifiedIds.length} moments) ═══`)

  const results = new Map() // momentId → { method, price, acquiredDate, flowId }
  const CONCURRENCY = 10
  const BATCH_DELAY = 200
  let processed = 0
  let gqlHits = 0
  let gqlMisses = 0
  let errors = 0

  for (let i = 0; i < unclassifiedIds.length; i += CONCURRENCY) {
    const batch = unclassifiedIds.slice(i, i + CONCURRENCY)
    const promises = batch.map(async (momentId) => {
      try {
        const data = await fetchMomentGQL(momentId)
        if (!data) {
          gqlMisses++
          return
        }
        const price = data.price != null ? parseFloat(data.price) : null
        if (price && price > 0) {
          results.set(momentId, {
            method: "marketplace",
            price,
            acquiredDate: data.createdAt || null,
            flowId: data.flowId || null,
          })
          gqlHits++
        } else {
          // price is null/0 — could be pack pull, gift, etc
          results.set(momentId, {
            method: "unknown",
            price: null,
            acquiredDate: data.createdAt || null,
            flowId: data.flowId || null,
          })
          gqlMisses++
        }
      } catch (err) {
        errors++
        if (errors <= 10) console.warn(`[classify] GQL error for ${momentId}: ${err.message}`)
      }
    })

    await Promise.all(promises)
    processed += batch.length

    if (processed % 500 === 0 || processed === unclassifiedIds.length) {
      console.log(
        `[classify] GQL progress: ${processed}/${unclassifiedIds.length} — marketplace: ${gqlHits}, unknown: ${gqlMisses}, errors: ${errors}`
      )
    }

    if (i + CONCURRENCY < unclassifiedIds.length) await sleep(BATCH_DELAY)
  }

  console.log(`[classify] Phase 1 complete: ${results.size} classified, ${errors} errors`)
  return results
}

/* ── Phase 2: Flowty loan defaults ───────────────────────────────── */

async function phase2_loans(wallet, eventTypes) {
  console.log(`\n[classify] ═══ Phase 2: Flowty Loan Default Detection ═══`)

  const loanDefaults = new Map() // flowId → { loanPrincipal, sourceWallet }
  const walletBare = wallet.replace("0x", "")

  // 2a: Query Flowty Firestore for loan events mentioning this wallet
  const loanEventTypes = eventTypes.filter(
    (t) =>
      t.toLowerCase().includes("loan") ||
      t.toLowerCase().includes("default") ||
      t.toLowerCase().includes("settle") ||
      t.toLowerCase().includes("repay")
  )

  if (loanEventTypes.length > 0) {
    console.log(`[classify] Checking Firestore for loan event types: ${loanEventTypes.join(", ")}`)
    const firestoreUrl =
      "https://firestore.googleapis.com/v1/projects/flowty-prod/databases/(default)/documents:runQuery"

    for (const eventType of loanEventTypes) {
      try {
        const body = {
          structuredQuery: {
            from: [{ collectionId: "events" }],
            where: {
              compositeFilter: {
                op: "AND",
                filters: [
                  { fieldFilter: { field: { fieldPath: "type" }, op: "EQUAL", value: { stringValue: eventType } } },
                ],
              },
            },
            orderBy: [{ field: { fieldPath: "blockTimestamp" }, direction: "DESCENDING" }],
            limit: 200,
          },
        }

        const results = await fetchJSON(firestoreUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })

        for (const doc of results) {
          const raw = JSON.stringify(doc)
          if (raw.includes(wallet) || raw.includes(walletBare)) {
            const fields = doc?.document?.fields
            const nftId = fields?.nftId?.stringValue || fields?.nftID?.stringValue
            const amount =
              fields?.amount?.doubleValue || fields?.amount?.stringValue || fields?.principal?.doubleValue
            if (nftId) {
              loanDefaults.set(nftId, {
                loanPrincipal: amount ? parseFloat(amount) : null,
                sourceWallet: null,
              })
            }
          }
        }
      } catch (err) {
        console.warn(`[classify] Firestore loan query failed for ${eventType}: ${err.message}`)
      }
    }
  } else {
    console.log("[classify] No loan-related event types discovered in Phase 0")
  }

  // 2b: Query Flowty API for loan history on this wallet
  try {
    console.log("[classify] Checking Flowty API for loan order history...")
    const body = {
      filters: { orderFilters: { kind: "loan" } },
      sort: { field: "blockTimestamp", direction: "desc" },
      searchQuery: "",
      limit: 24,
      cursor: "",
      address: wallet,
    }

    const res = await fetchJSON("https://api2.flowty.io/collection/0x0b2a3299cc857e29/TopShot", {
      method: "POST",
      headers: FLOWTY_HEADERS,
      body: JSON.stringify(body),
    })

    const items = res?.items ?? res?.data ?? []
    console.log(`[classify] Flowty loan API returned ${items.length} items`)

    for (const item of items) {
      const nftId = item.nftId || item.nftID || item.flowId
      const principal = item.amount || item.principal || item.valuations?.blended?.usdValue
      if (nftId) {
        loanDefaults.set(String(nftId), {
          loanPrincipal: principal ? parseFloat(principal) : null,
          sourceWallet: item.borrower || item.lender || null,
        })
      }
    }
  } catch (err) {
    console.warn(`[classify] Flowty loan API query failed: ${err.message}`)
  }

  console.log(`[classify] Phase 2 complete: ${loanDefaults.size} potential loan defaults found`)
  return loanDefaults
}

/* ── Phase 3: Upsert results ─────────────────────────────────────── */

async function phase3_insert(wallet, classifications, loanDefaults, dryRun) {
  console.log(`\n[classify] ═══ Phase 3: ${dryRun ? "DRY RUN — " : ""}Insert Results ═══`)

  // Merge loan defaults into classifications
  // We need a flowId → momentId mapping; for now loan defaults keyed by flowId
  // won't directly match since classifications are keyed by momentId.
  // The flowId from GQL can bridge them.
  const flowIdToMomentId = new Map()
  for (const [momentId, info] of classifications) {
    if (info.flowId) flowIdToMomentId.set(String(info.flowId), momentId)
  }

  for (const [flowId, loanInfo] of loanDefaults) {
    const momentId = flowIdToMomentId.get(flowId) || flowId
    if (classifications.has(momentId)) {
      const existing = classifications.get(momentId)
      // Only override if currently unknown
      if (existing.method === "unknown") {
        existing.method = "loan_default"
        existing.loanPrincipal = loanInfo.loanPrincipal
        existing.sourceWallet = loanInfo.sourceWallet
      }
    }
  }

  // Build rows
  const rows = []
  for (const [momentId, info] of classifications) {
    rows.push({
      nft_id: momentId,
      wallet,
      acquisition_method: info.method,
      buy_price: info.method === "marketplace" ? info.price : null,
      acquired_date: info.acquiredDate || null,
      source: "classifier_v1",
      collection_id: COLLECTION_ID,
      transaction_hash: `classifier_${momentId}`,
      source_wallet: info.sourceWallet || null,
      loan_principal: info.loanPrincipal || null,
    })
  }

  // Summary
  const summary = {}
  for (const row of rows) {
    summary[row.acquisition_method] = (summary[row.acquisition_method] || 0) + 1
  }

  console.log("\n[classify] ─── Classification Summary ───────────────────────")
  for (const [method, count] of Object.entries(summary).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${method.padEnd(20)} ${count}`)
  }
  console.log(`  ${"TOTAL".padEnd(20)} ${rows.length}`)

  if (dryRun) {
    console.log("\n[classify] DRY RUN — no rows inserted")
    return
  }

  // Batched upserts
  const BATCH_SIZE = 100
  let inserted = 0
  let upsertErrors = 0

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE)
    const { error } = await supabase.from("moment_acquisitions").upsert(batch, {
      onConflict: "nft_id,wallet,transaction_hash",
      ignoreDuplicates: false,
    })

    if (error) {
      upsertErrors++
      if (upsertErrors <= 5)
        console.error(`[classify] Upsert error batch ${Math.floor(i / BATCH_SIZE)}: ${error.message}`)
    } else {
      inserted += batch.length
    }

    if ((i / BATCH_SIZE) % 20 === 0 && i > 0) {
      console.log(`[classify] Upserted ${inserted}/${rows.length}...`)
    }
  }

  console.log(`[classify] Inserted ${inserted} rows (${upsertErrors} batch errors)`)
}

/* ── main ────────────────────────────────────────────────────────── */

async function main() {
  const { wallet, dryRun } = parseArgs()
  console.log(`[classify] Wallet: ${wallet}`)
  console.log(`[classify] Dry run: ${dryRun}`)
  console.log(`[classify] GQL endpoint: ${TS_GQL}`)

  // Get all moment IDs in wallet (paginated — Supabase default limit is 1000)
  let allMomentIds = []
  const PAGE_SIZE = 1000
  let offset = 0
  while (true) {
    const { data: page, error: wmErr } = await supabase
      .from("wallet_moments_cache")
      .select("moment_id")
      .eq("wallet_address", wallet)
      .range(offset, offset + PAGE_SIZE - 1)

    if (wmErr) {
      console.error(`[classify] Failed to fetch wallet_moments_cache: ${wmErr.message}`)
      process.exit(1)
    }
    allMomentIds.push(...page.map((r) => r.moment_id))
    if (page.length < PAGE_SIZE) break
    offset += PAGE_SIZE
  }
  console.log(`[classify] Total moments in wallet: ${allMomentIds.length}`)

  // Get already-classified moment IDs (paginated)
  const classifiedSet = new Set()
  offset = 0
  while (true) {
    const { data: page, error: aqErr } = await supabase
      .from("moment_acquisitions")
      .select("nft_id")
      .eq("wallet", wallet)
      .range(offset, offset + PAGE_SIZE - 1)

    if (aqErr) {
      console.error(`[classify] Failed to fetch moment_acquisitions: ${aqErr.message}`)
      process.exit(1)
    }
    for (const r of page) classifiedSet.add(r.nft_id)
    if (page.length < PAGE_SIZE) break
    offset += PAGE_SIZE
  }
  const unclassifiedIds = allMomentIds.filter((id) => !classifiedSet.has(id))
  console.log(`[classify] Already classified: ${classifiedSet.size}`)
  console.log(`[classify] Unclassified: ${unclassifiedIds.length}`)

  if (unclassifiedIds.length === 0) {
    console.log("[classify] Nothing to classify — all moments already have acquisitions")
    return
  }

  // Phase 0: Discover Flowty event types
  const eventTypes = await phase0_discovery()

  // Phase 1: GQL classification
  const classifications = await phase1_gql(unclassifiedIds)

  // Phase 2: Loan default detection
  const loanDefaults = await phase2_loans(wallet, eventTypes)

  // Phase 3: Insert
  await phase3_insert(wallet, classifications, loanDefaults, dryRun)

  console.log("\n[classify] Done ✓")
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[classify] FATAL:", err)
    process.exit(1)
  })
