import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// 2026-10-18 (Trevor: "We shouldn't have anything user-facing that shows our
// confidence in the pricing. That should just be for internal use."). Blog
// posts are public copy (and their descriptions reach search results), so they
// must not cite an FMV's internal confidence tier ("HIGH confidence", …).
const BLOG = join(process.cwd(), "app", "blog")
const files: string[] = [join(process.cwd(), "lib", "blog", "posts.ts")]
for (const d of readdirSync(BLOG)) {
  const page = join(BLOG, d, "page.tsx")
  try {
    if (statSync(page).isFile()) files.push(page)
  } catch {
    /* not a post directory */
  }
}

describe("blog copy names no FMV confidence tier", () => {
  it("scans the post pages and the post registry", () => {
    expect(files.length).toBeGreaterThan(2)
  })

  it.each(files)("%s", (f) => {
    const code = stripComments(readFileSync(f, "utf8"))
    expect(code).not.toMatch(/confidence/i)
    expect(code).not.toMatch(/\b(?:HIGH|MEDIUM|LOW|ASK_ONLY)\b/)
  })
})
