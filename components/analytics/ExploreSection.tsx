import Link from "next/link"
import { ArrowUpRight } from "lucide-react"

interface ExploreItem {
  label: string
  description: string
  href?: string
  enabled?: boolean
}

interface ExploreSectionProps {
  title: string
  items: ExploreItem[]
}

export default function ExploreSection({ title, items }: ExploreSectionProps) {
  return (
    <section>
      <h2 className="text-lg font-semibold text-zinc-100 mb-4">{title}</h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {items.map((item) => {
          const disabled = !item.enabled || !item.href
          const Cmp: React.ElementType = disabled ? "div" : Link
          const props = disabled ? {} : { href: item.href }
          return (
            <Cmp
              key={item.label}
              {...props}
              className={
                "block rounded-lg border p-4 transition-colors " +
                (disabled
                  ? "border-zinc-800 bg-zinc-900/30 cursor-not-allowed opacity-60"
                  : "border-zinc-800 bg-zinc-900/40 hover:border-emerald-500/40 hover:bg-zinc-900/70")
              }
            >
              <div className="flex items-start justify-between gap-2">
                <div className="font-medium text-zinc-100 text-sm">{item.label}</div>
                {!disabled ? (
                  <ArrowUpRight size={14} className="text-zinc-500" />
                ) : (
                  <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[9px] uppercase tracking-wider font-semibold text-zinc-500 border border-zinc-700">
                    Soon
                  </span>
                )}
              </div>
              <div className="text-xs text-zinc-400 mt-1.5 leading-relaxed">
                {item.description}
              </div>
            </Cmp>
          )
        })}
      </div>
    </section>
  )
}
