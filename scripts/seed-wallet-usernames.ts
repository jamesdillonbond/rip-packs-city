#!/usr/bin/env node
/**
 * scripts/seed-wallet-usernames.ts
 *
 * Resolves Flow wallet addresses to NBA Top Shot usernames via the public
 * Top Shot GQL `searchUsers` endpoint and upserts them into the
 * wallet_usernames table.
 *
 * Sources its address universe from flowty_funded_loans — the distinct
 * union of lender_addr and borrower_addr across the loan book.
 *
 * Idempotent: re-running just refreshes existing rows (`source = 'topshot'`,
 * updated_at = now()). Addresses with no Top Shot match are skipped.
 *
 * Usage:
 *   npm run seed:usernames
 *   npx tsx scripts/seed-wallet-usernames.ts
 *
 * Env (loaded from .env.local via dotenv):
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import "dotenv/config"
import { createClient } from "@supabase/supabase-js"

const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  process.env.SUPABASE_URL ||
  ""
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ""

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error(
    "[seed-usernames] Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in env"
  )
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const TS_GQL = "https://public-api.nbatopshot.com/graphql"
const GQL_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": "rpc-seed-usernames/1.0",
}

const SEARCH_USERS_QUERY = `
  query SearchUsersByAddress($input: SearchUsersInput!, $paginationInput: BasePaginationV2Input!) {
    searchUsers(input: $input, paginationInput: $paginationInput) {
      searchSummary {
        data {
          ... on Users {
            data {
              ... on User {
                publicInfo {
                  username
                  flowAddress
                }
              }
            }
          }
        }
      }
    }
  }
`.trim()

const BATCH_SIZE = 50
const REQUESTS_PER_SECOND = 5
const REQUEST_INTERVAL_MS = Math.ceil(1000 / REQUESTS_PER_SECOND)
const LOG_EVERY = 100

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function fetchAddressUniverse(): Promise<string[]> {
  // Page through flowty_funded_loans to collect the distinct lender + borrower
  // addresses. We pull both columns in chunks because PostgREST caps at 1000
  // rows per request and the loan book is ~10K rows.
  const out = new Set<string>()
  const PAGE = 1000
  let from = 0
  while (true) {
    const { data, error } = await supabase
      .from("flowty_funded_loans")
      .select("lender_addr, borrower_addr")
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`flowty_funded_loans query failed: ${error.message}`)
    if (!data || data.length === 0) break
    for (const row of data as Array<{ lender_addr: string | null; borrower_addr: string | null }>) {
      if (row.lender_addr) out.add(row.lender_addr.toLowerCase())
      if (row.borrower_addr) out.add(row.borrower_addr.toLowerCase())
    }
    if (data.length < PAGE) break
    from += PAGE
  }
  return Array.from(out)
}

interface ResolvedRow {
  wallet_addr: string
  username: string
}

async function searchUsername(addr: string): Promise<string | null> {
  try {
    const res = await fetch(TS_GQL, {
      method: "POST",
      headers: GQL_HEADERS,
      body: JSON.stringify({
        query: SEARCH_USERS_QUERY,
        variables: {
          input: { searchPhrase: addr },
          paginationInput: { cursor: "", direction: "RIGHT", limit: 5 },
        },
      }),
    })
    if (!res.ok) {
      // 4xx/5xx — log and move on
      console.log(`[seed-usernames] gql ${res.status} for ${addr}`)
      return null
    }
    const body: any = await res.json()
    if (body?.errors?.length) {
      console.log(
        `[seed-usernames] gql errors for ${addr}: ${body.errors[0]?.message ?? "unknown"}`
      )
      return null
    }
    const items: any[] =
      body?.data?.searchUsers?.searchSummary?.data?.data ?? []
    if (!items.length) return null
    // Prefer an exact flowAddress match if present; fall back to first hit.
    const lower = addr.toLowerCase()
    let pick = items.find(
      (u) => (u?.publicInfo?.flowAddress || "").toLowerCase() === lower
    )
    if (!pick) pick = items[0]
    const username: string | undefined = pick?.publicInfo?.username
    if (!username || typeof username !== "string") return null
    return username
  } catch (e: any) {
    console.log(`[seed-usernames] error for ${addr}: ${e?.message || e}`)
    return null
  }
}

async function upsertBatch(rows: ResolvedRow[]): Promise<void> {
  if (rows.length === 0) return
  const payload = rows.map((r) => ({
    wallet_addr: r.wallet_addr,
    username: r.username,
    source: "topshot",
    resolved_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }))
  const { error } = await supabase
    .from("wallet_usernames")
    .upsert(payload, { onConflict: "wallet_addr" })
  if (error) {
    console.log(`[seed-usernames] upsert failed: ${error.message}`)
  }
}

async function main() {
  const t0 = Date.now()
  console.log("[seed-usernames] loading address universe…")
  const addrs = await fetchAddressUniverse()
  console.log(`[seed-usernames] universe size = ${addrs.length}`)

  let processed = 0
  let resolved = 0
  let skipped = 0
  const buffer: ResolvedRow[] = []

  for (let i = 0; i < addrs.length; i++) {
    const addr = addrs[i]
    const start = Date.now()
    const username = await searchUsername(addr)
    if (username) {
      buffer.push({ wallet_addr: addr, username })
      resolved++
    } else {
      skipped++
    }
    processed++

    if (buffer.length >= BATCH_SIZE) {
      await upsertBatch(buffer)
      buffer.length = 0
    }

    if (processed % LOG_EVERY === 0) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
      console.log(
        `[seed-usernames] processed=${processed}/${addrs.length} resolved=${resolved} skipped=${skipped} elapsed=${elapsed}s`
      )
    }

    // Throttle to ~5 RPS.
    const dt = Date.now() - start
    if (dt < REQUEST_INTERVAL_MS) await sleep(REQUEST_INTERVAL_MS - dt)
  }

  if (buffer.length > 0) await upsertBatch(buffer)

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
  console.log(
    `[seed-usernames] DONE processed=${processed} resolved=${resolved} skipped=${skipped} elapsed=${elapsed}s`
  )
}

main().catch((e) => {
  console.error("[seed-usernames] fatal:", e)
  process.exit(1)
})
