// __tests__/helpers/memory-supabase.ts
//
// An in-memory stand-in for the supabase-js query builder, good enough to run a
// small state machine (lib/trade-room/store.ts) end to end: insert / upsert /
// select / update / delete with eq / neq / in / is / not-in / not-is / gt / lt / or / order / limit / range /
// maybeSingle / single / count. UNIQUE and FK constraints are NOT enforced except
// where a test declares `uniques`, which raise code 23505 like Postgres. It is a
// test double, not Postgres: use it to prove ORDER and OUTCOME, not SQL semantics.

import type { SupabaseClient } from "@supabase/supabase-js"

type Row = Record<string, unknown>
type Filter = (r: Row) => boolean

export interface MemoryDb {
  db: SupabaseClient
  tables: Record<string, Row[]>
  /** Handlers for `db.rpc(name, args)`; unregistered names answer an error. */
  rpcs: Record<string, (args: Record<string, unknown>) => { data: unknown; error: { message: string } | null }>
  /** Every operation in order: "<op> <table>". */
  log: string[]
  /** Make the next matching operation fail (once). */
  failNext(op: string, table: string, message?: string): void
}

/**
 * `defaults` stands in for column DEFAULTs: applied to an inserted row's missing
 * columns (an `undefined` field), per table.
 */
