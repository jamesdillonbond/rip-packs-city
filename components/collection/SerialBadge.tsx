import SpecialSerialGlyph from "@/components/SpecialSerialGlyph"

// Serial-trait pill cluster (#1 / Jersey Match / Perfect Mint) for the
// wallet-collection table. Extracted verbatim in the Phase 1 refactor.
// 2026-07-11: each pill now leads with the RPC special-serial badge glyph
// (medal / jersey / bullseye — same set as edition/moment pages + trophy PDF)
// instead of rendering as a bare text pill.
export default function SerialBadge({ serial, mintSize, jerseyNumber, collection = null }: { serial: number | undefined; mintSize: number | undefined; jerseyNumber: number | null | undefined; collection?: string | null }) {
  if (!serial) return null
  const tags: { tag: string; label: string; title: string; color: string }[] = []
  if (serial === 1)
    tags.push({ tag: "#1", label: "#1", title: "Serial #1", color: "bg-yellow-950 text-yellow-300 border border-yellow-700" })
  if (jerseyNumber && serial === jerseyNumber)
    tags.push({ tag: "jersey", label: "JM", title: "Jersey Match — #" + jerseyNumber, color: "bg-teal-950 text-teal-300 border border-teal-700" })
  if (mintSize && serial === mintSize)
    tags.push({ tag: "perfect", label: "PM", title: "Perfect Mint — #" + serial + "/" + mintSize, color: "bg-violet-950 text-violet-300 border border-violet-700" })
  if (tags.length === 0) return null
  return (
    <span className="flex gap-1 flex-wrap">
      {tags.map(tag => (
        <span key={tag.label} title={tag.title} className={"rounded px-1 py-0.5 text-[10px] font-bold inline-flex items-center gap-0.5 " + tag.color}>
          <SpecialSerialGlyph tag={tag.tag} size={11} collection={collection} />
          {tag.label}
        </span>
      ))}
    </span>
  )
}
