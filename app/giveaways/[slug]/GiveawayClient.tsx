"use client"

// app/giveaways/[slug]/GiveawayClient.tsx
//
// The public giveaway page. Four states, never collapsed: loading · not found ·
// could not load · the drop. A claim failure shows the route's own copy.

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import type { PublicDropView } from "@/lib/giveaways/store"
import { deliveryLabel, ptTime, statusLabel, usd, verifyCommand } from "@/lib/giveaways/view-format"

type View = PublicDropView & { signed_in: boolean }
type Load = { kind: "loading" } | { kind: "not_found" } | { kind: "error" } | { kind: "ok"; view: View }

const DISPLAY = "var(--font-display)"
const MONO = "var(--font-mono)"

const card: React.CSSProperties = {
  background: "var(--rpc-surface)",
  border: "1px solid var(--rpc-border)",
  borderRadius: 10,
  padding: 16,
}
const h2: React.CSSProperties = { fontFamily: DISPLAY, fontSize: 20, letterSpacing: 0.5, margin: "0 0 10px", textTransform: "uppercase" }
const muted: React.CSSProperties = { color: "var(--rpc-text-muted)", fontSize: 13 }

async function fetchView(slug: string): Promise<Load> {
  try {
    const res = await fetch(`/api/giveaways/${encodeURIComponent(slug)}`, { cache: "no-store" })
    if (res.status === 404) return { kind: "not_found" }
    if (!res.ok) return { kind: "error" }
    return { kind: "ok", view: (await res.json()) as View }
  } catch {
    return { kind: "error" }
  }
}

