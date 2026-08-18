// components/entity/PopularOnCollection.tsx
//
// Server-rendered public fan-out for the per-collection /overview page. The
// overview page itself is a client component whose prominent links (Tools,
// "View all") point at auth-gated tabs that 302→/login for an anonymous
// crawler. This block adds real, server-rendered links into public entity
// pages so Googlebot has a path FROM the high-authority /overview page INTO
// the ~24K-page entity corpus (which was otherwise reachable only via the XML
// sitemap). SEO internal-linking pass, 2026-06-05.
//
// Standard collections link to /<collection>/edition/<external_id> (the
// route_slug get_edition_detail resolves on). Disney Pinnacle editions live in
// pinnacle_editions with text ids, and the edition page resolves Pinnacle on
// pe.id, so those link to /disney-pinnacle/edition/<id>.

import Link from "next/link"
import { getCollection } from "@/lib/collections"
import { fetchHubRows, fetchLinkRows } from "@/lib/entity/popular-on-collection-fetchers"
import { slugifyName } from "@/lib/entity-labels"
import { isExhibitionTeamSlug } from "@/lib/team-denylist"
import { tileSubject } from "./_shared"

interface EntityLink {
  href: string
  name: string
  sub: string | null
}

// A link to a hub entity page (set / player / team / series). These pages each
// fan out to dozens of editions, so linking the overview → hubs flows crawl
// equity FAR deeper into the corpus than 18 leaf-edition links alone.
interface HubLink {
  href: string
  label: string
}

interface Hubs {
  sets: HubLink[]
  players: HubLink[]
  teams: HubLink[]
  series: HubLink[]
}

const EMPTY_HUBS: Hubs = { sets: [], players: [], teams: [], series: [] }

// Dedupe a list of raw entity names into the first `cap` distinct hub links.
// Slugs use slugifyName so they roundtrip with the sitemap + the entity RPCs.
export function distinctSlugLinks(
  names: Array<string | null | undefined>,
  collection: string,
  segment: "set" | "player" | "team" | "series",
  cap: number,
  dropExhibition = false,
): HubLink[] {
  const seen = new Set<string>()
  const out: HubLink[] = []
  for (const raw of names) {
    const name = (raw ?? "").trim()
    if (!name) continue
    const slug = slugifyName(name)
    if (!slug || seen.has(slug)) continue
    if (dropExhibition && isExhibitionTeamSlug(slug)) continue
    seen.add(slug)
    out.push({ href: `/${collection}/${segment}/${encodeURIComponent(slug)}`, label: name })
    if (out.length >= cap) break
  }
  return out
}

// Server-rendered hub links (sets / players / teams / series) for the four
// sports collections. Pinnacle is skipped — the sitemap doesn't enumerate
// Pinnacle set/player/team/series hubs (those routes resolve differently), so
// linking them here would manufacture crawl waste; Pinnacle keeps the edition
// fan-out only. Sourced from a single bounded, recency-ordered editions sample
// (diverse coverage, cheap) plus collection_series — the layout ISR-caches the
// segment hourly so these queries don't run per request.
async function loadHubs(collection: string): Promise<{ hubs: Hubs; ok: boolean; reason?: string }> {
  if (collection === "disney-pinnacle") return { hubs: EMPTY_HUBS, ok: true }
  const { data, ok, reason } = await fetchHubRows(collection)
  if (!ok) return { hubs: EMPTY_HUBS, ok: false, reason }
  return {
    hubs: {
      sets: distinctSlugLinks(data.editions.map((r) => r.set_name), collection, "set", 12),
      players: distinctSlugLinks(data.editions.map((r) => r.player_name), collection, "player", 12),
      teams: distinctSlugLinks(data.editions.map((r) => r.team_name), collection, "team", 10, true),
      series: distinctSlugLinks(data.series.map((r) => r.display_label), collection, "series", 12),
    },
    ok: true,
  }
}

async function loadLinks(collection: string): Promise<{ links: EntityLink[]; ok: boolean; reason?: string }> {
  const { data, ok, reason } = await fetchLinkRows(collection)
  if (!ok) return { links: [], ok: false, reason }
  if (collection === "disney-pinnacle") {
    return {
      links: data.map((r) => ({
        href: `/disney-pinnacle/edition/${encodeURIComponent(String(r.id))}`,
        name: r.character_name as string,
        sub: (r.set_name as string) ?? null,
      })),
      ok: true,
    }
  }
  return {
    links: data.map((r) => ({
      href: `/${collection}/edition/${encodeURIComponent(String(r.external_id))}`,
      name: tileSubject({ player_name: r.player_name, team_name: r.team_name, play_type: r.play_type, name: r.set_name }),
      sub: (r.set_name as string) ?? null,
    })),
    ok: true,
  }
}

