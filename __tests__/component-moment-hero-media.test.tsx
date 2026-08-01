// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup, fireEvent } from "@testing-library/react"
import MomentHeroMedia from "@/components/MomentHeroMedia"

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
})
