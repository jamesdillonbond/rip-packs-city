import { describe, it, expect } from "vitest"
import { readPoolExtras, seriesSetLabel } from "@/lib/giveaways/pool-extras"

// Series-qualified set names, edition badges and special serials for a giveaway
// pool (Trevor 2026-11-10: "Origins should have badges"; "use the series in front").

type Ed = { external_id: string; set_name: string; series: number; circulation_count: number; jersey_number: number }
function fakeDb(opts: { eds: Ed[]; allEds?: Ed[]; badges?: Record<string, string[]>; edsError?: string; rpcError?: string }) {
  const all = opts.allEds ?? opts.eds
  return {
    from: () => {
      const f: { eq: [string, unknown][]; neq: [string, unknown][]; in: string[] | null; lim: number | null } = { eq: [], neq: [], in: null, lim: null }
      const q: any = {
        select: () => q,
        eq: (c: string, v: unknown) => (f.eq.push([c, v]), q),
        neq: (c: string, v: unknown) => (f.neq.push([c, v]), q),
        in: (_c: string, v: string[]) => ((f.in = v), q),
        limit: (n: number) => ((f.lim = n), q),
        then: (res: (v: unknown) => void, rej: (e: unknown) => void) => {
          if (f.in) {
            if (opts.edsError) return Promise.resolve({ data: null, error: { message: opts.edsError } }).then(res, rej)
            return Promise.resolve({ data: opts.eds.filter((e) => f.in!.includes(e.external_id)), error: null }).then(res, rej)
          }
          const set = f.eq.find(([c]) => c === "set_name")?.[1]
          const not = f.neq.find(([c]) => c === "series")?.[1]
          const hit = all.filter((e) => e.set_name === set && e.series !== not).slice(0, f.lim ?? 99)
          return Promise.resolve({ data: hit, error: null }).then(res, rej)
        },
      }
      return q
    },
    rpc: () => Promise.resolve(opts.rpcError ? { data: null, error: { message: opts.rpcError } } : { data: opts.badges ?? {}, error: null }),
  } as never
}

const ORIGINS: Ed = { external_id: "201:7031", set_name: "Run It Back: Origins", series: 7, circulation_count: 1000, jersey_number: 0 }
const S1BASE: Ed = { external_id: "2:218", set_name: "Base Set", series: 0, circulation_count: 12000, jersey_number: 0 }
const S2BASE: Ed = { external_id: "26:559", set_name: "Base Set", series: 2, circulation_count: 15000, jersey_number: 0 }
const PLAYOFFS: Ed = { external_id: "39:1301", set_name: "2021 NBA Playoffs", series: 2, circulation_count: 2762, jersey_number: 0 }
const pm = (moment_id: string, e: Ed, serial: number) => ({ moment_id, edition_key: e.external_id, set_name: e.set_name, serial_number: serial })

describe("readPoolExtras", () => {
  it("Origins carries its canonical badges; a recurring set gets its series; a one-series set stays plain", async () => {
    const db = fakeDb({ eds: [ORIGINS, S1BASE, PLAYOFFS], allEds: [ORIGINS, { ...ORIGINS, external_id: "x", series: 8 }, S1BASE, S2BASE, PLAYOFFS], badges: { "201:7031": ["Rookie of the Year", "Rookie Premiere", "Rookie Year"], "2:218": [], "39:1301": [] } })
    const x = await readPoolExtras(db, "c", [pm("49900325", ORIGINS, 389), pm("485556", S1BASE, 4000), pm("15175586", PLAYOFFS, 2660)])
    expect(x.get("49900325")).toEqual({ set_label: "'24-25 Run It Back: Origins", badges: ["Rookie of the Year", "Rookie Premiere", "Rookie Year"], special_serial: [] })
    expect(x.get("485556")).toMatchObject({ set_label: "S1 Base Set", badges: [] })
    expect(x.get("15175586")).toMatchObject({ set_label: "2021 NBA Playoffs" })
  })

  it("special serials by the canonical rule: #1, perfect mint; Lillard's jersey 0 never matches", async () => {
    const db = fakeDb({ eds: [S2BASE], badges: {} })
    const x = await readPoolExtras(db, "c", [pm("a", S2BASE, 1), pm("b", S2BASE, 15000), pm("c", S2BASE, 0 + 7)])
    expect(x.get("a")!.special_serial).toEqual(["first"])
    expect(x.get("b")!.special_serial).toEqual(["perfect"])
    expect(x.get("c")!.special_serial).toEqual([])
  })

  it("a failed badge read is null (unknown), never [] (none); a failed editions read drops labels and serials, keeps badges", async () => {
    const a = await readPoolExtras(fakeDb({ eds: [ORIGINS], rpcError: "timeout" }), "c", [pm("1", ORIGINS, 5)])
    expect(a.get("1")!.badges).toBeNull()
    const b = await readPoolExtras(fakeDb({ eds: [ORIGINS], edsError: "boom", badges: { "201:7031": ["Rookie Year"] } }), "c", [pm("1", ORIGINS, 5)])
    expect(b.get("1")).toEqual({ set_label: null, badges: ["Rookie Year"], special_serial: null })
  })

  it("seriesSetLabel decodes Top Shot's on-chain series (0 = Series 1)", () => {
    expect(seriesSetLabel("Base Set", 0, true)).toBe("S1 Base Set")
    expect(seriesSetLabel("Metallic Gold LE", 4, true)).toBe("S3 Metallic Gold LE")
  })
})
