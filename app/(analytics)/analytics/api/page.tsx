import type { Metadata } from "next"
import Link from "next/link"
import { Globe2 } from "lucide-react"
import { analyticsMetadata, ANALYTICS_BASE_URL } from "@/lib/analytics/seo"

export const metadata: Metadata = analyticsMetadata({
  title: "Public API — Programmatic Access to Rip Packs City Analytics",
  description:
    "Free read-only FMV pricing API for Flow collectibles. GET /api/fmv for single-edition lookups; POST /api/fmv for batch requests up to 100 editions.",
  path: "/analytics/api",
})

const datasetJsonLd = {
  "@context": "https://schema.org",
  "@type": "Dataset",
  name: "Rip Packs City Public Analytics API",
  description:
    "Public REST API for fair-market-value pricing across NBA Top Shot, NFL All Day, LaLiga Golazos, and other Flow digital collectibles.",
  creator: { "@type": "Organization", name: "Rip Packs City" },
  url: `${ANALYTICS_BASE_URL}/analytics/api`,
  license: "https://www.rippackscity.com/legal",
  distribution: [
    {
      "@type": "DataDownload",
      encodingFormat: "application/json",
      contentUrl: `${ANALYTICS_BASE_URL}/api/fmv?edition=219:7421`,
      description: "GET /api/fmv — single-edition FMV lookup",
    },
    {
      "@type": "DataDownload",
      encodingFormat: "application/json",
      contentUrl: `${ANALYTICS_BASE_URL}/api/fmv`,
      description: "POST /api/fmv — batch FMV lookup, up to 100 editions",
    },
  ],
}

// 2026-10-10: every example below is a REAL response captured from production that afternoon
// (values drift; the SHAPE is the contract). The previous examples documented fields the API has
// never returned (fmv_usd, serial, a string liquidity_rating, series, computed_at) and an example
// edition (27:1648) that does not exist -- the curl a developer copied answered "Edition not found".
const SAMPLE_RESPONSE = `{
  "edition": "219:7421",
  "fmv": 77,
  "serialMult": 7.6,
  "serialBasis": "first",
  "adjustedFmv": 585.3,
  "confidence": "high",
  "updatedAt": "2026-10-10T19:15:51.049029+00:00",
  "fallbackTier": "rpc_fmv",
  "liquidityRating": 2,
  "aspUsd": 80.55,
  "aspClean": 80.55,
  "salesCount30d": 10,
  "daysSinceSale": 6
}`

const BATCH_REQUEST = `curl -X POST https://www.rippackscity.com/api/fmv \\
  -H "Content-Type: application/json" \\
  -d '{
    "editions": [
      "219:7421",
      { "edition": "219:7404", "serial": 7 }
    ]
  }'`

const BATCH_RESPONSE = `{
  "count": 2,
  "successCount": 2,
  "errorCount": 0,
  "results": [
    {
      "edition": "219:7421",
      "fmv": 77,
      "serialMult": null,
      "serialBasis": null,
      "adjustedFmv": 77,
      "confidence": "high",
      "updatedAt": "2026-10-10T19:15:51.049029+00:00",
      "fallbackTier": "rpc_fmv",
      "liquidityRating": 2,
      "aspUsd": 80.55,
      "aspClean": 80.55,
      "salesCount30d": 10,
      "daysSinceSale": 6
    },
    {
      "edition": "219:7404",
      "fmv": 64,
      "serialMult": 1.83,
      "serialBasis": "jersey",
      "adjustedFmv": 116.82,
      "confidence": "high",
      "updatedAt": "2026-10-10T17:48:13.645186+00:00",
      "fallbackTier": "rpc_fmv",
      "liquidityRating": 2,
      "aspUsd": 63.42,
      "aspClean": 63.42,
      "salesCount30d": 7,
      "daysSinceSale": 1
    }
  ]
}`

const GET_EXAMPLE = `curl "https://www.rippackscity.com/api/fmv?edition=219:7421&serial=1"`

