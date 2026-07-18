// components/play/PlayHub.tsx
//
// Play hub (2026-07-18 IA reorg) — the landing for Top Shot's game features.
// Challenges is live and links through; Fast Break + Road to the Ring are built
// but parked ("hidden for launch" — their route layouts still redirect), so they
// render here as non-clickable "Coming soon" cards until they're un-parked. When
// they go live, flip `live: true` on those entries and remove the redirect in
// their layout.tsx.

import Link from "next/link"

interface PlayFeature {
  key: string
  title: string
  blurb: string
  href: string
  live: boolean
  icon: string
}

export default function PlayHub({ collection, accent }: { collection: string; accent: string }) {
  const features: PlayFeature[] = [
    {
      key: "challenges",
      title: "Challenges",
      blurb:
        "Active Set & Crafting Challenges ranked by net EV — the reward's value minus the floor cost to complete. The 'should I finish this?' call Top Shot's own page doesn't compute.",
      href: `/${collection}/challenges`,
      live: true,
      icon: "🏆",
    },
    {
      key: "fast-break",
      title: "Fast Break",
      blurb:
        "Build the optimal Fast Break lineup from your wallet — projections, captain pick, and slate-aware optimization.",
      href: `/${collection}/fast-break`,
      live: false,
      icon: "⚡",
    },
    {
      key: "road-to-the-ring",
      title: "Road to the Ring",
      blurb:
        "Lock ROI calculator, tier progress tracker, and nightly pick recommendations for the Road to the Ring event.",
      href: `/${collection}/road-to-the-ring`,
      live: false,
      icon: "💍",
    },
  ]

  return (
    <div style={{ padding: "8px 0 40px" }}>
      <header style={{ marginBottom: 20 }}>
        <h1
          style={{
            fontFamily: "var(--font-display)",
            fontWeight: 900,
            fontSize: 26,
            letterSpacing: "0.04em",
            textTransform: "uppercase",
            color: "var(--rpc-text-primary)",
            margin: 0,
          }}
        >
          Play
        </h1>
        <p
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 13,
            color: "var(--rpc-text-secondary)",
            lineHeight: 1.6,
            margin: "8px 0 0",
            maxWidth: 720,
          }}
        >
          Top Shot game tools — Challenges, Fast Break, and Road to the Ring. Intelligence layers on top of
          Top Shot&rsquo;s live game modes.
        </p>
      </header>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 14 }}>
        {features.map((f) => {
          const card = (
            <div
              style={{
                background: "var(--rpc-surface)",
                border: "1px solid var(--rpc-border)",
                borderRadius: "var(--radius-lg)",
                padding: 20,
                height: "100%",
                display: "flex",
                flexDirection: "column",
                gap: 8,
                opacity: f.live ? 1 : 0.6,
                transition: "border-color 0.15s, box-shadow 0.15s",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 24 }}>{f.icon}</span>
                <span
                  style={{
                    fontFamily: "var(--font-display)",
                    fontWeight: 800,
                    fontSize: 18,
                    letterSpacing: "0.04em",
                    textTransform: "uppercase",
                    color: "var(--rpc-text-primary)",
                  }}
                >
                  {f.title}
                </span>
                <span
                  className="rpc-mono"
                  style={{
                    marginLeft: "auto",
                    fontSize: 9,
                    letterSpacing: "0.1em",
                    textTransform: "uppercase",
                    padding: "2px 8px",
                    borderRadius: 3,
                    color: f.live ? accent : "var(--rpc-text-muted)",
                    border: `1px solid ${f.live ? accent : "var(--rpc-border)"}`,
                  }}
                >
                  {f.live ? "Live" : "Coming soon"}
                </span>
              </div>
              <p
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 12,
                  lineHeight: 1.6,
                  color: "var(--rpc-text-secondary)",
                  margin: 0,
                }}
              >
                {f.blurb}
              </p>
              {f.live && (
                <span
                  className="rpc-mono"
                  style={{
                    marginTop: "auto",
                    fontSize: 11,
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                    color: accent,
                    fontWeight: 700,
                  }}
                >
                  Open {f.title} →
                </span>
              )}
            </div>
          )
          return f.live ? (
            <Link key={f.key} href={f.href} style={{ textDecoration: "none" }}>
              {card}
            </Link>
          ) : (
            <div key={f.key} aria-disabled title="Coming soon">
              {card}
            </div>
          )
        })}
      </div>
    </div>
  )
}
