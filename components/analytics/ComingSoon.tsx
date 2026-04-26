import { Sparkles } from "lucide-react"

interface ComingSoonProps {
  section: string
  expected: string
  description: string
  metrics: string[]
}

export default function ComingSoon({ section, expected, description, metrics }: ComingSoonProps) {
  return (
    <div className="flex justify-center pt-6 pb-16">
      <div
        className="w-full max-w-2xl rounded-xl border border-slate-800 bg-slate-900/40 p-8 sm:p-10"
        style={{ boxShadow: "0 0 0 1px rgba(16,185,129,0.04) inset" }}
      >
        <div className="flex items-center gap-2 text-emerald-400 mb-3">
          <Sparkles size={16} />
          <span className="text-[10px] uppercase tracking-widest font-semibold">
            Coming Soon
          </span>
        </div>
        <h1 className="text-3xl sm:text-4xl font-bold text-slate-50 tracking-tight mb-2">
          {section}
        </h1>
        <p className="text-xs uppercase tracking-widest text-slate-500 mb-6">
          Expected · {expected}
        </p>
        <p className="text-slate-300 leading-relaxed mb-8">{description}</p>
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-500 mb-3 font-semibold">
            What we&apos;ll surface
          </div>
          <ul className="space-y-2.5">
            {metrics.map((m) => (
              <li key={m} className="flex items-start gap-3 text-sm text-slate-300">
                <span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-emerald-500" />
                <span>{m}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}
