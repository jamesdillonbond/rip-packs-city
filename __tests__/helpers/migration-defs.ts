// Newest definition of every function / view / materialized view in
// supabase/migrations, comment-stripped, with whether a later DROP removed it.
// Shared by the tree-walking DB guards so the parser exists once.
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { stripSqlComments } from "../../scripts/lib/strip-sql-comments.mjs"

export const MIG_DIR = "supabase/migrations"

export type MigrationDef = { file: string; kind: string; body: string; dropped: boolean }

const CREATE =
  /\bCREATE\s+(?:OR\s+REPLACE\s+)?(FUNCTION|VIEW|MATERIALIZED\s+VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?([a-z0-9_]+)"?/gi
const DROP = /\bDROP\s+(?:FUNCTION|VIEW|MATERIALIZED\s+VIEW)\s+(?:IF\s+EXISTS\s+)?(?:public\.)?"?([a-z0-9_]+)"?/gi

/** Newest definition per object name; a body runs to the next CREATE of an object (or EOF). */
export function newestDefinitions(files: Array<{ name: string; src: string }>): Map<string, MigrationDef> {
  const defs = new Map<string, MigrationDef>()
  for (const { name, src } of files) {
    const code = stripSqlComments(src)
    const events: Array<{ at: number; kind: "create" | "drop"; obj: string; type: string; end?: number }> = []
    const creates = [...code.matchAll(CREATE)]
    creates.forEach((m, i) => {
      const end = i + 1 < creates.length ? (creates[i + 1].index ?? code.length) : code.length
      events.push({ at: m.index ?? 0, kind: "create", obj: m[2].toLowerCase(), type: m[1].toUpperCase(), end })
    })
    for (const m of code.matchAll(DROP)) events.push({ at: m.index ?? 0, kind: "drop", obj: m[1].toLowerCase(), type: "" })
    events.sort((a, b) => a.at - b.at)
    for (const e of events) {
      if (e.kind === "drop") {
        const d = defs.get(e.obj)
        if (d) d.dropped = true
      } else {
        defs.set(e.obj, { file: name, kind: e.type, body: code.slice(e.at, e.end), dropped: false })
      }
    }
  }
  return defs
}

export function migrationFiles(dir = MIG_DIR) {
  return readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()
    .map((f) => ({ name: f, src: readFileSync(join(dir, f), "utf8") }))
}
