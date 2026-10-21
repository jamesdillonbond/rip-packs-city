// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup, fireEvent } from "@testing-library/react"
import MomentHeroMedia from "@/components/MomentHeroMedia"
import { heroSrcSet, ENTITY_HERO_SIZES } from "@/lib/hero-srcset"

// The resilient moment hero: an ordered image-candidate fallback (advance on
// each onError, then a "No media" / custom placeholder) plus a video overlay
// that hides itself on error to reveal the image beneath. This is the guard
// against the "~30% blank black hero on legacy Series 1-4 editions" regression,
// so the fallback advancement is the behavior that matters.

afterEach(() => cleanup())

describe("MomentHeroMedia", () => {
  it("renders the first image candidate", () => {
    const { container } = render(
      <MomentHeroMedia imageCandidates={["a.png", "b.png"]} videoUrl={null} alt="hero" />,
    )
    const img = container.querySelector("img")
    expect(img?.getAttribute("src")).toBe("a.png")
  })

  it("advances to the next candidate when the current image errors", () => {
    const { container } = render(
      <MomentHeroMedia imageCandidates={["a.png", "b.png"]} videoUrl={null} alt="hero" />,
    )
    fireEvent.error(container.querySelector("img")!)
    expect(container.querySelector("img")?.getAttribute("src")).toBe("b.png")
  })

  it("falls to the default 'No media' placeholder when every candidate fails", () => {
    const { container, getByText } = render(
      <MomentHeroMedia imageCandidates={["a.png"]} videoUrl={null} alt="hero" />,
    )
    fireEvent.error(container.querySelector("img")!)
    expect(container.querySelector("img")).toBeNull()
    expect(getByText("No media")).toBeTruthy()
  })

  it("renders a custom placeholder when provided and all images fail", () => {
    const { container, getByText } = render(
      <MomentHeroMedia
        imageCandidates={["a.png"]}
        videoUrl={null}
        alt="hero"
        placeholder={<div>RPC / No preview</div>}
      />,
    )
    fireEvent.error(container.querySelector("img")!)
    expect(getByText("RPC / No preview")).toBeTruthy()
  })

  it("overlays a video on the image and hides it on video error (revealing the image)", () => {
    const { container } = render(
      <MomentHeroMedia imageCandidates={["a.png"]} videoUrl="clip.mp4" alt="hero" />,
    )
    expect(container.querySelector("video")?.getAttribute("src")).toBe("clip.mp4")
    // the still image is the always-present base layer beneath the video
    expect(container.querySelector("img")?.getAttribute("src")).toBe("a.png")
    fireEvent.error(container.querySelector("video")!)
    expect(container.querySelector("video")).toBeNull()
    expect(container.querySelector("img")?.getAttribute("src")).toBe("a.png")
  })

  it("filters falsy candidates and can render video-only", () => {
    const { container } = render(
      <MomentHeroMedia imageCandidates={["", ""]} videoUrl="clip.mp4" alt="hero" />,
    )
    expect(container.querySelector("img")).toBeNull()
    expect(container.querySelector("video")?.getAttribute("src")).toBe("clip.mp4")
  })

  it("shows the placeholder when there is neither an image nor a video", () => {
    const { getByText } = render(
      <MomentHeroMedia imageCandidates={[]} videoUrl={null} alt="hero" />,
    )
    expect(getByText("No media")).toBeTruthy()
  })

  // 2026-10-21 (Lighthouse mobile, edition LCP 5.4 s): the hero fetched one fixed
  // 960/1080 px image for a 320 px box. Real URL shapes from production.
  const IPFS = "/api/public/ipfs-thumb/bafybeicbsvc3jdqlxptud6tara7kbfpl3aam7qfehxgpado2w4fk7fzx6q?w=960"
  const TS = "https://assets.nbatopshot.com/media/41528247/image?width=1080"

  it("with sizes, a resizable hero carries a srcset; the next candidate gets its own", () => {
    const { container } = render(
      <MomentHeroMedia imageCandidates={[TS, IPFS]} videoUrl={null} alt="hero" sizes={ENTITY_HERO_SIZES} />,
    )
    const img = () => container.querySelector("img")!
    expect(img().getAttribute("srcset")).toBe(
      "https://assets.nbatopshot.com/media/41528247/image?width=320 320w, https://assets.nbatopshot.com/media/41528247/image?width=640 640w, https://assets.nbatopshot.com/media/41528247/image?width=1080 1080w",
    )
    expect(img().getAttribute("sizes")).toBe("320px")
    fireEvent.error(img())
    expect(img().getAttribute("srcset")).toContain("ipfs-thumb/bafybeicbsvc3jdqlxptud6tara7kbfpl3aam7qfehxgpado2w4fk7fzx6q?w=640 640w")
    expect(img().getAttribute("src")).toBe(IPFS)
  })

  it("MIRROR: no sizes → no srcset (the moment page is unchanged); an unknown URL → no srcset", () => {
    const a = render(<MomentHeroMedia imageCandidates={[IPFS]} videoUrl={null} alt="hero" />)
    expect(a.container.querySelector("img")?.hasAttribute("srcset")).toBe(false)
    cleanup()
    const b = render(<MomentHeroMedia imageCandidates={["https://cdn.example/x.png"]} videoUrl={null} alt="hero" sizes="320px" />)
    expect(b.container.querySelector("img")?.hasAttribute("srcset")).toBe(false)
    expect(b.container.querySelector("img")?.hasAttribute("sizes")).toBe(false)
    expect(heroSrcSet("/api/public/ipfs-thumb/abc?w=960&x=1")).toBeNull()
  })

  it("with a srcset the video poster never names the fixed-width src (no second download)", () => {
    const { container } = render(
      <MomentHeroMedia imageCandidates={[TS]} videoUrl="https://ipfs.example/clip.mp4" alt="hero" sizes={ENTITY_HERO_SIZES} />,
    )
    const video = container.querySelector("video")!
    expect(video.hasAttribute("poster")).toBe(false)
    const img = container.querySelector("img")!
    Object.defineProperty(img, "currentSrc", { value: "https://assets.nbatopshot.com/media/41528247/image?width=640" })
    fireEvent.load(img)
    expect(container.querySelector("video")!.getAttribute("poster")).toBe("https://assets.nbatopshot.com/media/41528247/image?width=640")
  })

  it("MIRROR: without sizes the poster is the image src, as before", () => {
    const { container } = render(<MomentHeroMedia imageCandidates={[TS]} videoUrl="https://ipfs.example/clip.mp4" alt="hero" />)
    expect(container.querySelector("video")!.getAttribute("poster")).toBe(TS)
  })
})
