import { describe, it, expect } from "vitest"
import {
  classifyGolazos,
  GOLAZOS_BADGE_RULES,
  GOLAZOS_BADGE_COLORS,
} from "@/lib/golazos-badges"

// LaLiga Golazos set-name → badge classifier. Locks: case-insensitive substring
// match on set_name, empty/null → [], results sorted by descending priority,
// and that every rule title has a matching color entry.

describe("classifyGolazos", () => {
  it("returns [] for empty or null set names", () => {
    expect(classifyGolazos("")).toEqual([])
    // @ts-expect-error runtime guards against null even though typed string
    expect(classifyGolazos(null)).toEqual([])
    expect(classifyGolazos("some unrelated set")).toEqual([])
  })

  it("matches case-insensitively on a substring", () => {
    expect(classifyGolazos("EL CLASICO Showdown")).toEqual(["El Clásico"])
    expect(classifyGolazos("The Estrellas set")).toEqual(["Estrellas"])
  })

  it("matches accented and unaccented Clásico variants", () => {
    expect(classifyGolazos("elclásico night")).toEqual(["El Clásico"])
    expect(classifyGolazos("elclasico night")).toEqual(["El Clásico"])
  })

  it("orders multiple matches by descending priority", () => {
    // 'El Clásico' (10) contains 'el clasico'; combine with 'Estrellas' (8)
    const res = classifyGolazos("el clasico estrellas")
    expect(res).toEqual(["El Clásico", "Estrellas"])
  })

  it("Team Europa matches its Spanish alias", () => {
    expect(classifyGolazos("equipo del mundo")).toEqual(["Team Europa"])
  })
})

describe("GOLAZOS_BADGE_COLORS", () => {
  it("has a color class for every rule title", () => {
    for (const rule of GOLAZOS_BADGE_RULES) {
      expect(GOLAZOS_BADGE_COLORS[rule.badgeTitle]).toBeTruthy()
    }
  })
})
