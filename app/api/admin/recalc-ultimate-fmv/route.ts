import { NextRequest, NextResponse } from 'next/server'
import { verifyAdminRequest } from '@/lib/admin-auth'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'
export const maxDuration = 60
export const dynamic = 'force-dynamic'

async function handler(req: NextRequest) {
  const adminToken = process.env.RPC_ADMIN_TOKEN
  if (!adminToken) {
    return NextResponse.json({ error: 'admin_token_not_configured' }, { status: 500 })
  }

  // Constant-time (security audit 2026-10-25, R134 step 1). Bearer or ?token=, as before.
  if (!verifyAdminRequest(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!
  const supa = createClient(url, key, { auth: { persistSession: false } })

  const startedAt = new Date().toISOString()
  const { data, error } = await supa.rpc('recalc_ultimate_fmv')
  if (error) {
    return NextResponse.json({ ok: false, startedAt, error: error.message }, { status: 500 })
  }

  const row = Array.isArray(data) ? data[0] : data
  return NextResponse.json({
    ok: true,
    startedAt,
    finishedAt: new Date().toISOString(),
    result: row,
  })
}

export async function POST(req: NextRequest) {
  return handler(req)
}

export async function GET(req: NextRequest) {
  return handler(req)
}
