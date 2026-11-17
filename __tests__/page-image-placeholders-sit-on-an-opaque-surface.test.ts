import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// 2026-10-28: the media boxes on these server pages carry a fixed translucent black (rgba(0,0,0,0.4)) so real art
// sits on a dark frame. A text fallback painted straight onto that frame read under 4.5:1 in light mode (the same
// axe finding as IpfsThumb / EditionsGridPaginated). Each label's own element now carries the theme surface.

// `up` = how many opening tags back the surface-carrying element is (the edition label's box is its grandparent:
// box > "RPC" mark, "No preview").
const SITES: Array<[file: string, label: string, up: number]> = [
  ["app/players/[slug]/page.tsx", "No portrait", 1],
  ["app/(collections)/[collection]/player/[slug]/page.tsx", "No {labels.portrait.toLowerCase()}", 1],
  ["app/(collections)/[collection]/edition/[slug]/page.tsx", "No preview</div>", 3],
  ["app/(collections)/[collection]/pack/dist/[distId]/page.tsx", ">No image<", 1],
]

/** The first opening tag of the element `up` opening tags before `label`, i.e. its style object. */
function ownerStyle(src: string, label: string, up: number): string {
  const at = src.indexOf(label)
  if (at < 0) throw new Error(`label not found: ${label}`)
  let open = at
  for (let i = 0; i < up; i++) {
    const before = src.slice(0, open)
    open = Math.max(before.lastIndexOf("<div style"), before.lastIndexOf("<span style"))
    if (open < 0) throw new Error(`no owner for ${label}`)
  }
  return src.slice(open, src.indexOf("}}>", open))
}

describe("page image placeholders sit on an opaque theme surface", () => {
  it.each(SITES)("%s — %s", (file, label, up) => {
    const style = ownerStyle(readFileSync(join(process.cwd(), file), "utf8"), label, up)
    expect(style).toMatch(/var\(--rpc-surface\)"/)
    expect(style).not.toMatch(/rgba\(255,\s?255,\s?255/)
  })
})
