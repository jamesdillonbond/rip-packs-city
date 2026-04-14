import { ImageResponse } from "@vercel/og"
import { createClient } from "@supabase/supabase-js"

export const runtime = "edge"

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ""

function fmtDollars(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0"
  if (n >= 1_000_000) return "$" + (n / 1_000_000).toFixed(1) + "M"
  if (n >= 1000) return "$" + (n / 1000).toFixed(1) + "K"
  return "$" + Math.round(n).toLocaleString()
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ username: string }> }
) {
  const { username } = await ctx.params
  const key = decodeURIComponent(username ?? "")

  let displayName = key || "Collector"
  let tagline: string | null = null
  let totalFmv = 0
  let momentCount = 0
  let walletCount = 0

  if (SUPABASE_URL && SERVICE_KEY && key) {
    try {
      const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
      })
      const [bioRes, walletsRes] = await Promise.all([
        supabase
          .from("profile_bio")
          .select("display_name, tagline")
          .eq("owner_key", key)
          .maybeSingle(),
        supabase
          .from("saved_wallets")
          .select("cached_fmv, cached_moment_count")
          .eq("owner_key", key),
      ])
      if (bioRes.data) {
        displayName = bioRes.data.display_name ?? displayName
        tagline = bioRes.data.tagline ?? null
      }
      for (const w of walletsRes.data ?? []) {
        totalFmv += Number((w as any).cached_fmv ?? 0) || 0
        momentCount += Number((w as any).cached_moment_count ?? 0) || 0
        walletCount += 1
      }
    } catch {
      // fall through with defaults
    }
  }

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "56px 72px",
          background: "#080808",
          color: "#fff",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
          <div
            style={{
              fontSize: 28,
              fontWeight: 800,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
            }}
          >
            Rip Packs City
          </div>
          <div
            style={{
              width: 120,
              height: 3,
              background: "#E03A2F",
              marginTop: 8,
            }}
          />
        </div>

        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
          <div
            style={{
              fontSize: 72,
              fontWeight: 800,
              letterSpacing: "-0.01em",
              color: "#fff",
              maxWidth: 1000,
              textAlign: "center",
            }}
          >
            {displayName}
          </div>
          {tagline && (
            <div
              style={{
                fontSize: 22,
                color: "#9CA3AF",
                marginTop: 14,
                maxWidth: 900,
                textAlign: "center",
              }}
            >
              {tagline}
            </div>
          )}
          <div style={{ display: "flex", gap: 16, marginTop: 36 }}>
            <div
              style={{
                display: "flex",
                padding: "12px 22px",
                background: "rgba(255,255,255,0.06)",
                border: "1px solid rgba(255,255,255,0.12)",
                borderRadius: 10,
                fontSize: 24,
                color: "#fff",
                fontWeight: 700,
              }}
            >
              {fmtDollars(totalFmv)} FMV
            </div>
            <div
              style={{
                display: "flex",
                padding: "12px 22px",
                background: "rgba(255,255,255,0.06)",
                border: "1px solid rgba(255,255,255,0.12)",
                borderRadius: 10,
                fontSize: 24,
                color: "#fff",
                fontWeight: 700,
              }}
            >
              {momentCount.toLocaleString()} Moments
            </div>
            <div
              style={{
                display: "flex",
                padding: "12px 22px",
                background: "rgba(255,255,255,0.06)",
                border: "1px solid rgba(255,255,255,0.12)",
                borderRadius: 10,
                fontSize: 24,
                color: "#fff",
                fontWeight: 700,
              }}
            >
              {walletCount} Wallets
            </div>
          </div>
        </div>

        <div
          style={{
            fontSize: 18,
            color: "#9CA3AF",
            textAlign: "center",
            width: "100%",
            fontFamily: "monospace",
            display: "flex",
            justifyContent: "center",
          }}
        >
          rip-packs-city.vercel.app/profile/{key}
        </div>
      </div>
    ),
    { width: 1200, height: 630 }
  )
}