export default function ApiPage() {
  return (
    <div className="space-y-8 max-w-3xl">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(datasetJsonLd) }}
      />

      <header className="flex items-start gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-md bg-emerald-500/10 border border-emerald-500/20 flex-shrink-0">
          <Globe2 size={18} className="text-emerald-400" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-[color:var(--rpc-text-primary)] tracking-tight">Public API</h1>
          <p className="text-sm text-[color:var(--rpc-text-secondary)] mt-1">
            Programmatic access to Rip Packs City fair-market-value pricing.
          </p>
        </div>
      </header>

      <Section title="Overview">
        <p className="text-sm text-[color:var(--rpc-text-secondary)] leading-relaxed">
          RPC publishes FMV pricing as a free read-only API for partners. No API key
          required today. Rate-limited per-IP. Production base URL:{" "}
          <code className="rounded bg-[color:var(--rpc-surface-raised)] px-1 py-0.5 text-emerald-300">
            https://www.rippackscity.com
          </code>
          .
        </p>
      </Section>

      <Section title="Endpoints">
        <Endpoint
          method="GET"
          path="/api/fmv"
          description="Single-edition FMV lookup. The edition parameter is required and uses the setID:playID convention. The serial parameter is optional and applies a per-serial premium multiplier when supplied."
        >
          <ParamRow name="edition" required>
            <code>setID:playID</code> — e.g. <code>219:7421</code>. Required.
          </ParamRow>
          <ParamRow name="serial">
            Integer serial number. Optional. When supplied, the response carries the
            serial premium from our fitted model: <code>serialMult</code>,{" "}
            <code>serialBasis</code> (<code>first</code>, <code>jersey</code>,{" "}
            <code>perfect</code> or <code>no_premium</code>) and{" "}
            <code>adjustedFmv</code>.
          </ParamRow>
        </Endpoint>

        <Endpoint
          method="POST"
          path="/api/fmv"
          description="Batch FMV lookup. Accepts up to 100 editions per request. Each entry is either a bare edition string or an object with edition + optional serial."
        >
          <ParamRow name="editions" required>
            Array of editions. Each item is either <code>&quot;setID:playID&quot;</code> or{" "}
            <code>{"{ edition, serial? }"}</code>. Maximum 100 entries.
          </ParamRow>
        </Endpoint>

        <h3 className="mt-6 text-sm font-semibold text-[color:var(--rpc-text-primary)]">Response shape</h3>
        <p className="mt-1 text-sm text-[color:var(--rpc-text-secondary)]">
          GET returns a single result object; POST returns a wrapped batch payload with
          per-edition results.
        </p>
        <CodeBlock>{SAMPLE_RESPONSE}</CodeBlock>
        <p className="mt-2 text-xs text-[color:var(--rpc-text-muted)]">
          Per-result fields: <code>edition</code>, <code>fmv</code>,{" "}
          <code>serialMult</code>, <code>serialBasis</code>, <code>adjustedFmv</code>,{" "}
          <code>confidence</code> (lower-case: high | medium | low | ask_only | sales_only |
          stale | no_data), <code>updatedAt</code>, <code>fallbackTier</code>,{" "}
          <code>liquidityRating</code>, <code>aspUsd</code>, <code>aspClean</code>,{" "}
          <code>salesCount30d</code>, <code>daysSinceSale</code>; an unknown edition or one
          with no FMV yet carries <code>error</code>. <code>serialMult</code> is null when no
          serial was asked for, or when the edition&apos;s circulation cannot place the serial
          (<code>serialBasis: &quot;circulation_unknown&quot;</code>). Batch wrapper adds{" "}
          <code>count</code>, <code>successCount</code>, <code>errorCount</code>, and{" "}
          <code>results[]</code>.
        </p>
      </Section>

      <Section title="Worked example">
        <p className="text-sm text-[color:var(--rpc-text-secondary)]">GET request:</p>
        <CodeBlock>{GET_EXAMPLE}</CodeBlock>
        <p className="mt-4 text-sm text-[color:var(--rpc-text-secondary)]">Batch POST request:</p>
        <CodeBlock>{BATCH_REQUEST}</CodeBlock>
        <p className="mt-4 text-sm text-[color:var(--rpc-text-secondary)]">Batch response:</p>
        <CodeBlock>{BATCH_RESPONSE}</CodeBlock>
      </Section>

      <Section title="Methodology">
        <p className="text-sm text-[color:var(--rpc-text-secondary)] leading-relaxed">
          See the FMV methodology page for the algorithm — outlier-filtered weighted
          average price, serial multipliers, badge premiums, and confidence bucketing.
        </p>
        <Link
          href="/analytics/methodology/fmv"
          className="mt-3 inline-block text-sm text-emerald-400 hover:text-emerald-300"
        >
          Read the FMV methodology →
        </Link>
      </Section>

      <Section title="Rate limits">
        <p className="text-sm text-[color:var(--rpc-text-secondary)] leading-relaxed">
          Soft: 60 requests per minute per IP. Burst tolerated. Contact for higher quotas.
        </p>
      </Section>

      <Section title="Roadmap">
        <ul className="text-sm text-[color:var(--rpc-text-secondary)] leading-relaxed list-disc pl-5 space-y-1">
          <li>Per-collection slugs in batch payloads (today the endpoint is Top Shot first).</li>
          <li>Listings depth API — per-edition orderbook snapshot.</li>
          <li>Sales feed websocket — live event stream filtered by collection / edition.</li>
        </ul>
      </Section>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-[color:var(--rpc-border)] bg-[color:var(--rpc-surface-raised)] p-5">
      <h2 className="text-[10px] uppercase tracking-widest text-[color:var(--rpc-text-muted)] font-semibold mb-3">
        {title}
      </h2>
      {children}
    </section>
  )
}

function Endpoint({
  method,
  path,
  description,
  children,
}: {
  method: "GET" | "POST"
  path: string
  description: string
  children?: React.ReactNode
}) {
  const methodColor = method === "GET" ? "text-emerald-400 border-emerald-500/40 bg-emerald-500/10" : "text-amber-300 border-amber-500/40 bg-amber-500/10"
  return (
    <div className="mb-4 rounded-lg border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-4">
      <div className="flex items-center gap-2">
        <span className={`rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest border ${methodColor}`}>
          {method}
        </span>
        <code className="text-sm text-[color:var(--rpc-text-primary)] font-mono">{path}</code>
      </div>
      <p className="mt-2 text-sm text-[color:var(--rpc-text-secondary)] leading-relaxed">{description}</p>
      {children && <div className="mt-3 space-y-2">{children}</div>}
    </div>
  )
}

function ParamRow({
  name,
  required,
  children,
}: {
  name: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-0.5 text-sm">
      <div className="flex items-center gap-2">
        <code className="text-emerald-300">{name}</code>
        {required ? (
          <span className="rounded bg-rose-500/15 px-1.5 py-0.5 text-[9px] uppercase tracking-wider font-semibold text-rose-300 border border-rose-500/30">
            required
          </span>
        ) : null}
      </div>
      <div className="text-[color:var(--rpc-text-secondary)] leading-relaxed">{children}</div>
    </div>
  )
}

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="mt-2 overflow-x-auto rounded-lg border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-3 text-xs text-[color:var(--rpc-text-secondary)] font-mono leading-relaxed">
      {children}
    </pre>
  )
}
