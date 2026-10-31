// app/(collections)/[collection]/character/[slug]/page.tsx
//
// Disney Pinnacle's character page (2026-10-31): the SAME page as
// /<collection>/player/<slug> under the vocabulary Pinnacle uses. One shared
// implementation (CLAUDE.md: no per-collection page forks); the layout beside this
// file 308s any non-Pinnacle collection back to /player/.

export { default, generateMetadata, generateStaticParams } from "../../player/[slug]/page"
export const revalidate = 600
export const dynamicParams = true
