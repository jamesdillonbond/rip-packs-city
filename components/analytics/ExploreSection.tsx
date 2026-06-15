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
      <h2 className="text-lg font-semibold text-[color:var(--rpc-text-primary)] mb-4">{title}</h2>
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
                  ? "border-[color:var(--rpc-border)] bg-[color:var(--rpc-surface-raised)] cursor-not-allowed opacity-60"
                  : "border-[color:var(--rpc-border)] bg-[color:var(--rpc-surface-raised)] hover:border-emerald-500/40 hover:bg-[color:var(--rpc-surface-hover)]")
              }
            >
              <div className="flex items-start justify-between gap-2">
                <div className="font-medium text-[color:var(--rpc-text-primary)] text-sm">{item.label}</div>
                {!disabled ? (
                  <ArrowUpRight size={14} className="text-[color:var(--rpc-text-muted)]" />
                ) : (
                  <span className="rounded bg-[color:var(--rpc-surface-raised)] px-1.5 py-0.5 text-[9px] uppercase tracking-wider font-semibold text-[color:var(--rpc-text-muted)] border border-[color:var(--rpc-border)]">
                    Soon
                  </span>
                )}
              </div>
              <div className="text-xs text-[color:var(--rpc-text-secondary)] mt-1.5 leading-relaxed">
                {item.description}
              </div>
            </Cmp>
          )
        })}
      </div>
    </section>
  )
}
