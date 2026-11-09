// app/insights/drops/page.tsx — "Pack drops this week". SERVER component: one bounded read of the
// pack calendar (lib/insights/drops-board.ts), rendered without client JS. Metadata in layout.tsx.
//
// Honesty: a failed read shows the degraded notice and NO list (never "no drops"); a source we
// could not read is named; a drop with no price says nothing about price.
import Link from "next/link"
import DegradedDataNotice from "@/components/insights/DegradedDataNotice"
import { boardStatus, summarizeDegraded } from "@/lib/insights/board-status"
import { fetchBoardForPage } from "@/lib/insights/board-page-fetch"
import { fetchDropsBoard, orderDrops, dropStatusLine, type DropsBoard, type DropsBoardItem } from "@/lib/insights/drops-board"
import { getCollection } from "@/lib/collections"

export const revalidate = 900

const SOURCE_NAMES: Record<string, string> = {
  nba: "NBA Top Shot",
  nfl: "NFL All Day",
  laliga: "LaLiga Golazos",
  disney: "Disney Pinnacle",
  pinnacle_oe: "Pinnacle Open Editions",
  panini: "Panini",
  candy: "Candy MLB",
}

function usd(n: number): string {
  return "$" + n.toLocaleString("en-US", { maximumFractionDigits: n < 100 ? 2 : 0, minimumFractionDigits: n < 100 && n % 1 ? 2 : 0 })
}

function DropCard({ d }: { d: DropsBoardItem }) {
  const c = getCollection(d.collection.replace(/_/g, "-"))
  const body = (
    <>
      <div className="dr-chip">
        <span className="dr-dot" style={{ background: c?.accent ?? "var(--rpc-red)" }} />
        {c?.label ?? d.collection}
      </div>
      <div className="dr-title">{d.title}</div>
      <div className="dr-foot">
        {d.retail_usd != null ? <span className="dr-price">{usd(d.retail_usd)}</span> : null}
        <span className={`dr-when${d.status === "upcoming" ? " is-soon" : ""}`}>{dropStatusLine(d)}</span>
      </div>
    </>
  )
  const style = { borderTopColor: c?.accent ?? "var(--rpc-red)" }
  return d.page_live ? (
    <Link href={d.detail_href} className="dr-card is-link" style={style}>
      {body}
      <span className="dr-cta">Odds, pulls &amp; EV →</span>
    </Link>
  ) : (
    <div className="dr-card" style={style}>
      {body}
    </div>
  )
}

export default async function DropsPage() {
  const { data, fetchedAt, ok } = await fetchBoardForPage<DropsBoard | null>("Pack drops", null, (db) => fetchDropsBoard(db))
  const unread = data ? Object.entries(data.complete_at).filter(([, at]) => !at).map(([k]) => SOURCE_NAMES[k] ?? k) : []
  const { live, ended } = data ? orderDrops(data.drops) : { live: [], ended: [] }
  return (
    <main className="dr-wrap">
      <DegradedDataNotice summary={summarizeDegraded([boardStatus("Pack drops", ok)])} />
      <header className="dr-head">
        <div className="dr-eyebrow">Rip Packs City · Insights</div>
        <h1>
          Pack drops <em>this week</em>
        </h1>
        <p className="dr-sub">
          Every drop open now or starting in the next 7 days, priciest first. Times are Pacific; prices are retail.
          {fetchedAt ? ` Updated ${new Date(fetchedAt).toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} PT.` : ""}
        </p>
        {unread.length ? <p className="dr-unread">Not read this time (their drops may be missing): {unread.join(", ")}.</p> : null}
      </header>

      {data ? (
        <>
          {live.length ? (
            <section className="dr-grid">{live.map((d) => <DropCard key={`${d.collection}:${d.dist_id}`} d={d} />)}</section>
          ) : (
            <p className="dr-empty">No drop is open or scheduled in the next 7 days on the collections we read.</p>
          )}
          {data.announcements.length ? (
            <section className="dr-section">
              <h2>Announced</h2>
              <ul className="dr-list">
                {data.announcements.map((a) => (
                  <li key={a.url}>
                    Candy MLB:{" "}
                    <a href={a.url} target="_blank" rel="noopener noreferrer">
                      {a.title}
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {ended.length ? (
            <section className="dr-section">
              <h2>Ended this week</h2>
              <section className="dr-grid is-ended">{ended.map((d) => <DropCard key={`${d.collection}:${d.dist_id}`} d={d} />)}</section>
            </section>
          ) : null}
          <p className="dr-note">UFC Strike is not listed: its market is closed.</p>
        </>
      ) : null}

      <style>{`
        .dr-wrap { max-width: 1180px; margin: 0 auto; padding: 32px 16px 64px; color: var(--rpc-text-primary); }
        .dr-eyebrow { font-family: var(--font-mono); font-size: 12px; letter-spacing: 2px; text-transform: uppercase; color: var(--rpc-red-text); }
        .dr-head h1 { font-family: var(--font-display); font-size: clamp(40px, 8vw, 72px); line-height: .95; text-transform: uppercase; margin: 8px 0 10px; }
        .dr-head h1 em { font-style: normal; color: var(--rpc-red-text); }
        .dr-sub, .dr-unread, .dr-note, .dr-empty { font-family: var(--font-mono); font-size: 14px; color: var(--rpc-text-secondary); max-width: 760px; }
        .dr-unread { color: var(--rpc-warning-text); }
        .dr-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(260px, 100%), 1fr)); gap: 14px; margin: 26px 0; }
        .dr-grid.is-ended { opacity: .72; margin-top: 12px; }
        .dr-card { display: flex; flex-direction: column; min-height: 190px; padding: 16px 18px; border: 1px solid var(--rpc-border); border-top: 4px solid; border-radius: 12px; background: var(--rpc-surface-raised); color: inherit; text-decoration: none; }
        .dr-card.is-link:hover { background: var(--rpc-surface-hover); border-color: var(--rpc-border-hover); }
        .dr-chip { display: flex; align-items: center; gap: 8px; font-family: var(--font-mono); font-size: 12px; letter-spacing: 1px; text-transform: uppercase; color: var(--rpc-text-secondary); }
        .dr-dot { width: 9px; height: 9px; border-radius: 50%; }
        .dr-title { font-family: var(--font-display); font-size: 28px; line-height: 1.02; text-transform: uppercase; margin: 10px 0 auto; overflow-wrap: anywhere; }
        .dr-foot { display: flex; flex-direction: column; gap: 4px; margin-top: 14px; }
        .dr-price { font-family: var(--font-mono); font-size: 28px; }
        .dr-when { font-family: var(--font-mono); font-size: 14px; color: var(--rpc-red-text); }
        .dr-when.is-soon { color: var(--rpc-warning-text); }
        .dr-cta { margin-top: 12px; font-family: var(--font-mono); font-size: 12px; color: var(--rpc-text-secondary); }
        .dr-section h2 { font-family: var(--font-display); font-size: 28px; text-transform: uppercase; margin-top: 28px; }
        .dr-list { font-family: var(--font-mono); font-size: 14px; margin-top: 8px; padding-left: 18px; }
        .dr-list a { color: var(--rpc-red-text); }
      `}</style>
    </main>
  )
}