export function memorySupabase(seed: Record<string, Row[]> = {}, uniques: Record<string, string[][]> = {}, defaults: Record<string, Row> = {}): MemoryDb {
  const tables: Record<string, Row[]> = {}
  for (const [t, rows] of Object.entries(seed)) tables[t] = rows.map((r) => ({ ...r }))
  const log: string[] = []
  const failures: Array<{ op: string; table: string; message: string }> = []
  let seq = 0
  const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`

  function violates(table: string, row: Row, except?: Row): string | null {
    for (const cols of uniques[table] ?? []) {
      const dup = (tables[table] ?? []).find((r) => r !== except && cols.every((c) => r[c] === row[c]))
      if (dup) return `duplicate key value violates unique constraint (${cols.join(",")})`
    }
    return null
  }

  function from(table: string) {
    tables[table] ??= []
    const filters: Filter[] = []
    let op: "select" | "insert" | "update" | "delete" | "upsert" = "select"
    let payload: Row | Row[] | null = null
    let upsertOn: string[] = []
    const orderBy: Array<{ col: string; asc: boolean; nullsFirst: boolean }> = []
    let lim: number | null = null
    let offset = 0
    let single: "maybe" | "one" | null = null
    let wantCount = false
    let head = false
    const b: Record<string, unknown> = {}
    const chain = (f?: Filter) => {
      if (f) filters.push(f)
      return b
    }
    Object.assign(b, {
      select: (_cols?: string, opts?: { count?: string; head?: boolean }) => {
        if (opts?.count) wantCount = true
        if (opts?.head) head = true
        return b
      },
      insert: (p: Row | Row[]) => ((op = "insert"), (payload = p), b),
      upsert: (p: Row | Row[], o?: { onConflict?: string }) => ((op = "upsert"), (payload = p), (upsertOn = (o?.onConflict ?? "").split(",").map((s) => s.trim()).filter(Boolean)), b),
      update: (p: Row) => ((op = "update"), (payload = p), b),
      delete: () => ((op = "delete"), b),
      eq: (k: string, v: unknown) => chain((r) => r[k] === v),
      neq: (k: string, v: unknown) => chain((r) => r[k] !== v),
      in: (k: string, v: unknown[]) => chain((r) => v.includes(r[k])),
      is: (k: string, v: unknown) => chain((r) => r[k] === v || (v === null && r[k] == null)),
      lt: (k: string, v: string) => chain((r) => String(r[k]) < v),
      gt: (k: string, v: string) => chain((r) => r[k] != null && String(r[k]) > v),
      // PostgREST `or`, the subset the trade block uses: comma-separated `col.ilike.%x%` / `col.eq.v`
      or: (expr: string) => {
        const parts = expr.split(",").map((p) => {
          const [col, operator, ...rest] = p.split(".")
          const v = rest.join(".")
          if (operator === "ilike") return (r: Row) => String(r[col] ?? "").toLowerCase().includes(v.replace(/%/g, "").toLowerCase())
          if (operator === "eq") return (r: Row) => String(r[col]) === v
          throw new Error(`memory db: or.${operator} unsupported`)
        })
        return chain((r) => parts.some((f) => f(r)))
      },
      not: (k: string, operator: string, v: string | null) => {
        if (operator === "is") return chain((r) => (v === null || v === "null" ? r[k] != null : r[k] !== v))
        if (operator !== "in") throw new Error(`memory db: not.${operator} unsupported`)
        const list = String(v).replace(/^\(|\)$/g, "").split(",").map((s) => s.trim().replace(/^"|"$/g, ""))
        return chain((r) => !list.includes(String(r[k])))
      },
      filter: (k: string, operator: string, v: string) => {
        if (operator !== "imatch") throw new Error(`memory db: filter.${operator} unsupported`)
        const rx = new RegExp(v, "i")
        return chain((r) => rx.test(String(r[k] ?? "")))
      },
      ilike: (k: string, pattern: string) => {
        const needle = pattern.replace(/%/g, "").toLowerCase()
        return chain((r) => String(r[k] ?? "").toLowerCase().includes(needle))
      },
      order: (col: string, o?: { ascending?: boolean; nullsFirst?: boolean }) => {
        orderBy.push({ col, asc: o?.ascending !== false, nullsFirst: o?.nullsFirst === true })
        return b
      },
      limit: (n: number) => ((lim = n), b),
      range: (from: number, to: number) => ((offset = from), (lim = to - from + 1), b),
      maybeSingle: () => ((single = "maybe"), b),
      single: () => ((single = "one"), b),
      then: (res: (r: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve().then(run).then(res, rej),
    })
    function run(): { data: unknown; error: { message: string; code?: string } | null; count?: number | null } {
      log.push(`${op} ${table}`)
      const fi = failures.findIndex((f) => f.op === op && f.table === table)
      if (fi >= 0) {
        const f = failures.splice(fi, 1)[0]
        return { data: null, error: { message: f.message } }
      }
      const rows = tables[table]
      const match = (r: Row) => filters.every((f) => f(r))
      if (op === "insert" || op === "upsert") {
        const list = (Array.isArray(payload) ? payload : [payload]) as Row[]
        const out: Row[] = []
        for (const p of list) {
          const row: Row = { ...p }
          if (op === "upsert" && upsertOn.length) {
            const existing = rows.find((r) => upsertOn.every((c) => r[c] === row[c]))
            if (existing) {
              Object.assign(existing, row)
              out.push(existing)
              continue
            }
          }
          for (const [k, v] of Object.entries(defaults[table] ?? {})) if (row[k] === undefined) row[k] = v
          if (row.id === undefined) row.id = uuid()
          for (const k of ["created_at", "updated_at", "added_at"]) if (row[k] === undefined) row[k] = new Date().toISOString()
          const v = violates(table, row)
          if (v) return { data: null, error: { message: v, code: "23505" } }
          rows.push(row)
          out.push(row)
        }
        return finish(out)
      }
      if (op === "update") {
        const hit = rows.filter(match)
        for (const r of hit) {
          const next = { ...r, ...(payload as Row) }
          const v = violates(table, next, r)
          if (v) return { data: null, error: { message: v, code: "23505" } }
          Object.assign(r, payload as Row)
        }
        return finish(hit)
      }
      if (op === "delete") {
        const hit = rows.filter(match)
        tables[table] = rows.filter((r) => !match(r))
        return finish(hit)
      }
      let hit = rows.filter(match)
      for (const o of [...orderBy].reverse()) {
        hit = [...hit].sort((x, y) => {
          const a = x[o.col] as string | number | null | undefined
          const c = y[o.col] as string | number | null | undefined
          if (a == null && c == null) return 0
          if (a == null) return o.nullsFirst ? -1 : 1
          if (c == null) return o.nullsFirst ? 1 : -1
          return (a < c ? -1 : a > c ? 1 : 0) * (o.asc ? 1 : -1)
        })
      }
      const total = hit.length
      if (lim != null || offset) hit = hit.slice(offset, lim != null ? offset + lim : undefined)
      const r = finish(hit)
      if (wantCount) r.count = total
      if (head) r.data = null
      return r
    }
    function finish(hit: Row[]): { data: unknown; error: { message: string; code?: string } | null; count?: number | null } {
      const copy = hit.map((r) => ({ ...r }))
      if (single === "one") return copy.length === 1 ? { data: copy[0], error: null } : { data: null, error: { message: `expected one row, got ${copy.length}` } }
      if (single === "maybe") return copy.length <= 1 ? { data: copy[0] ?? null, error: null } : { data: null, error: { message: `expected at most one row, got ${copy.length}` } }
      return { data: copy, error: null }
    }
    return b
  }
  const rpcs: MemoryDb["rpcs"] = {}
  const rpc = (name: string, args: Record<string, unknown>) => {
    log.push(`rpc ${name}`)
    const h = rpcs[name]
    return Promise.resolve(h ? h(args) : { data: null, error: { message: `memory db: rpc ${name} not registered` } })
  }
  return {
    db: { from, rpc } as unknown as SupabaseClient,
    tables,
    rpcs,
    log,
    failNext: (op, table, message = `${op} ${table} failed (planted)`) => failures.push({ op, table, message }),
  }
}
