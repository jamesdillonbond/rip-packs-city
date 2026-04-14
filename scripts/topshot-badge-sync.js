/**
 * RPC Badge Sync Script
 * 
 * HOW TO USE:
 * 1. Go to https://nbatopshot.com/marketplace in your browser (logged in)
 * 2. Open DevTools (F12) → Console tab
 * 3. Paste this entire script and press Enter once
 * 4. Wait for "SYNC COMPLETE" message (~60 seconds)
 * 
 * Run weekly or after new set drops to keep Supabase data fresh.
 */

// Badge tag IDs confirmed from live API intercept. Run from nbatopshot.com DevTools console while logged in.
(async () => {
  const SUPABASE_URL = "https://bxcqstmqfzmuolpuynti.supabase.co"
  const COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
  const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ4Y3FzdG1xZnptdW9scHV5bnRpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQyMDg1MTUsImV4cCI6MjA4OTc4NDUxNX0.emIPddCyJ5KGG1CxjXx-BJEySV-TMDAnKGYGorV_RdM"
  const BATCH_SIZE = 50
  const PAGE_LIMIT = 100
  const MAX_PAGES = 20

  const BADGE = {
    ROOKIE_YEAR:        "2dbd4eef-4417-451b-b645-90f02574a401",
    ROOKIE_PREMIERE:    "0ddb2c58-4385-443b-9c70-239b32cddbd4",
    TOP_SHOT_DEBUT:     "a75e247a-ecbf-45a6-b1be-58bb07a1b651",
    ROOKIE_OF_THE_YEAR: "34fe8d3f-681a-42df-856a-e98624f95b11",
    ROOKIE_MINT:        "24d515af-e967-45f5-a30e-11fc96dc2b62",
    INTERACTIVE:        "9bbb6f91-d09a-4d07-ab3d-8402a9c10cf1",
    CHAMPIONSHIP_YEAR:  "f197f60a-b502-4386-b0c0-7f4cde8164ff",
  }

  const QUERY = `
    query SearchMarketplaceEditions(
      $byPlayTagIDs: [ID] = []
      $bySetPlayTagIDs: [ID] = []
      $searchInput: BaseSearchInput = {pagination: {direction: RIGHT, limit: 100, cursor: ""}}
    ) {
      searchMarketplaceEditions(input: {
        filters: { byPlayTagIDs: $byPlayTagIDs, bySetPlayTagIDs: $bySetPlayTagIDs }
        sortBy: EDITION_CREATED_AT_DESC
        searchInput: $searchInput
      }) {
        data {
          searchSummary {
            pagination { rightCursor }
            data {
              size
              data {
                ... on MarketplaceEdition {
                  id
                  assetPathPrefix
                  tier
                  parallelID
                  parallelName
                  set { id flowName flowSeriesNumber }
                  play {
                    id flowID
                    stats {
                      playerName firstName lastName
                      teamAtMoment teamAtMomentNbaId
                      nbaSeason jerseyNumber playerID
                      playCategory dateOfMoment
                    }
                    tags { id title visible level }
                  }
                  setPlay {
                    ID flowRetired
                    tags { id title visible level }
                    circulations {
                      burned circulationCount forSaleByCollectors
                      hiddenInPacks ownedByCollectors locked effectiveSupply
                    }
                  }
                  lowAsk highestOffer
                  circulationCount effectiveSupply burned locked owned hiddenInPacks
                  averageSaleData { averagePrice numDays numSales }
                  marketplaceStats {
                    price averageSalePrice
                    change24h change7d change30d
                    volume24h volume7d volume30d
                  }
                }
              }
            }
          }
        }
      }
    }
  `

  function computeBadgeScore(playTags, setPlayTags) {
    const pIds = new Set((playTags || []).map(t => t.id))
    const sIds = new Set((setPlayTags || []).map(t => t.id))
    let score = 0
    if (pIds.has(BADGE.ROOKIE_YEAR)) score += 1
    if (pIds.has(BADGE.ROOKIE_PREMIERE)) score += 1
    if (pIds.has(BADGE.TOP_SHOT_DEBUT)) score += 1
    if (sIds.has(BADGE.ROOKIE_MINT)) score += 1
    const isThreeStar = pIds.has(BADGE.ROOKIE_YEAR) &&
                        pIds.has(BADGE.ROOKIE_PREMIERE) &&
                        pIds.has(BADGE.TOP_SHOT_DEBUT)
    if (isThreeStar && sIds.has(BADGE.ROOKIE_MINT)) score += 4
    if (pIds.has(BADGE.ROOKIE_OF_THE_YEAR)) score += 3
    return score
  }

  function normalizeEdition(e) {
    const playTags = (e.play?.tags || []).filter(t => t.visible && t.id !== BADGE.INTERACTIVE)
    const setPlayTags = (e.setPlay?.tags || []).filter(t => t.visible && t.id !== BADGE.INTERACTIVE)
    const pIds = new Set(playTags.map(t => t.id))
    const sIds = new Set(setPlayTags.map(t => t.id))
    const circ = e.setPlay?.circulations || {}
    const totalCirc = circ.circulationCount || 0
    const burned = circ.burned || 0
    const locked = circ.locked || 0
    const owned = circ.ownedByCollectors || 0
    const set_id = e.set?.id || null
    const play_id = e.play?.id || null
    const external_id = (set_id && play_id) ? `${set_id}:${play_id}` : null
    return {
      id: e.id,
      collection_id: COLLECTION_ID,
      external_id,
      set_id,
      play_id,
      player_id: e.play?.stats?.playerID || null,
      player_name: e.play?.stats?.playerName || null,
      team: e.play?.stats?.teamAtMoment || null,
      team_nba_id: e.play?.stats?.teamAtMomentNbaId || null,
      season: e.play?.stats?.nbaSeason || null,
      set_name: e.set?.flowName || null,
      series_number: e.set?.flowSeriesNumber || null,
      tier: e.tier || null,
      parallel_id: e.parallelID ?? 0,
      parallel_name: e.parallelName || "Standard",
      play_tags: playTags.map(t => ({ id: t.id, title: t.title })),
      set_play_tags: setPlayTags.map(t => ({ id: t.id, title: t.title })),
      is_three_star_rookie: pIds.has(BADGE.ROOKIE_YEAR) && pIds.has(BADGE.ROOKIE_PREMIERE) && pIds.has(BADGE.TOP_SHOT_DEBUT),
      has_rookie_mint: sIds.has(BADGE.ROOKIE_MINT),
      badge_score: computeBadgeScore(playTags, setPlayTags),
      low_ask: e.lowAsk || null,
      highest_offer: e.highestOffer || null,
      avg_sale_price: parseFloat(e.averageSaleData?.averagePrice || "0") || null,
      circulation_count: totalCirc,
      effective_supply: circ.effectiveSupply || null,
      burned: burned,
      locked: locked,
      owned: owned,
      hidden_in_packs: circ.hiddenInPacks || null,
      burn_rate_pct: totalCirc > 0 ? parseFloat((burned / totalCirc * 100).toFixed(1)) : 0,
      lock_rate_pct: owned > 0 ? parseFloat((locked / owned * 100).toFixed(1)) : 0,
      flow_retired: e.setPlay?.flowRetired || false,
      asset_path_prefix: e.assetPathPrefix || null,
      updated_at: new Date().toISOString(),
    }
  }

  async function fetchPage(playTagIDs, cursor, setPlayTagIDs = []) {
    const res = await fetch("https://nbatopshot.com/marketplace/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        operationName: "SearchMarketplaceEditions",
        query: QUERY,
        variables: {
          byPlayTagIDs: playTagIDs,
          bySetPlayTagIDs: setPlayTagIDs,
          searchInput: {
            pagination: { direction: "RIGHT", limit: PAGE_LIMIT, cursor: cursor || "" }
          }
        }
      })
    })
    if (!res.ok) throw new Error(`Top Shot API ${res.status}`)
    const json = await res.json()
    const summary = json?.data?.searchMarketplaceEditions?.data?.searchSummary
    const editions = summary?.data?.data || []
    const nextCursor = summary?.pagination?.rightCursor || null
    const total = summary?.data?.size || 0
    return { editions, nextCursor, total }
  }

  async function upsertToSupabase(rows) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/badge_editions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
        "Prefer": "resolution=merge-duplicates",
      },
      body: JSON.stringify(rows)
    })
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Supabase error ${res.status}: ${err}`)
    }
  }

  async function sweep(label, tagIDs, setPlayTagIDs = []) {
    console.log(`  Sweeping: ${label}...`)
    const collected = []
    const seenCursors = new Set()
    let cursor = ""
    let pageNum = 0

    while (pageNum < MAX_PAGES) {
      if (cursor && seenCursors.has(cursor)) {
        console.log(`    Stopping: cursor loop detected at page ${pageNum}`)
        break
      }
      if (cursor) seenCursors.add(cursor)

      const { editions, nextCursor, total } = await fetchPage(tagIDs, cursor, setPlayTagIDs)
      pageNum++
      console.log(`    Page ${pageNum}: ${editions.length} editions (total: ${total})`)

      for (const e of editions) collected.push(e)

      if (!nextCursor || editions.length < PAGE_LIMIT || nextCursor === cursor) {
        console.log(`    Sweep complete after ${pageNum} pages`)
        break
      }

      cursor = nextCursor
      await new Promise(r => setTimeout(r, 400))
    }

    if (pageNum >= MAX_PAGES) console.log(`    Hit max page limit (${MAX_PAGES})`)
    return collected
  }

  console.log("🏀 RPC Badge Sync starting...")

  const allEditions = new Map()

  const sweepResults = [
    await sweep("Rookie Year",       [BADGE.ROOKIE_YEAR]),
    await sweep("Top Shot Debut",    [BADGE.TOP_SHOT_DEBUT]),
    await sweep("ROTY",              [BADGE.ROOKIE_OF_THE_YEAR]),
    await sweep("Rookie Mint",       [], [BADGE.ROOKIE_MINT]),
    await sweep("Championship Year", [BADGE.CHAMPIONSHIP_YEAR]),
  ]

  for (let i = 0; i < sweepResults.length; i++) {
    const editions = sweepResults[i]
    const isRookieMintSweep = i === 3
    for (const e of editions) {
      if (!allEditions.has(e.id)) {
        allEditions.set(e.id, normalizeEdition(e))
      } else if (isRookieMintSweep) {
        // Merge set_play_tags so three-star rookies who also have Rookie Mint
        // retain all their play-level tags rather than being overwritten.
        const existing = allEditions.get(e.id)
        const newSetPlayTags = (e.setPlay?.tags || [])
          .filter(t => t.visible && t.id !== BADGE.INTERACTIVE)
          .map(t => ({ id: t.id, title: t.title }))
        const mergedIds = new Set(existing.set_play_tags.map(t => t.id))
        for (const t of newSetPlayTags) {
          if (!mergedIds.has(t.id)) {
            existing.set_play_tags.push(t)
            mergedIds.add(t.id)
          }
        }
        if (newSetPlayTags.some(t => t.id === BADGE.ROOKIE_MINT)) {
          existing.has_rookie_mint = true
        }
      }
    }
  }

  console.log(`\n📦 Total unique editions collected: ${allEditions.size}`)
  console.log("⬆️  Upserting to Supabase...")

  const rows = Array.from(allEditions.values())
  let upserted = 0

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE)
    try {
      await upsertToSupabase(batch)
      upserted += batch.length
      console.log(`  Upserted ${upserted}/${rows.length}`)
    } catch (err) {
      console.error(`  Batch error at index ${i}:`, err.message)
    }
    await new Promise(r => setTimeout(r, 150))
  }

  console.log(`\n✅ SYNC COMPLETE — ${upserted} editions in Supabase`)
})()
