"use client"

// components/entity/EditionActivity.tsx
// Feature 2 (2026-07-03). "Activity" section with a Sales | Offers pill toggle
// on the edition detail page. Sales reuses the existing paginated
// SalesTablePaginated (no regression — keeps "Load 30 more"); Offers renders the
// live standing-bid list from get_edition_offers (public.offers, status=open).
//
// Offer rows of type edition/subedition carry no serial (fillable by any
// serial) so the Serial column is blank — that's honest, not a bug. serial
// offers show their serial. offers is Top-Shot-only on-chain today; other
// collections show an empty Offers state and never error.

import { useMemo, useState } from "react"
import Link from "next/link"
import { EM_DASH, fmtUsd, relTime, truncWallet } from "./_shared"
import { useResolveUsernames } from "@/lib/analytics/username-resolver"
import SalesTablePaginated from "./SalesTablePaginated"

interface SaleRow {
  serial_number: number | null
  price_usd: number | null
  marketplace: string | null
  source: string | null
  buyer_address: string | null
  seller_address: string | null
  nft_id: string | null
  transaction_hash: string | null
  sold_at: string | null
}

export interface OfferRow {
  serial_number: number | null
  price_usd: number | null
  buyer_address: string | null
  offer_type: string | null
  made_at: string | null
}

interface Props {
  collectionUrlSlug: string
  routeSlug: string
  initialSales: SaleRow[]
  initialSalesOffset: number
  salesPageSize: number
  isAllDay: boolean
  offers: OfferRow[]
}

const TH: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 9,
  letterSpacing: "0.14em",
  textTransform: "uppercase",
  color: "var(--rpc-text-muted)",
  textAlign: "left",
  padding: "6px 10px",
  borderBottom: "1px solid var(--rpc-border)",
}

const TD: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--rpc-text-primary)",
  padding: "8px 10px",
  borderBottom: "1px solid var(--rpc-border-subtle)",
  whiteSpace: "nowrap",
}

function WalletCell({ address, name }: { address: string | null; name?: string | null }) {
  if (!address) return <span style={{ color: "var(--rpc-text-muted)" }}>{EM_DASH}</span>
  const lower = address.toLowerCase().startsWith("0x") ? address.toLowerCase() : `0x${address.toLowerCase()}`
  return (
    <Link
      href={`/profile/${lower}`}
      title={name ? `${name} · ${lower}` : lower}
      style={{ color: "var(--rpc-text-primary)", textDecoration: "none" }}
    >
      {name ? `@${name}` : truncWallet(address)}
    </Link>
  )
}

function OffersTable({ offers }: { offers: OfferRow[] }) {
  const addrs = useMemo(() => offers.map(o => o.buyer_address).filter((a): a is string => !!a), [offers])
  const names = useResolveUsernames(addrs)

  if (offers.length === 0) {
    return (
      <div style={{ padding: 12, color: "var(--rpc-text-muted)", fontFamily: "var(--font-mono)", fontSize: 12 }}>
        No open offers on this edition.
      </div>
    )
  }

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={TH}>Serial</th>
            <th style={TH}>Offer</th>
            <th style={TH}>Bidder</th>
            <th style={TH}>Scope</th>
            <th style={TH}>When</th>
          </tr>
        </thead>
        <tbody>
          {offers.map((o, i) => (
            <tr key={`${o.buyer_address ?? "o"}-${o.serial_number ?? "n"}-${i}`}>
              {/* edition/subedition offers have no serial (any serial fills) */}
              <td style={TD}>{o.serial_number != null && o.serial_number > 0 ? `#${o.serial_number}` : EM_DASH}</td>
              <td style={TD}>{fmtUsd(o.price_usd)}</td>
              <td style={TD}><WalletCell address={o.buyer_address} name={o.buyer_address ? names[o.buyer_address.toLowerCase()] : undefined} /></td>
              <td style={{ ...TD, color: "var(--rpc-text-secondary)", textTransform: "capitalize" }}>{o.offer_type ?? EM_DASH}</td>
              <td style={{ ...TD, color: "var(--rpc-text-secondary)" }}>{relTime(o.made_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

type Tab = "sales" | "offers"

export default function EditionActivity({
  collectionUrlSlug,
  routeSlug,
  initialSales,
  initialSalesOffset,
  salesPageSize,
  isAllDay,
  offers,
}: Props) {
  const [tab, setTab] = useState<Tab>("sales")

  return (
    <div>
      <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
        {([
          { v: "sales" as Tab, l: "Sales" },
          { v: "offers" as Tab, l: `Offers${offers.length ? ` · ${offers.length}` : ""}` },
        ]).map(({ v, l }) => (
          <button
            key={v}
            type="button"
            onClick={() => setTab(v)}
            className="rpc-chip"
            aria-pressed={tab === v}
            style={{
              background: tab === v ? "var(--rpc-red-bg)" : undefined,
              borderColor: tab === v ? "var(--rpc-red-border)" : undefined,
              color: tab === v ? "var(--rpc-red)" : undefined,
              cursor: "pointer",
            }}
          >{l}</button>
        ))}
      </div>

      {tab === "sales" ? (
        <SalesTablePaginated
          collectionUrlSlug={collectionUrlSlug}
          routeSlug={routeSlug}
          initial={initialSales}
          initialOffset={initialSalesOffset}
          pageSize={salesPageSize}
          isAllDay={isAllDay}
        />
      ) : (
        <OffersTable offers={offers} />
      )}
    </div>
  )
}
