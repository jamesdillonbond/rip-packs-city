"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import {
  LayoutDashboard,
  Activity,
  BarChart3,
  List,
  HandCoins,
  Users,
  Package,
  Layers,
  Sparkles,
  Book,
  Code,
} from "lucide-react"

type IconType = React.ComponentType<{ size?: number; className?: string; strokeWidth?: number }>

interface NavItem {
  label: string
  href: string
  icon: IconType
  badge?: string
}

interface NavGroup {
  title?: string
  items: NavItem[]
}

const GROUPS: NavGroup[] = [
  {
    items: [
      { label: "Overview", href: "/analytics", icon: LayoutDashboard },
    ],
  },
  {
    title: "Markets",
    items: [
      { label: "Pulse", href: "/analytics/pulse", icon: Activity },
      { label: "Sales", href: "/analytics/sales", icon: BarChart3 },
      { label: "Listings", href: "/analytics/listings", icon: List },
    ],
  },
  {
    title: "Capital",
    items: [
      { label: "Loans", href: "/analytics/loans", icon: HandCoins, badge: "Flowty" },
    ],
  },
  {
    title: "People",
    items: [
      { label: "Wallets", href: "/analytics/wallets", icon: Users },
    ],
  },
  {
    title: "Products",
    items: [
      { label: "Packs", href: "/analytics/packs", icon: Package },
      { label: "Sets", href: "/analytics/sets", icon: Layers },
    ],
  },
  {
    title: "Intelligence",
    items: [
      { label: "FMV Index", href: "/analytics/fmv", icon: Sparkles },
    ],
  },
]

const RESOURCES: NavItem[] = [
  { label: "Methodology", href: "/analytics/methodology", icon: Book },
  { label: "Public API", href: "/analytics/api", icon: Code },
]

function isActive(pathname: string, href: string): boolean {
  if (href === "/analytics") return pathname === "/analytics"
  return pathname === href || pathname.startsWith(href + "/")
}

function ItemRow({ item, pathname }: { item: NavItem; pathname: string }) {
  const active = isActive(pathname, item.href)
  const Icon = item.icon
  return (
    <Link
      href={item.href}
      className={
        "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm border transition-colors " +
        (active
          ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
          : "text-slate-400 border-transparent hover:bg-slate-900/60 hover:text-slate-100")
      }
    >
      <Icon size={16} strokeWidth={2} />
      <span className="flex-1">{item.label}</span>
      {item.badge ? (
        <span
          className={
            "rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wider font-semibold border " +
            (active
              ? "border-emerald-500/40 text-emerald-300"
              : "border-slate-700 text-slate-500")
          }
        >
          {item.badge}
        </span>
      ) : null}
    </Link>
  )
}

export default function AnalyticsSidebar() {
  const pathname = usePathname() ?? "/analytics"

  return (
    <aside
      className="hidden lg:block sticky self-start"
      style={{
        top: 72,
        width: 240,
        flexShrink: 0,
        maxHeight: "calc(100vh - 80px)",
        overflowY: "auto",
      }}
    >
      <nav className="flex flex-col gap-5 pr-2 pb-8">
        {GROUPS.map((group, gi) => (
          <div key={gi} className="flex flex-col gap-1">
            {group.title ? (
              <div className="px-3 py-1 text-[10px] uppercase tracking-widest text-slate-500 font-semibold">
                {group.title}
              </div>
            ) : null}
            {group.items.map((item) => (
              <ItemRow key={item.href} item={item} pathname={pathname} />
            ))}
          </div>
        ))}
        <div className="my-2 border-t border-slate-800" />
        <div className="flex flex-col gap-1">
          <div className="px-3 py-1 text-[10px] uppercase tracking-widest text-slate-500 font-semibold">
            Resources
          </div>
          {RESOURCES.map((item) => (
            <ItemRow key={item.href} item={item} pathname={pathname} />
          ))}
        </div>
      </nav>
    </aside>
  )
}
