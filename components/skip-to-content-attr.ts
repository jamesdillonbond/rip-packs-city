// components/skip-to-content-attr.ts
//
// The page-content anchor's attribute name, shared by the server half
// (SkipToContent.tsx: the CSS rule + <PageContentAnchor />) and the client half
// (SkipToContentLink.tsx: the click handler's selector). It lives in a plain
// module because a value a SERVER component imports from a "use client" module
// is a client-reference stub, not the value: until 2026-10-25 the server
// rendered the anchor's attribute and the CSS selector from that stub (a
// stringified `throw Error(...)` function), so no anchor carried
// data-rpc-content-anchor and the skip link always fell back to #main-content.
// Guard: __tests__/server-never-reads-a-value-from-a-client-module.test.ts

export const PAGE_CONTENT_ANCHOR_ATTR = "data-rpc-content-anchor"
