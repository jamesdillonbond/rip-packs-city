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
import { supabaseAdmin } from "@/lib/supabase"
import { getCollection, getCollectionUuid } from "@/lib/collections"

interface EntityLink {
  href: string
  name: string
  sub: string | null
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb = supabaseAdmin as any

async function loadLinks(collection: string): Promise<EntityLink[]> {
  try {
    if (collection === "disney-pinnacle") {
      const { data, error } = await sb
        .from("pinnacle_editions")
        .select("id, character_name, set_name")
        .not("thumbnail_url", "is", null)
        .not("character_name", "is", null)
        .order("mint_count", { ascending: true, nullsFirst: false })
        .limit(18)
      if (error || !Array.isArray(data)) return []
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return data.map((r: any) => ({
        href: `/disney-pinnacle/edition/${encodeURIComponent(r.id)}`,
        name: r.character_name as string,
        sub: (r.set_name as string) ?? null,
      }))
    }

    const uuid = getCollectionUuid(collection)
    if (!uuid) return []
    const { data, error } = await sb
      .from("editions")
      .select("external_id, player_name, set_name")
      .eq("collection_id", uuid)
      .not("thumbnail_url", "is", null)
      .not("player_name", "is", null)
      .not("external_id", "is", null)
      .order("circulation_count", { ascending: true, nullsFirst: false })
      .limit(18)
    if (error || !Array.isArray(data)) return []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return data.map((r: any) => ({
      href: `/${collection}/edition/${encodeURIComponent(r.external_id)}`,
      name: r.player_name as string,
      sub: (r.set_name as string) ?? null,
    }))
  } catch {
    return []
  }
}

export default async function PopularOnCollection({ collection }: { collection: string }) {
  const coll = getCollection(collection)
  if (!coll) return null
  const links = await loadLinks(collection)
  if (links.length === 0) return null

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
    </section>
  )
}
