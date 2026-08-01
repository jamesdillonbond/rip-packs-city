import { describe, it, expect } from "vitest"
import { csvToArr, arrToCsv, toggle, alertPayloadFromForm, type AlertFormState } from "@/lib/alerts/form"

describe("alerts/form — csvToArr / arrToCsv", () => {
  it("csvToArr splits, trims, and drops empties", () => {
    expect(csvToArr("LeBron, Curry ,, Durant")).toEqual(["LeBron", "Curry", "Durant"])
    expect(csvToArr("")).toEqual([])
  })
  it("arrToCsv joins with ', ' and treats null as empty", () => {
    expect(arrToCsv(["a", "b"])).toBe("a, b")
    expect(arrToCsv(null)).toBe("")
  })
})

describe("alerts/form — toggle", () => {
  it("adds an absent value and removes a present one", () => {
    expect(toggle(["a", "b"], "c")).toEqual(["a", "b", "c"])
    expect(toggle(["a", "b"], "a")).toEqual(["b"])
  })
})

describe("alerts/form — alertPayloadFromForm", () => {
  const base: AlertFormState = {
    id: null,
    label: "My deal alert",
    channels: ["email"],
    collection_ids: [],
    min_discount: "",
    min_price: "",
    max_price: "",
    tiers: [],
    parallel_names: [],
    player_names: "",
    set_names: "",
    team_names: "",
    min_serial: "",
    max_serial: "",
    require_jersey_serial: false,
    require_last_mint: false,
    require_never_sold: false,
    require_low_ask: false,
    badges: [],
    cadence: "instant",
  }

  it("applies the empty-input defaults: min_discount→25, prices/serials→null, empty arrays→null", () => {
    const p = alertPayloadFromForm(base)
    expect(p.id).toBeUndefined()
    expect(p.min_discount).toBe(25)
    expect(p.min_price).toBeNull()
    expect(p.max_price).toBeNull()
    expect(p.min_serial).toBeNull()
    expect(p.max_serial).toBeNull()
    expect(p.collection_ids).toBeNull()
    expect(p.tiers).toBeNull()
    expect(p.parallel_names).toBeNull()
    expect(p.badges).toBeNull()
    // CSV text fields always become arrays (empty → []).
    expect(p.player_names).toEqual([])
  })

  it("coerces populated numeric inputs and passes through arrays/csv/booleans", () => {
    const p = alertPayloadFromForm({
      ...base,
      id: "sub-1",
      collection_ids: ["ts"],
      min_discount: "40",
      min_price: "5",
      max_price: "500",
      tiers: ["RARE"],
      parallel_names: ["Hexwave"],
      player_names: "Curry, LeBron",
      set_names: "Base Set",
      team_names: "",
      min_serial: "1",
      max_serial: "10",
      require_jersey_serial: true,
      require_never_sold: true,
      badges: ["rookie"],
      cadence: "daily",
    })
    expect(p.id).toBe("sub-1")
    expect(p.min_discount).toBe(40)
    expect(p.min_price).toBe(5)
    expect(p.max_price).toBe(500)
    expect(p.min_serial).toBe(1)
    expect(p.max_serial).toBe(10)
    expect(p.collection_ids).toEqual(["ts"])
    expect(p.tiers).toEqual(["RARE"])
    expect(p.parallel_names).toEqual(["Hexwave"])
    expect(p.player_names).toEqual(["Curry", "LeBron"])
    expect(p.set_names).toEqual(["Base Set"])
    expect(p.team_names).toEqual([])
    expect(p.require_jersey_serial).toBe(true)
    expect(p.require_never_sold).toBe(true)
    expect(p.badges).toEqual(["rookie"])
    expect(p.cadence).toBe("daily")
  })
})
