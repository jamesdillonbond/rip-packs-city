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
      contentUrl: `${ANALYTICS_BASE_URL}/api/fmv?edition=27:1648`,
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

const SAMPLE_RESPONSE = `{
  "edition": "27:1648",
  "fmv_usd": 3.42,
  "serial": null,
  "confidence": "HIGH",
  "liquidity_rating": "high",
  "computed_at": "2026-05-07T01:14:22.318Z",
  "series": 4,
  "sales_count_30d": 41,
  "days_since_sale": 0
}`

const BATCH_REQUEST = `curl -X POST https://www.rippackscity.com/api/fmv \\
  -H "Content-Type: application/json" \\
  -d '{
    "editions": [
      "1234:5678",
      { "edition": "9876:5432", "serial": 7 }
    ]
  }'`

const BATCH_RESPONSE = `{
  "count": 2,
  "successCount": 2,
  "errorCount": 0,
  "results": [
    {
      "edition": "1234:5678",
      "serial": null,
      "fmv_usd": 12.55,
      "confidence": "HIGH",
      "liquidity_rating": "high",
      "computed_at": "2026-05-07T01:14:22Z",
      "series": 7,
      "sales_count_30d": 28,
      "days_since_sale": 0
    },
    {
      "edition": "9876:5432",
      "serial": 7,
      "fmv_usd": 184.20,
      "confidence": "MEDIUM",
      "liquidity_rating": "medium",
      "computed_at": "2026-05-07T01:14:22Z",
      "series": 4,
      "sales_count_30d": 6,
      "days_since_sale": 2
    }
  ]
}`

const GET_EXAMPLE = `curl https://www.rippackscity.com/api/fmv?edition=27:1648`

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
          <h1 className="text-2xl font-bold text-slate-50 tracking-tight">Public API</h1>
          <p className="text-sm text-slate-400 mt-1">
            Programmatic access to Rip Packs City fair-market-value pricing.
          </p>
        </div>
      </header>

      <Section title="Overview">
        <p className="text-sm text-slate-300 leading-relaxed">
          RPC publishes FMV pricing as a free read-only API for partners. No API key
          required today. Rate-limited per-IP. Production base URL:{" "}
          <code className="rounded bg-slate-900 px-1 py-0.5 text-emerald-300">
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
            <code>setID:playID</code> — e.g. <code>27:1648</code>. Required.
          </ParamRow>
          <ParamRow name="serial">
            Integer serial number. Optional. When supplied, the response includes a
            serial-aware FMV adjustment.
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

        <h3 className="mt-6 text-sm font-semibold text-slate-100">Response shape</h3>
        <p className="mt-1 text-sm text-slate-400">
          GET returns a single result object; POST returns a wrapped batch payload with
          per-edition results.
        </p>
        <CodeBlock>{SAMPLE_RESPONSE}</CodeBlock>
        <p className="mt-2 text-xs text-slate-500">
          Per-result fields: <code>edition</code>, <code>serial</code>, <code>fmv_usd</code>
          , <code>confidence</code> (HIGH | MEDIUM | LOW | ASK_ONLY),{" "}
          <code>liquidity_rating</code>, <code>computed_at</code>, <code>series</code>,{" "}
          <code>sales_count_30d</code>, <code>days_since_sale</code>. Batch wrapper adds{" "}
          <code>count</code>, <code>successCount</code>, <code>errorCount</code>, and{" "}
          <code>results[]</code>.
        </p>
      </Section>

      <Section title="Worked example">
        <p className="text-sm text-slate-300">GET request:</p>
        <CodeBlock>{GET_EXAMPLE}</CodeBlock>
        <p className="mt-4 text-sm text-slate-300">Batch POST request:</p>
        <CodeBlock>{BATCH_REQUEST}</CodeBlock>
        <p className="mt-4 text-sm text-slate-300">Batch response:</p>
        <CodeBlock>{BATCH_RESPONSE}</CodeBlock>
      </Section>

      <Section title="Methodology">
        <p className="text-sm text-slate-300 leading-relaxed">
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
        <p className="text-sm text-slate-300 leading-relaxed">
          Soft: 60 requests per minute per IP. Burst tolerated. Contact for higher quotas.
        </p>
      </Section>

      <Section title="Roadmap">
        <ul className="text-sm text-slate-300 leading-relaxed list-disc pl-5 space-y-1">
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
    <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-5">
      <h2 className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold mb-3">
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
    <div className="mb-4 rounded-lg border border-slate-800 bg-slate-950 p-4">
      <div className="flex items-center gap-2">
        <span className={`rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest border ${methodColor}`}>
          {method}
        </span>
        <code className="text-sm text-slate-100 font-mono">{path}</code>
      </div>
      <p className="mt-2 text-sm text-slate-400 leading-relaxed">{description}</p>
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
      <div className="text-slate-400 leading-relaxed">{children}</div>
    </div>
  )
}

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="mt-2 overflow-x-auto rounded-lg border border-slate-800 bg-slate-950 p-3 text-xs text-slate-200 font-mono leading-relaxed">
      {children}
    </pre>
  )
}
