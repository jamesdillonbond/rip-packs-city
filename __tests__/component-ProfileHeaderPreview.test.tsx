// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup, screen, fireEvent } from "@testing-library/react"
import ProfileHeaderPreview, {
  hexToRgba,
  initialsFor,
} from "@/components/profile/ProfileHeaderPreview"
import { BORDER_COSMETICS, BANNER_COSMETICS } from "@/lib/cosmetics"
import { DEFAULT_AVATAR_URL } from "@/lib/profile/default-avatar"

// ─────────────────────────────────────────────────────────────────────────────
// The /profile/edit live preview.
//
// Every personalisation on that page was previously set BLIND: accent colour
// through a bare `<input type="color">`, the avatar as a raw URL field, the
// tagline as a textarea — and the equipped border/banner were not even fetched
// there, because they are equipped from /rewards. The one screen called "edit
// your profile" could not show you your profile.
//
// The assertions that matter are about TRUTHFULNESS, not layout: a preview that
// disagrees with the public page is worse than no preview, because a collector
// would trust it.
// ─────────────────────────────────────────────────────────────────────────────

const base = {
  username: "trevor",
  displayName: "Trevor",
  tagline: "",
  avatarUrl: "",
  accentColor: "#E03A2F",
}

afterEach(cleanup)

// The avatar slot, WHICHEVER branch drew it. Ring colour, ring width and glow
// are identical on the image and the monogram by design, so a test about the
// ring should not also be asserting which of the two rendered — that coupling
// is what made these cases red when blank started previewing the logo.
function avatarSlot(): HTMLElement {
  const el = document.querySelector("[data-preview-avatar]")
  if (!el) throw new Error("no avatar slot rendered")
  return el as HTMLElement
}