// One labeled row of hub pill-links (e.g. "Sets" → 12 set pages). Renders
// nothing when the group is empty (UFC has no teams, etc.).
function HubRow({ label, links }: { label: string; links: HubLink[] }) {
  if (links.length === 0) return null
  return (
    <div style={{ marginTop: 12 }}>
      <div className="rpc-mono" style={{ fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--rpc-text-ghost)", marginBottom: 6 }}>
        {label}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {links.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className="rpc-mono"
            style={{
              display: "inline-block",
              padding: "4px 10px",
              border: "1px solid var(--rpc-border)",
              borderRadius: "var(--radius-sm)",
              background: "var(--rpc-surface-raised)",
              fontSize: "var(--text-xs)",
              color: "var(--rpc-text-secondary)",
              textDecoration: "none",
            }}
          >
            {l.label}
          </Link>
        ))}
      </div>
    </div>
  )
}

export default async function PopularOnCollection({ collection }: { collection: string }) {
  const coll = getCollection(collection)
  if (!coll) return null
  const [linkRes, hubRes] = await Promise.all([loadLinks(collection), loadHubs(collection)])
  const links = linkRes.links
  const hubs = hubRes.hubs

  // ⚠ A FAILED READ AND AN EMPTY CATALOGUE BOTH RENDER NOTHING HERE, and that
  // is the right call — an anonymous crawler has no use for a degraded notice
  // and there is no honest user-facing claim to make about absent internal
  // links. But the two must remain DISTINGUISHABLE somewhere, or a timeout
  // silently deletes the crawl path from a page that still returns 200 and
  // still looks complete. This log is that somewhere: it makes an SEO
  // regression falsifiable instead of invisible.
  if (!linkRes.ok) console.warn(`[popular-on-collection] links read failed collection=${collection}: ${linkRes.reason}`)
  if (!hubRes.ok) console.warn(`[popular-on-collection] hubs read failed collection=${collection}: ${hubRes.reason}`)

  const hasHubs = hubs.sets.length + hubs.players.length + hubs.teams.length + hubs.series.length > 0
  if (links.length === 0 && !hasHubs) return null

  return (
    <section className="rpc-card" style={{ padding: "16px 20px", marginTop: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <div style={{ width: 6, height: 6, borderRadius: "50%", background: coll.accent }} />
        <span className="rpc-label">Explore the {coll.label} catalog</span>
        <Link
          href="/insights"
          className="rpc-mono"
          style={{ marginLeft: "auto", fontSize: "var(--text-xs)", color: "var(--rpc-text-muted)", textDecoration: "none" }}
        >
          Public insights →
        </Link>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 8 }}>
        {links.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            style={{
              display: "block",
              padding: "10px 12px",
              background: "var(--rpc-surface-raised)",
              border: "1px solid var(--rpc-border)",
              borderRadius: "var(--radius-sm)",
              textDecoration: "none",
            }}
          >
            <div
              style={{
                fontFamily: "var(--font-display)",
                fontWeight: 700,
                fontSize: "var(--text-sm)",
                color: "var(--rpc-text-primary)",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {l.name}
            </div>
            {l.sub ? (
              <div
                className="rpc-mono"
                style={{
                  fontSize: "var(--text-xs)",
                  color: "var(--rpc-text-muted)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {l.sub}
              </div>
            ) : null}
          </Link>
        ))}
      </div>

      {/* Hub links — sets / players / teams / series. Each target page itself
          fans out to many editions, so these are the high-leverage internal
          links that push crawl depth into the corpus. (SEO pass, 2026-06-21) */}
      {hasHubs && (
        <div style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid var(--rpc-border)" }}>
          <HubRow label="Sets" links={hubs.sets} />
          <HubRow label="Players" links={hubs.players} />
          <HubRow label="Teams" links={hubs.teams} />
          <HubRow label="Series" links={hubs.series} />
        </div>
      )}
    </section>
  )
}
