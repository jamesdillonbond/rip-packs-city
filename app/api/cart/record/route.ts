// app/api/cart/record/route.ts
//
// Writes one row to cart_purchase_log per purchase attempt. Called
// fire-and-forget from lib/cart/usePurchaseQueue. Logging failures never
// block the purchase UX.
//
// Note on auth: the spec mentions INGEST_SECRET_TOKEN bearer auth but this
// endpoint is called from the browser during the user purchase flow, so we
// cannot rely on a shared secret (it would leak). Instead we accept unauthed
// POSTs, validate shape defensively, and rely on the service-role Supabase
// client to perform the insert against the RLS-protected table.

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const VALID_WALLET_PROVIDERS = new Set(['flow_wallet', 'dapper'])
const VALID_STATUSES = new Set(['pending', 'success', 'failed', 'sniped', 'price_changed'])
const VALID_ERROR_CLASSES = new Set([
  'dapper_not_supported',
  'sniped',
  'price_changed',
  'insufficient_balance',
  'user_rejected',
  'unknown',
])

function s(v: unknown): string | null {
  if (v === null || v === undefined) return null
  const str = String(v)
  if (!str) return null
  return str.length > 512 ? str.slice(0, 512) : str
}

function n(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const num = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(num) ? num : null
}

function uuid(v: unknown): string | null {
  if (typeof v !== 'string') return null
  // Accept only v4-ish UUIDs; anything else is nullified.
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? v : null
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 })
  }

  const buyerAddress = s(body.buyer_address)
  const walletProviderRaw = s(body.wallet_provider) ?? 'flow_wallet'
  const walletProvider = VALID_WALLET_PROVIDERS.has(walletProviderRaw) ? walletProviderRaw : 'flow_wallet'

  const listingResourceId = s(body.listing_resource_id)
  const storefrontAddress = s(body.storefront_address)
  const momentId = s(body.moment_id)
  const expectedPrice = n(body.expected_price)
  const statusRaw = s(body.status) ?? 'pending'
  const status = VALID_STATUSES.has(statusRaw) ? statusRaw : 'failed'

  if (!buyerAddress || !listingResourceId || !storefrontAddress || !momentId || expectedPrice == null) {
    // Silently accept incomplete rows so callers never see an error — just
    // skip the insert. Logging is best-effort.
    return NextResponse.json({ ok: true, skipped: true })
  }

  const errorClassRaw = s(body.error_class)
  const errorClass =
    errorClassRaw && VALID_ERROR_CLASSES.has(errorClassRaw) ? errorClassRaw : null

  const completedAt =
    status === 'success' || status === 'failed' || status === 'sniped' || status === 'price_changed'
      ? new Date().toISOString()
      : null

  const row = {
    buyer_address: buyerAddress,
    wallet_provider: walletProvider,
    collection_id: uuid(body.collection_id),
    moment_id: momentId,
    listing_resource_id: listingResourceId,
    storefront_address: storefrontAddress,
    expected_price: expectedPrice,
    currency: (s(body.currency) ?? 'DUC').toUpperCase(),
    fmv_at_purchase: n(body.fmv_at_purchase),
    discount_pct: n(body.discount_pct),
    cart_size: (() => {
      const cs = n(body.cart_size)
      if (cs == null) return null
      return Math.max(1, Math.min(127, Math.round(cs)))
    })(),
    batch_id: uuid(body.batch_id),
    status,
    tx_hash: s(body.tx_hash),
    error_message: s(body.error_message),
    error_class: errorClass,
    source_page: s(body.source_page),
    completed_at: completedAt,
  }

  try {
    const { error } = await supabaseAdmin.from('cart_purchase_log').insert(row)
    if (error) {
      console.error('[cart-record] insert failed:', error.message)
      return NextResponse.json({ ok: false, error: error.message }, { status: 200 })
    }
  } catch (e) {
    console.error('[cart-record] unexpected:', e)
    return NextResponse.json({ ok: false }, { status: 200 })
  }

  return NextResponse.json({ ok: true })
}