describe("ProfileHeaderPreview", () => {
  it("renders the name, tagline and live profile URL", () => {
    render(<ProfileHeaderPreview {...base} tagline="Blazers Team Captain" />)
    const el = screen.getByTestId("profile-header-preview")
    expect(el.textContent).toContain("Trevor")
    expect(el.textContent).toContain("Blazers Team Captain")
    expect(el.textContent).toContain("rippackscity.com/profile/trevor")
  })

  it("prompts for a username when there is none, instead of showing a broken URL", () => {
    render(<ProfileHeaderPreview {...base} username="" displayName="" />)
    const el = screen.getByTestId("profile-header-preview")
    expect(el.textContent).toContain("SET A USERNAME")
    expect(el.textContent).not.toContain("rippackscity.com/profile/")
  })

  it("holds the monogram until the avatar URL is plausibly a URL", () => {
    // Typed a character at a time. Rendering `htt` as an <img> means a broken
    // image icon on nearly every keystroke.
    //
    // ⚠ "" IS DELIBERATELY NOT IN THIS LIST — see the case below. Empty is not
    // a keystroke on the way to a URL, it is the saved state "no avatar", and
    // that now renders the RPC logo.
    for (const partial of ["h", "htt", "https:/", "not-a-url"]) {
      cleanup()
      render(<ProfileHeaderPreview {...base} avatarUrl={partial} />)
      expect(screen.queryByTestId("preview-avatar-image")).toBeNull()
      expect(screen.getByTestId("preview-avatar-initials")).toBeTruthy()
    }
  })

  it("previews the RPC logo — not the monogram — when the field is blank", () => {
    // The whole point of this component is that the edit screen must not show
    // a collector something their visitors do not see. Blank saves as NULL,
    // and NULL renders the logo to visitors, so a monogram here would be the
    // exact lie this file exists to prevent.
    for (const blank of ["", "   "]) {
      cleanup()
      render(<ProfileHeaderPreview {...base} avatarUrl={blank} />)
      const img = screen.getByTestId("preview-avatar-image") as HTMLImageElement
      expect(img.getAttribute("src")).toBe(DEFAULT_AVATAR_URL)
      expect(screen.queryByTestId("preview-avatar-initials")).toBeNull()
    }
  })

  it("switches to the image once the URL is complete", () => {
    render(<ProfileHeaderPreview {...base} avatarUrl="https://example.com/a.png" />)
    expect(screen.getByTestId("preview-avatar-image")).toBeTruthy()
    expect(screen.queryByTestId("preview-avatar-initials")).toBeNull()
  })

  it("shows the equipped banner, and nothing when none is equipped", () => {
    render(<ProfileHeaderPreview {...base} equippedBanner="ripcity" />)
    expect(screen.getByTestId("preview-banner")).toBeTruthy()
    cleanup()
    render(<ProfileHeaderPreview {...base} equippedBanner={null} />)
    expect(screen.queryByTestId("preview-banner")).toBeNull()
  })

  it("draws the border ring from the SHARED cosmetics map", () => {
    // ⚠ The whole point. A preview with its own copy of the style map drifts
    // the moment a SKU is added and confidently shows a collector something
    // their visitors do not see.
    //
    // Compared in jsdom's own colour space — it normalises `#FF6A2C` to
    // `rgb(255, 106, 44)`, so asserting the raw hex reds on correct code. The
    // expected value is still DERIVED from the shared map rather than written
    // out, so changing the map still moves this assertion.
    const rgbOf = (hex: string) => {
      const c = hex.replace("#", "")
      const [r, g, b] = [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16))
      return `rgb(${r}, ${g}, ${b})`
    }
    render(<ProfileHeaderPreview {...base} equippedBorder="flame" />)
    const av = avatarSlot()
    expect(av.style.border).toContain(rgbOf(BORDER_COSMETICS.flame.ring))
  })

  it("prefers the equipped border over the accent colour for the ring", () => {
    // The precedence the public page applies (ProfileClient's Avatar). If the
    // preview showed the accent instead, a collector would tune a colour that
    // their visitors never see because a cosmetic is overriding it.
    const rgbOf = (hex: string) => {
      const c = hex.replace("#", "")
      const [r, g, b] = [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16))
      return `rgb(${r}, ${g}, ${b})`
    }
    render(<ProfileHeaderPreview {...base} accentColor="#34D399" equippedBorder="ice" />)
    const av = avatarSlot()
    expect(av.style.border).toContain(rgbOf(BORDER_COSMETICS.ice.ring))
    expect(av.style.border).not.toContain(rgbOf("#34D399"))
  })

  it("renders every catalogued cosmetic without throwing", () => {
    // Directory-driven over the real maps, so a new SKU is covered on arrival
    // rather than when someone remembers to add a case.
    for (const sku of Object.keys(BORDER_COSMETICS)) {
      cleanup()
      render(<ProfileHeaderPreview {...base} equippedBorder={sku} />)
      expect(screen.getByTestId("profile-header-preview")).toBeTruthy()
    }
    for (const sku of Object.keys(BANNER_COSMETICS)) {
      cleanup()
      render(<ProfileHeaderPreview {...base} equippedBanner={sku} />)
      expect(screen.getByTestId("preview-banner")).toBeTruthy()
    }
  })

  it("ignores an unknown cosmetic value rather than rendering a phantom", () => {
    render(<ProfileHeaderPreview {...base} equippedBorder="not-a-sku" equippedBanner="nope" />)
    expect(screen.queryByTestId("preview-banner")).toBeNull()
    expect(avatarSlot()).toBeTruthy()
  })

  it("reports a URL that does not load as an image", () => {
    // ⚠ THE ONLY HONEST TEST OF AN AVATAR URL IS LOADING IT. A collector who
    // pasted an OpenSea item page previously saw a broken <img> here and a
    // monogram on their live profile — which is indistinguishable from never
    // having set an avatar, so nothing told them the value was the problem.
    render(<ProfileHeaderPreview {...base} avatarUrl="https://example.com/not-an-image" />)
    expect(screen.queryByTestId("preview-avatar-load-failed")).toBeNull()
    fireEvent.error(screen.getByTestId("preview-avatar-image"))
    expect(screen.getByTestId("preview-avatar-load-failed")).toBeTruthy()
    // …and it says what the VISITOR will see, not just that something failed.
    expect(screen.getByTestId("preview-avatar-load-failed").textContent).toMatch(/initials/i)
    // The monogram takes over, so the preview still matches the public page.
    expect(screen.getByTestId("preview-avatar-initials")).toBeTruthy()
  })

  it("clears the failure when the URL changes, so a fix is visible immediately", () => {
    // Otherwise one bad paste pins the notice for the rest of the session and
    // the collector cannot tell whether their correction worked.
    const { rerender } = render(
      <ProfileHeaderPreview {...base} avatarUrl="https://example.com/broken" />,
    )
    fireEvent.error(screen.getByTestId("preview-avatar-image"))
    expect(screen.getByTestId("preview-avatar-load-failed")).toBeTruthy()
    rerender(<ProfileHeaderPreview {...base} avatarUrl="https://example.com/good.png" />)
    expect(screen.queryByTestId("preview-avatar-load-failed")).toBeNull()
    expect(screen.getByTestId("preview-avatar-image")).toBeTruthy()
  })

  it("falls back to the username when no display name is set", () => {
    render(<ProfileHeaderPreview {...base} displayName="" />)
    expect(screen.getByTestId("profile-header-preview").textContent).toContain("trevor")
  })
})

describe("hexToRgba", () => {
  it("converts a 6-digit hex", () => {
    expect(hexToRgba("#34D399", 0.4)).toBe("rgba(52,211,153,0.4)")
    expect(hexToRgba("34D399", 0.15)).toBe("rgba(52,211,153,0.15)")
  })

  it("falls back to brand red on anything malformed", () => {
    // `accent_color` is a free-form column and the field is a live text/colour
    // input, so a half-typed or hand-edited value reaches this every time.
    for (const bad of ["", "#fff", "#GGGGGG", "nope", "#1234567"]) {
      expect(hexToRgba(bad, 0.4)).toBe("rgba(224,58,47,0.4)")
    }
  })
})

describe("initialsFor", () => {
  it("prefers the display name, falls back to the handle", () => {
    expect(initialsFor("Trevor", "tdb")).toBe("TR")
    expect(initialsFor("", "tdb")).toBe("TD")
  })

  it("never renders an empty monogram", () => {
    expect(initialsFor("", "")).toBe("?")
    expect(initialsFor("   ", "  ")).toBe("?")
  })
})
