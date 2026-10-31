// lib/entity/checklist-entity.ts
//
// The checklist's SUBJECT (beta feedback 11691, webz_80, 2026-10-27, shipped
// 2026-10-30): the same grid, header and "Full editions" view serve a TEAM
// (the original) and a PLAYER. One set of routes carries both, keyed on
// `entity=` — the subject picks the RPC pair and the slug argument name:
//
//   team   → get_team_checklist   / get_team_checklist_progress   (p_team_slug)
//   player → get_player_checklist / get_player_checklist_progress (p_player_slug;
//            migration 20261031044056 — the person predicate get_player_editions
//            uses, so a namesake's editions never count)
//
// PURE — no imports — the client component reads it too.

export const CHECKLIST_ENTITIES = ["team", "player"] as const
export type ChecklistEntity = (typeof CHECKLIST_ENTITIES)[number]

export function isChecklistEntity(v: string | null | undefined): v is ChecklistEntity {
  return v === "team" || v === "player"
}

/** An absent param is the team checklist (every pre-10-30 caller); an unknown one is null, for the route to 400. */
export function parseChecklistEntity(v: string | null | undefined): ChecklistEntity | null {
  if (v == null || v === "") return "team"
  return isChecklistEntity(v) ? v : null
}

export function checklistRpcs(entity: ChecklistEntity): { rows: string; progress: string; slugArg: string } {
  return entity === "player"
    ? { rows: "get_player_checklist", progress: "get_player_checklist_progress", slugArg: "p_player_slug" }
    : { rows: "get_team_checklist", progress: "get_team_checklist_progress", slugArg: "p_team_slug" }
}
