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
      <h2 className="text-lg font-semibold text-slate-100 mb-4">{title}</h2>
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
                  ? "border-slate-800 bg-slate-900/30 cursor-not-allowed opacity-60"
                  : "border-slate-800 bg-slate-900/40 hover:border-emerald-500/40 hover:bg-slate-900/70")
              }
            >
              <div className="flex items-start justify-between gap-2">
                <div className="font-medium text-slate-100 text-sm">{item.label}</div>
                {!disabled ? (
                  <ArrowUpRight size={14} className="text-slate-500" />
                ) : (
                  <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[9px] uppercase tracking-wider font-semibold text-slate-500 border border-slate-700">
                    Soon
                  </span>
                )}
              </div>
              <div className="text-xs text-slate-400 mt-1.5 leading-relaxed">
                {item.description}
              </div>
            </Cmp>
          )
        })}
      </div>
    </section>
  )
}