export default function GiveawayClient({ slug }: { slug: string }) {
  const [load, setLoad] = useState<Load>({ kind: "loading" })
  const [username, setUsername] = useState("")
  const [agree, setAgree] = useState(false)
  const [claiming, setClaiming] = useState(false)
  const [claimError, setClaimError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    void fetchView(slug).then(setLoad)
  }, [slug])

  useEffect(() => {
    let live = true
    void fetchView(slug).then((l) => {
      if (live) setLoad(l)
    })
    return () => {
      live = false
    }
  }, [slug])

  const claim = useCallback(async () => {
    setClaiming(true)
    setClaimError(null)
    try {
      const res = await fetch(`/api/giveaways/${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, agree }),
      })
      if (res.ok) {
        refresh()
      } else {
        let message = "We couldn't record your claim. Try again in a moment."
        try {
          const body = (await res.json()) as { error?: unknown }
          if (typeof body?.error === "string") message = body.error
        } catch {
          // not our JSON (a proxy or platform error page): keep the generic copy
        }
        setClaimError(message)
      }
    } catch {
      setClaimError("We couldn't reach Rip Packs City. Check your connection and try again.")
    } finally {
      setClaiming(false)
    }
  }, [slug, username, agree, refresh])

  if (load.kind === "loading") return <p style={muted}>Loading the giveaway…</p>
  if (load.kind === "not_found") {
    return (
      <div style={card}>
        <h1 style={{ ...h2, fontSize: 26 }}>Giveaway not found</h1>
        <p style={muted}>This link doesn&apos;t match a live giveaway. Check it with whoever shared it.</p>
      </div>
    )
  }
  if (load.kind === "error") {
    return (
      <div style={card}>
        <h1 style={{ ...h2, fontSize: 26 }}>Couldn&apos;t load this giveaway</h1>
        <p style={muted}>Something went wrong on our side. Nothing about the giveaway has changed.</p>
        <button type="button" onClick={refresh} style={buttonStyle(false)}>
          Try again
        </button>
      </div>
    )
  }

  const { drop, pool, values, verification, me, signed_in } = load.view
  const left = drop.pack_count - drop.claimed_count

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <header>
        <div style={{ ...muted, fontFamily: MONO, textTransform: "uppercase" }}>Free pack giveaway · sponsored by {drop.sponsor_name}</div>
        <h1 style={{ fontFamily: DISPLAY, fontSize: 36, margin: "6px 0", textTransform: "uppercase" }}>{drop.title}</h1>
        {drop.description ? <p style={{ margin: "0 0 8px", color: "var(--rpc-text-secondary)" }}>{drop.description}</p> : null}
        <div style={{ fontFamily: MONO, fontSize: 13, color: "var(--rpc-text-secondary)" }}>
          {statusLabel(drop.status, drop.claimed_count, drop.pack_count)} · {drop.pack_count} packs of {drop.moments_per_pack} Top Shot
          {drop.moments_per_pack === 1 ? " Moment" : " Moments"}
        </div>
      </header>

      {me ? (
        <section style={{ ...card, borderColor: "var(--rpc-red-border)" }}>
          <h2 style={h2}>Your pack · #{me.pack_no}</h2>
          <p style={muted}>
            Claimed {ptTime(me.claimed_at)} for Top Shot user <strong>@{me.topshot_username}</strong>. The sponsor gifts each Moment to that account in
            the Top Shot app; this page marks it delivered once it shows up there on chain.
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 10 }}>
            {me.moments.map((m) => (
              <div key={m.moment_id} style={{ ...card, background: "var(--rpc-surface-raised)" }}>
                <MomentLine m={m} />
                <div style={{ ...muted, marginTop: 6, color: m.delivered ? "var(--rpc-success)" : "var(--rpc-text-muted)" }}>
                  {deliveryLabel(m.delivered, m.last_checked_at)}
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : drop.status === "open" && left > 0 ? (
        <section style={card}>
          <h2 style={h2}>Claim a pack</h2>
          {signed_in ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 440 }}>
              <label style={muted}>
                Your Top Shot username (the account the sponsor gifts to)
                <input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="username"
                  autoComplete="off"
                  style={{
                    display: "block",
                    width: "100%",
                    marginTop: 4,
                    padding: "8px 10px",
                    borderRadius: 6,
                    border: "1px solid var(--rpc-border)",
                    background: "var(--rpc-bg)",
                    color: "var(--rpc-text-primary)",
                    fontFamily: MONO,
                  }}
                />
              </label>
              <label style={{ ...muted, display: "flex", gap: 8, alignItems: "flex-start" }}>
                <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
                <span>I am 18 or older and I agree to the official rules below.</span>
              </label>
              <button type="button" disabled={claiming || !agree || username.trim().length < 2} onClick={claim} style={buttonStyle(claiming || !agree || username.trim().length < 2)}>
                {claiming ? "Claiming…" : "Claim my pack"}
              </button>
              {claimError ? <p style={{ color: "var(--rpc-danger)", margin: 0 }}>{claimError}</p> : null}
              <p style={muted}>Your pack is drawn at random from the packs still unclaimed. One pack per person and per Top Shot account.</p>
            </div>
          ) : (
            <p style={{ margin: 0 }}>
              <Link href={`/login?next=${encodeURIComponent(`/giveaways/${drop.slug}`)}`} style={{ color: "var(--rpc-red)" }}>
                Sign in to claim a pack
              </Link>
              <span style={muted}> · free, no purchase necessary.</span>
            </p>
          )}
        </section>
      ) : null}

      <section style={card}>
        <h2 style={h2}>What&apos;s in the packs</h2>
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap", fontFamily: MONO, fontSize: 14, marginBottom: 12 }}>
          <Stat label="Total FMV" value={usd(values.pool_fmv_usd)} />
          <Stat label="Average pack" value={usd(values.mean_pack_usd)} />
          <Stat label="Typical pack" value={usd(values.median_pack_usd)} />
          <Stat label="Best pack" value={usd(values.best_pack_usd)} />
        </div>
        <p style={muted}>
          Every Moment in the giveaway is listed below, in order of value, not by pack. The typical pack is the median: half the packs are worth more, half less.
          FMV is Rip Packs City&apos;s fair-market estimate when the giveaway was sealed.
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 10 }}>
          {pool.map((m) => (
            <div key={m.moment_id} style={{ ...card, padding: 12 }}>
              <MomentLine m={m} />
            </div>
          ))}
        </div>
      </section>

      <section style={card}>
        <h2 style={h2}>Provably fair</h2>
        <p style={muted}>
          Before claims opened, the Moments were shuffled into packs and this fingerprint of that assignment was published. It can&apos;t be changed afterwards
          without the fingerprint changing.
        </p>
        <code style={{ display: "block", fontFamily: MONO, fontSize: 12, wordBreak: "break-all", padding: 8, background: "var(--rpc-bg)", borderRadius: 6 }}>
          sha256 {drop.seal_hash}
        </code>
        <p style={muted}>Sealed {ptTime(drop.sealed_at)}.</p>
        {verification ? (
          <>
            <p style={muted}>The giveaway has closed, so the secret and the full pack list are public. Run this and compare it to the fingerprint above:</p>
            <code style={{ display: "block", fontFamily: MONO, fontSize: 12, wordBreak: "break-all", padding: 8, background: "var(--rpc-bg)", borderRadius: 6 }}>
              {verifyCommand(verification.salt, verification.manifest)}
            </code>
            <p style={muted}>The pack list reads pack:moment,moment,…; with packs separated by semicolons.</p>
          </>
        ) : (
          <p style={muted}>When the giveaway closes, the secret and the full pack list are published here so anyone can check the fingerprint.</p>
        )}
      </section>

      <section style={card}>
        <h2 style={h2}>Official rules</h2>
        <ol style={{ ...muted, paddingLeft: 18, lineHeight: 1.55, margin: 0 }}>
          <li>
            <strong>No purchase necessary.</strong> A purchase of any kind does not improve your chances. Entry is free.
          </li>
          <li>
            <strong>Sponsor:</strong> {drop.sponsor_name}. Rip Packs City provides the giveaway tool and is not the sponsor. Not affiliated with or endorsed by
            the NBA, NBA Top Shot, Dapper Labs or any team.
          </li>
          <li>
            <strong>Eligibility:</strong> 18 or older, with a Rip Packs City account and an NBA Top Shot account. Void where prohibited. The sponsor may not
            claim.
          </li>
          <li>
            <strong>How to enter:</strong> sign in, enter your Top Shot username and claim while the giveaway is open. One pack per person, per Rip Packs City
            account and per Top Shot account.
          </li>
          <li>
            <strong>Prizes and odds:</strong> {drop.pack_count} packs of {drop.moments_per_pack}, total approximate value {usd(values.pool_fmv_usd)} (Rip Packs
            City FMV at sealing). Each claim receives one pack drawn uniformly at random from the packs still unclaimed. Pack contents were fixed before claims
            opened (see Provably fair).
          </li>
          <li>
            <strong>Delivery:</strong> the sponsor gifts each Moment to the Top Shot account you entered, in the Top Shot app. Prizes can&apos;t be exchanged
            for cash. Recipients are responsible for any taxes.
          </li>
          <li>
            <strong>Your data:</strong> your Top Shot username and your pack are shared with the sponsor so they can deliver it.
          </li>
          <li>The sponsor may end the giveaway early; packs already claimed are still delivered.</li>
        </ol>
      </section>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: "var(--rpc-text-muted)", textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontSize: 18, color: "var(--rpc-text-primary)" }}>{value}</div>
    </div>
  )
}

function MomentLine({ m }: { m: { player_name: string | null; set_name: string | null; tier: string | null; serial_number: number | null; fmv_usd: number | null } }) {
  return (
    <>
      <div style={{ fontFamily: DISPLAY, fontSize: 16, textTransform: "uppercase" }}>{m.player_name ?? "Unknown player"}</div>
      <div style={{ fontSize: 12, color: "var(--rpc-text-secondary)" }}>{m.set_name ?? "—"}</div>
      <div style={{ fontFamily: MONO, fontSize: 12, marginTop: 4, color: "var(--rpc-text-secondary)" }}>
        {(m.tier ?? "").toUpperCase()}
        {m.serial_number != null ? ` · #${m.serial_number}` : ""} · {usd(m.fmv_usd)}
      </div>
    </>
  )
}

function buttonStyle(disabled: boolean): React.CSSProperties {
  return {
    padding: "10px 14px",
    borderRadius: 6,
    border: "none",
    background: disabled ? "var(--rpc-surface-hover)" : "var(--rpc-red)",
    color: disabled ? "var(--rpc-text-muted)" : "var(--rpc-text-primary)",
    fontFamily: DISPLAY,
    fontSize: 16,
    letterSpacing: 0.5,
    textTransform: "uppercase",
    cursor: disabled ? "default" : "pointer",
    alignSelf: "flex-start",
  }
}
