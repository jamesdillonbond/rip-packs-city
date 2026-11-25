// components/pinnacle/PinnacleCapsuleNotice.tsx
//
// Shown on a Disney Pinnacle CHASE-ONLY pack page (lib/pinnacle/capsule-drops.ts, 2026-11-24): the page's opens are
// only the hidden chaser capsules of a mystery-capsule sale whose main capsules minted pins straight to buyers. Says
// so, and gives the floor on capsules sold from the mint record. A failed mint read drops that number, never a 0.

import type { PinnacleCapsuleDrop } from "@/lib/pinnacle/capsule-drops"
import { fetchCapsuleMintedToBuyers } from "@/lib/pinnacle/capsule-mints"

export default async function PinnacleCapsuleNotice({ capsule }: { capsule: PinnacleCapsuleDrop }) {
  const read = await fetchCapsuleMintedToBuyers(capsule)
  return (
    <section
      data-testid="pinnacle-capsule-notice"
      style={{ background: "var(--rpc-surface)", border: "1px solid var(--rpc-border-subtle)", borderLeft: "3px solid var(--rpc-border-hover)", borderRadius: 6, padding: "12px 16px", display: "flex", flexDirection: "column", gap: 6 }}
    >
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--rpc-text-muted)" }}>
        Chaser capsules only
      </span>
      <p style={{ margin: 0, fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: 1.5, color: "var(--rpc-text-secondary)" }}>
        The opens on this page are only the hidden chaser pins from the {capsule.capsuleName} capsule sale. The other capsules
        minted their pin straight to the buyer, outside any pack open, so the pulls here are not what a typical capsule held and
        are not an average for the drop.
      </p>
      {read.ok && read.mintedToBuyers > 0 ? (
        <span data-testid="pinnacle-capsule-minted" style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--rpc-text-muted)" }}>
          At least {read.mintedToBuyers.toLocaleString("en-US")} {capsule.capsuleName} capsules sold (pins minted to buyers during the sale)
        </span>
      ) : null}
    </section>
  )
}
