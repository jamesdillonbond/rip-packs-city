// components/entity/HeroMontage.tsx
// Phase 2 (entity media). A small fixed-size row of moment thumbnails shown
// beside the text hero on Set / Team / Series pages, which otherwise have a
// text-only hero. Pure server component — the calling page already holds the
// edition array (or fetched the team's top editions), so it just passes the
// first N thumbnail URLs. Renders nothing when there are no thumbnails.

interface MontageItem {
  thumbnail_url: string | null
  name?: string | null
}

export default function HeroMontage({ items, max = 5 }: { items: MontageItem[]; max?: number }) {
  const thumbs = (items ?? []).filter((i) => !!i.thumbnail_url).slice(0, max)
  if (thumbs.length === 0) return null
  return (
    <div
      aria-hidden="true"
      style={{ display: "flex", gap: 6, flexWrap: "nowrap", overflow: "hidden" }}
    >
      {thumbs.map((t, i) => (
        <div
          key={i}
          style={{
            width: 72,
            height: 72,
            flex: "0 0 auto",
            borderRadius: 4,
            overflow: "hidden",
            border: "1px solid var(--rpc-border)",
            background: "rgba(0,0,0,0.35)",
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={t.thumbnail_url as string}
            alt={t.name ?? ""}
            width={72}
            height={72}
            loading="eager"
            fetchPriority="high"
            decoding="async"
            style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
          />
        </div>
      ))}
    </div>
  )
}
