// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup, fireEvent } from "@testing-library/react"
import ThumbnailPreview from "@/components/collection/ThumbnailPreview"

// ThumbnailPreview wraps a table cell with a hover-to-enlarge preview. The
// logic that matters: it only shows a preview when there IS a thumbnail
// (previewUrl is null for a missing image — the blank-image guard) and it
// upsizes the source to width=400. Children always render.

afterEach(() => cleanup())

describe("ThumbnailPreview", () => {
  it("always renders its children", () => {
    const { getByText } = render(
      <ThumbnailPreview thumbUrl="https://img/x?width=100" playerName="Ja Morant" tierColor="#f00">
        <span>CELL</span>
      </ThumbnailPreview>
    )
    expect(getByText("CELL")).toBeTruthy()
  })

  it("on hover with a thumbnail, shows the preview upsized to width=400", () => {
    const { container, getByAltText } = render(
      <ThumbnailPreview thumbUrl="https://img/x?width=100&q=1" playerName="Ja Morant" tierColor="#0f0">
        <span>CELL</span>
      </ThumbnailPreview>
    )
    const wrapper = container.firstElementChild as HTMLElement
    fireEvent.mouseEnter(wrapper)
    const img = getByAltText("Ja Morant") as HTMLImageElement
    expect(img.getAttribute("src")).toBe("https://img/x?width=400&q=1")
  })

  it("does NOT show a preview when the thumbnail is null (blank-image guard)", () => {
    const { container, queryByAltText } = render(
      <ThumbnailPreview thumbUrl={null} playerName="No Art" tierColor="#00f">
        <span>CELL</span>
      </ThumbnailPreview>
    )
    fireEvent.mouseEnter(container.firstElementChild as HTMLElement)
    expect(queryByAltText("No Art")).toBeNull()
  })

  it("hides the preview again on mouse leave", () => {
    const { container, queryByAltText } = render(
      <ThumbnailPreview thumbUrl="https://img/x?width=100" playerName="Ja Morant" tierColor="#0f0">
        <span>CELL</span>
      </ThumbnailPreview>
    )
    const wrapper = container.firstElementChild as HTMLElement
    fireEvent.mouseEnter(wrapper)
    expect(queryByAltText("Ja Morant")).not.toBeNull()
    fireEvent.mouseLeave(wrapper)
    expect(queryByAltText("Ja Morant")).toBeNull()
  })
})
