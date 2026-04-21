#!/usr/bin/env node

import { readFileSync } from 'fs'
import { resolve } from 'path'
import { createClient } from '@supabase/supabase-js'
import { execSync } from 'child_process'

/* ── env ─────────────────────────────────────────────────────────── */

function loadEnv() {
  try {
    const envPath = resolve(process.cwd(), '.env.local')
    const lines = readFileSync(envPath, 'utf-8').split('\n')
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq === -1) continue
      const key = trimmed.slice(0, eq).trim()
      let val = trimmed.slice(eq + 1).trim()
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
        val = val.slice(1, -1)
      if (!process.env[key]) process.env[key] = val
    }
  } catch {
    console.error('[cleanup-storefront-wallets] Could not read .env.local — run from project root')
    process.exit(1)
  }
}
loadEnv()

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const DRY_RUN = process.argv.includes('--dry-run')

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  console.log(`[cleanup-storefront-wallets] DRY_RUN=${DRY_RUN}`)

  const { data: wallets, error } = await supabase
    .from('storefront_audit_wallets')
    .select('address, expired_listings')
    .eq('cleanup_status', 'pending')
    .order('expired_listings', { ascending: false })
    .limit(100)

  if (error) {
    console.error('Failed to query storefront_audit_wallets:', error)
    process.exit(1)
  }

  console.log(`Found ${wallets.length} wallet(s) flagged for cleanup`)

  let cleaned = 0
  let errored = 0

  for (const wallet of wallets) {
    const { address, expired_listings } = wallet
    console.log(`\n→ ${address} (expired_listings=${expired_listings})`)

    if (DRY_RUN) {
      console.log('  [dry-run] would run: flow transactions send cleanup.cdc ' + address + ' --signer my-account --network mainnet --compute-limit 9999')
      continue
    }

    const cmd = `flow transactions send cleanup.cdc ${address} --signer my-account --network mainnet --compute-limit 9999`

    try {
      const stdout = execSync(cmd, {
        stdio: ['inherit', 'pipe', 'inherit'],
        timeout: 60000,
        encoding: 'utf-8',
      })

      const txIdLine = stdout
        .split('\n')
        .find((line) => line.trim().startsWith('Transaction ID:'))
      const txId = txIdLine ? txIdLine.split('Transaction ID:')[1].trim() : null

      const { error: updateError } = await supabase
        .from('storefront_audit_wallets')
        .update({
          cleanup_status: 'cleaned',
          cleanup_tx_id: txId,
          cleaned_at: new Date().toISOString(),
        })
        .eq('address', address)

      if (updateError) {
        console.error(`  DB update failed for ${address}:`, updateError)
        errored++
      } else {
        console.log(`  ✓ cleaned (tx=${txId})`)
        cleaned++
      }
    } catch (err) {
      console.error(`  ✗ transaction failed for ${address}:`, err.message || err)
      const { error: updateError } = await supabase
        .from('storefront_audit_wallets')
        .update({ cleanup_status: 'error' })
        .eq('address', address)

      if (updateError) {
        console.error(`  DB update (error status) failed for ${address}:`, updateError)
      }
      errored++
    }

    await sleep(2000)
  }

  console.log(`\n=== Summary ===`)
  console.log(`Cleaned: ${cleaned}`)
  console.log(`Errored: ${errored}`)
  console.log(`Total processed: ${cleaned + errored}`)
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
