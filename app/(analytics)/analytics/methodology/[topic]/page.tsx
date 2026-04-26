import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { Book } from "lucide-react"
import { METHODOLOGY } from "@/lib/analytics/methodology"
import { analyticsMetadata, ANALYTICS_BASE_URL } from "@/lib/analytics/seo"

interface Params {
  topic: string
}

export async function generateStaticParams() {
  return Object.keys(METHODOLOGY).map((topic) => ({ topic }))
}

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>
}): Promise<Metadata> {
  const { topic } = await params
  const entry = METHODOLOGY[topic]
  if (!entry) {
    return analyticsMetadata({
      title: "Methodology — Rip Packs City",
      description: "Methodology for Rip Packs City analytics.",
      path: `/analytics/methodology/${topic}`,
    })
  }
  return analyticsMetadata({
    title: `${entry.title} — Rip Packs City`,
    description: entry.blurb,
    path: `/analytics/methodology/${entry.slug}`,
  })
}

export default async function MethodologyTopicPage({
  params,
}: {
  params: Promise<Params>
}) {
  const { topic } = await params
  const entry = METHODOLOGY[topic]
  if (!entry) notFound()

  const articleJsonLd = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: entry.title,
    description: entry.blurb,
    author: { "@type": "Organization", name: "Rip Packs City" },
    publisher: { "@type": "Organization", name: "Rip Packs City" },
    url: `${ANALYTICS_BASE_URL}/analytics/methodology/${entry.slug}`,
  }

  return (
    <div className="space-y-8 max-w-3xl">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(articleJsonLd) }}
      />
      <header className="flex items-start gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-md bg-emerald-500/10 border border-emerald-500/20 flex-shrink-0">
          <Book size={18} className="text-emerald-400" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-slate-50 tracking-tight">{entry.title}</h1>
          <p className="text-sm text-slate-400 mt-1">{entry.blurb}</p>
        </div>
      </header>

      <article className="space-y-4 text-slate-300 leading-relaxed">
        {entry.paragraphs.map((p, i) => (
          <p key={i} dangerouslySetInnerHTML={{ __html: p }} />
        ))}
      </article>

      <section>
        <h2 className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold mb-3">
          Data sources
        </h2>
        <ul className="space-y-2">
          {entry.sources.map((s) => (
            <li key={s} className="flex items-start gap-2.5 text-sm text-slate-300">
              <span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-emerald-500" />
              <span>{s}</span>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold mb-2">
          Refresh cadence
        </h2>
        <p className="text-sm text-slate-300">{entry.refresh}</p>
      </section>

      <Link
        href="/analytics/methodology"
        className="inline-block text-sm text-emerald-400 hover:text-emerald-300"
      >
        ← Back to all methodology
      </Link>
    </div>
  )
}
