import type { NextConfig } from "next"
import { withSentryConfig } from "@sentry/nextjs"

const nextConfig: NextConfig = {
  async redirects() {
    return [
      { source: "/wallet",  destination: "/nba-top-shot/collection", permanent: false },
      { source: "/packs",   destination: "/nba-top-shot/packs",      permanent: false },
      { source: "/sniper",  destination: "/nba-top-shot/sniper",     permanent: false },
      { source: "/badges",  destination: "/nba-top-shot/badges",     permanent: false },
      { source: "/sets",    destination: "/nba-top-shot/sets",       permanent: false },
    ]
  },
}

export default withSentryConfig(nextConfig, {
  // Suppresses source map upload logs during build
  silent: true,
  // Upload source maps for better stack traces (requires SENTRY_AUTH_TOKEN)
  widenClientFileUpload: true,
})
