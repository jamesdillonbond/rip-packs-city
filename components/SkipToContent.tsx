// components/SkipToContent.tsx
//
// Skip-to-content link (platform review 2026-10-11, C10). Mounted ONCE, as the
// first child of <body> in app/layout.tsx, so it is the first thing a keyboard
// or screen-reader user reaches on every page — before the mobile bar, the
// sticky header and the collection tabs, which otherwise cost ~15 Tab presses
// per page to get past.
//
// Visually hidden until focused: the base rule moves it off the top of the
// viewport with a transform (it stays in the accessibility tree — `display:none`
// or `visibility:hidden` would remove it); `:focus` brings it back at the top
// left. Tokens only — no brand hex — so it renders correctly in both themes.
//
// The target is NOT a page's <main>: 112 `<main>` elements across 93 files, none
// with an id, and some pages render none at all. The target is MainContentAnchor,
// a zero-height focusable div the root layout renders immediately before
// `{children}`. Activating the link focuses the anchor (tabIndex -1), so the
// next Tab lands on the first control of the page's own content — no layout
// change on any page. Its focus ring is suppressed: a 0 px-tall element's
// outline would paint a stray line across the top of the page.
export const MAIN_CONTENT_ID = "main-content"
export const SKIP_LINK_CLASS = "rpc-skip-link"

export const SKIP_LINK_CSS =
  `.${SKIP_LINK_CLASS}{position:absolute;top:0;left:0;z-index:1000;padding:10px 16px;` +
  `transform:translateY(-200%);background:var(--rpc-bg-elev);color:var(--rpc-text-primary);` +
  `border:2px solid var(--rpc-red);border-top:0;border-radius:0 0 var(--radius-sm) 0;` +
  `font-family:var(--font-display);font-weight:700;font-size:14px;letter-spacing:.08em;` +
  `text-transform:uppercase;text-decoration:none}` +
  `.${SKIP_LINK_CLASS}:focus{transform:none}` +
  `#${MAIN_CONTENT_ID}:focus{outline:none!important}`

export default function SkipToContent() {
  return (
    <>
      {/* Hoisted like the focus-ring rule in app/layout.tsx: lands in the SSR
          HTML, deduped by href, and not subject to the stylesheet cache trap
          (scripts/qa/README.md). */}
      <style href="rpc-skip-link" precedence="default">{SKIP_LINK_CSS}</style>
      <a href={`#${MAIN_CONTENT_ID}`} className={SKIP_LINK_CLASS}>
        Skip to content
      </a>
    </>
  )
}

/** The link's target. Rendered by the root layout immediately before `{children}`. */
export function MainContentAnchor() {
  return <div id={MAIN_CONTENT_ID} tabIndex={-1} />
}
