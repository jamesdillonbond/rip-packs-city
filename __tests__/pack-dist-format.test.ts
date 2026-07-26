import { describe, it, expect } from "vitest"
import {
  splitEditionName,
  num,
  fmtUsd,
  fmtUsdEv,
  packOddsLabel,
  relTimeShort,
  fmtAgo,
  fmtSalePrice,
} from "@/lib/pack-dist-format"

describe("splitEditionName", () => {
  it("splits 'Player — Set' on the em-dash", () => {
    expect(splitEditionName("LeBron James — Base Set")).toEqual({ player: "LeBron James", setName: "Base Set" })
  })
  it("no dash → whole string is the player, empty set", () => {
    expect(splitEditionName("Team Moment")).toEqual({ player: "Team Moment", setName: "" })
  })
  it("null → Unknown; leading dash → Unknown player", () => {
    expect(splitEditionName(null)).toEqual({ player: "Unknown", setName: "" })
    expect(splitEditionName("— Base Set")).toEqual({ player: "Unknown", setName: "Base Set" })
  })
})

describe("num", () => {
  it("coerces strings + numbers to finite numbers", () => {
    expect(num("42.5")).toBe(42.5)
    expect(num(7)).toBe(7)
  })
  it("null/undefined/NaN → null", () => {
    expect(num(null)).toBeNull()
    expect(num(undefined)).toBeNull()
    expect(num("abc")).toBeNull()
  })
})

describe("fmtUsd", () => {
  it("whole dollars at |v|>=100, 2dp below", () => {
    expect(fmtUsd(1234.5)).toBe("$1,235")
    expect(fmtUsd(4.5)).toBe("$4.50")
    expect(fmtUsd(-250)).toBe("$-250")
  })
  it("null/NaN → em dash", () => {
    expect(fmtUsd(null)).toBe("—")
    expect(fmtUsd(NaN)).toBe("—")
  })
})

describe("fmtUsdEv — the <$0.01 tiny-positive rule (Pack G)", () => {
  it("shows <$0.01 for a tiny but positive EV instead of $0.00", () => {
    expect(fmtUsdEv(0.0005)).toBe("<$0.01")
    expect(fmtUsdEv(0.004)).toBe("<$0.01")
  })
  it("0.005 and up format normally; 0 / negative / null fall through", () => {
    expect(fmtUsdEv(0.005)).toBe("$0.01")
    expect(fmtUsdEv(0)).toBe("$0.00")
    expect(fmtUsdEv(-1)).toBe("$-1.00")
    expect(fmtUsdEv(null)).toBe("—")
  })
})

describe("packOddsLabel — pull-odds (the Pack 1a divisor bug guard)", () => {
  it("~1 in N from 1-(1-p)^slots over the POOL, not packs-remaining", () => {
    // p = 10/1000 = 0.01, slots 5 → atLeastOne ≈ 0.049 → ~1 in 20
    expect(packOddsLabel(10, 1000, 5)).toBe("~1 in 20")
  })
  it("depleted when remaining <= 0", () => {
    expect(packOddsLabel(0, 1000, 5)).toBe("depleted")
  })
  it("em dash when pool/slots missing or non-positive", () => {
    expect(packOddsLabel(10, null, 5)).toBe("—")
    expect(packOddsLabel(10, 1000, 0)).toBe("—")
    expect(packOddsLabel(10, 0, 5)).toBe("—")
  })
  it("~every pack when near-certain", () => {
    expect(packOddsLabel(999, 1000, 5)).toBe("~every pack")
  })
})

describe("relTimeShort (now injected)", () => {
  const now = Date.parse("2026-07-26T12:00:00Z")
  const ago = (ms: number) => new Date(now - ms).toISOString()
  it("just now / m / h / d buckets", () => {
    expect(relTimeShort(ago(20_000), now)).toBe("just now") // <30s rounds to 0 min
    expect(relTimeShort(ago(5 * 60_000), now)).toBe("5m ago")
    expect(relTimeShort(ago(3 * 3_600_000), now)).toBe("3h ago")
    expect(relTimeShort(ago(2 * 86_400_000), now)).toBe("2d ago")
  })
  it("null / unparseable → empty string", () => {
    expect(relTimeShort(null, now)).toBe("")
    expect(relTimeShort("nope", now)).toBe("")
  })
})

describe("fmtAgo (now injected)", () => {
  const now = Date.parse("2026-07-26T12:00:00Z")
  const daysAgo = (d: number) => new Date(now - d * 86400000).toISOString()
  it("today / yesterday / Nd / Nmo / Ny", () => {
    expect(fmtAgo(daysAgo(0), now)).toBe("today")
    expect(fmtAgo(daysAgo(1), now)).toBe("yesterday")
    expect(fmtAgo(daysAgo(5), now)).toBe("5d ago")
    expect(fmtAgo(daysAgo(60), now)).toBe("2mo ago")
    expect(fmtAgo(daysAgo(400), now)).toBe("1y ago")
  })
  it("null / unparseable → null", () => {
    expect(fmtAgo(null, now)).toBeNull()
    expect(fmtAgo("nope", now)).toBeNull()
  })
})

describe("fmtSalePrice", () => {
  it("whole dollars at >=$1000, 2dp below", () => {
    expect(fmtSalePrice(1500)).toBe("$1,500")
    expect(fmtSalePrice(42.5)).toBe("$42.50")
    expect(fmtSalePrice(0.25)).toBe("$0.25")
  })
  it("null/NaN → em dash", () => {
    expect(fmtSalePrice(null)).toBe("—")
    expect(fmtSalePrice("x")).toBe("—")
  })
})
