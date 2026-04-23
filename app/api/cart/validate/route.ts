// app/api/cart/validate/route.ts
//
// Cart validation endpoint. Accepts a list of {listingResourceID, storefrontAddress}
// and, for each, asks Flow mainnet whether the listing still exists and at what
// price. Used by the cart drawer when it opens and again on "Buy All" click so
// the UI can flag sniped / price-changed listings before the user signs.

import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const FLOW_REST = 'https://rest-mainnet.onflow.org/v1'

const VALIDATE_LISTING_SCRIPT = `
import NFTStorefrontV2 from 0x4eb8a10cb9f87357

access(all) struct ListingStatus {
  access(all) let exists: Bool
  access(all) let currentPrice: UFix64?
  access(all) let sellerAddress: Address?
  init(exists: Bool, currentPrice: UFix64?, sellerAddress: Address?) {
    self.exists = exists
    self.currentPrice = currentPrice
    self.sellerAddress = sellerAddress
  }
}

access(all) fun main(storefrontAddress: Address, listingResourceID: UInt64): ListingStatus {
  let storefrontRef = getAccount(storefrontAddress)
    .capabilities
    .borrow<&{NFTStorefrontV2.StorefrontPublic}>(NFTStorefrontV2.StorefrontPublicPath)

  if storefrontRef == nil {
    return ListingStatus(exists: false, currentPrice: nil, sellerAddress: nil)
  }

  let listingRef = storefrontRef!.borrowListing(listingResourceID: listingResourceID)
  if listingRef == nil {
    return ListingStatus(exists: false, currentPrice: nil, sellerAddress: nil)
  }

  let details = listingRef!.getDetails()
  return ListingStatus(
    exists: true,
    currentPrice: details.salePrice,
    sellerAddress: storefrontAddress
  )
}
`

interface ValidationInput {
  listingResourceID: string
  storefrontAddress: string
  expectedPrice?: number | null
}

interface ValidationResult {
  exists: boolean
  currentPrice: number | null
  sellerAddress: string | null
  priceChanged: boolean
  sniped: boolean
  error?: string
}

function flowArg(type: string, value: string): string {
  return btoa(JSON.stringify({ type, value }))
}

function parseCadence(v: unknown): unknown {
  if (!v || typeof v !== 'object') return v
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const node = v as any
  const { type, value } = node
  if (type === 'Optional') return value != null ? parseCadence(value) : null
  if (['UInt64', 'UInt32', 'UInt8', 'Int', 'Int64'].includes(type)) return Number(value)
  if (['UFix64', 'Fix64'].includes(type)) return Number(value)
  if (['String', 'Bool', 'Address'].includes(type)) return value
  if (type === 'Array') return (value as unknown[]).map(parseCadence)
  if (['Struct', 'Resource', 'Event', 'Enum'].includes(type)) {
    const obj: Record<string, unknown> = {}
    for (const f of (value?.fields ?? []) as Array<{ name: string; value: unknown }>) {
      obj[f.name] = parseCadence(f.value)
    }
    return obj
  }
  return value
}

async function validateOne(
  input: ValidationInput
): Promise<ValidationResult> {
  try {
    const args = [
      flowArg('Address', input.storefrontAddress),
      flowArg('UInt64', String(input.listingResourceID)),
    ]
    const res = await fetch(`${FLOW_REST}/scripts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script: btoa(VALIDATE_LISTING_SCRIPT), arguments: args }),
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) {
      const text = await res.text()
      return {
        exists: false,
        currentPrice: null,
        sellerAddress: null,
        priceChanged: false,
        sniped: false,
        error: `flow ${res.status}: ${text.slice(0, 160)}`,
      }
    }
    const raw = await res.text()
    const decoded = JSON.parse(atob(raw.trim().replace(/^"|"$/g, '')))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parsed = parseCadence(decoded) as any

    const exists = !!parsed?.exists
    const currentPrice = typeof parsed?.currentPrice === 'number' ? parsed.currentPrice : null
    const sellerAddress = typeof parsed?.sellerAddress === 'string' ? parsed.sellerAddress : null

    const priceChanged =
      exists &&
      typeof input.expectedPrice === 'number' &&
      currentPrice !== null &&
      Math.abs(currentPrice - input.expectedPrice) > 0.00000001

    return {
      exists,
      currentPrice,
      sellerAddress,
      priceChanged,
      sniped: !exists,
    }
  } catch (e) {
    return {
      exists: false,
      currentPrice: null,
      sellerAddress: null,
      priceChanged: false,
      sniped: false,
      error: e instanceof Error ? e.message : String(e),
    }
  }
}

export async function POST(req: NextRequest) {
  let body: { listings?: ValidationInput[] }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }

  const listings = Array.isArray(body?.listings) ? body.listings : []
  if (listings.length === 0) {
    return NextResponse.json({ results: {} })
  }
  if (listings.length > 50) {
    return NextResponse.json({ error: 'max 50 listings per request' }, { status: 400 })
  }

  // Validate concurrently — each call is a single HTTP round-trip to Flow REST.
  const entries = await Promise.all(
    listings.map(async (l) => {
      const r = await validateOne(l)
      return [l.listingResourceID, r] as const
    })
  )

  const results: Record<string, ValidationResult> = {}
  for (const [id, r] of entries) {
    results[id] = r
  }

  return NextResponse.json({ results })
}
