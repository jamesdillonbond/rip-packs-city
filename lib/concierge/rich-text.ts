// lib/concierge/rich-text.ts
//
// Turns a concierge message into typed tokens the chat bubble can render as
// React elements. It exists because the bubble rendered `{msg.text}` as a raw
// string, so every link the bot handed out arrived as inert text the user had
// to select and retype — and the /insights boards the system prompt is told to
// "hand out freely" are the most shareable thing RPC has.
//
// ⚠ THIS DELIBERATELY PRODUCES TOKENS, NOT HTML. There is no
// dangerouslySetInnerHTML anywhere in this path and there must never be one.
// Concierge output is model-generated text that quotes tool results, and tool
// results carry values RPC does not control (collector handles, set names,
// board rows). Rendering that as markup would make a stored value in the
// catalog an injection vector into every chat that mentions it. Tokens are
// escaped by React on render, so the worst a hostile string can do is look odd.
//
// The link allow-list is the other half of that: `safeHref` accepts only http,
// https, and site-relative paths. A `javascript:` or `data:` URL — which a
// model can absolutely be talked into emitting — is dropped to plain text
// rather than becoming a clickable anchor.

/** A single renderable run of a concierge message. */
export type RichToken =
  | { type: "text"; text: string }
  | { type: "bold"; text: string }
  | { type: "link"; text: string; href: string };

/**
 * Validate a URL for use as an anchor href.
 *
 * @returns the href to use, or null when the target is not a scheme we allow.
 *
 * Accepts absolute http(s) and site-relative paths ("/insights/deals"). Rejects
 * every other scheme, and rejects protocol-relative "//host" URLs — those look
 * site-relative but navigate off-site.
 */
export function safeHref(raw: string): string | null {
  const url = raw.trim();
  if (!url) return null;

  if (url.startsWith("//")) return null; // protocol-relative → off-site
  if (url.startsWith("/")) return url;

  // Scheme check is done on the literal prefix rather than by parsing, because
  // a parser's leniency (whitespace, control characters, casing) is exactly
  // what scheme-filter bypasses exploit. Anything not plainly http(s) is out.
  const lower = url.toLowerCase();
  if (lower.startsWith("http://") || lower.startsWith("https://")) {
    // Reject embedded control characters/newlines, which can split a header or
    // smuggle a second scheme past a naive prefix check.
    //
    // ⚠ ESCAPES, NOT RAW BYTES. This class held LITERAL 0x00, 0x1f and 0x7f
    // bytes in the source until 2026-08-18. It behaved identically (verified
    // over 0x0000-0x2000: zero differences) but it was fragile in the one
    // direction that matters here: anything that normalises away a raw NUL --
    // an editor, a mount round-trip, a copy-paste -- turns the range start
    // into a literal '-' and the filter SILENTLY STOPS catching 0x00-0x1e,
    // with no syntax error and no test failure. A security check must not
    // depend on bytes that are invisible in every diff and code review.
    if (/[\u0000-\u001f\u007f]/.test(url)) return null;
    return url;
  }
  return null;
}

// [label](target) — label may not span lines; target may not contain spaces.
const MD_LINK = /\[([^\]\n]+)\]\(([^)\s]+)\)/;
// A bare absolute URL.
const BARE_URL = /https?:\/\/[^\s<>()[\]]+/i;
// A site-relative path. The first segment must begin with a letter and the
// slash must follow whitespace, a line start, or an opening bracket — without
// that guard "and/or" and "8/13" both read as paths.
//
// ⚠ The leading context is a CAPTURE GROUP, not a lookbehind. Lookbehind is
// ES2018 and throws a SyntaxError at PARSE time on Safari < 16.4 — which would
// take out this whole module, and with it the entire chat component, on an
// older iPhone. `tsc` cannot transpile a regex literal, so the pattern ships to
// the browser exactly as written. Callers must offset by group 1's length.
const SITE_PATH = /(^|[\s(])(\/[a-z][a-z0-9-]*(?:\/[a-z0-9][a-z0-9%:-]*)*)/i;
// **bold**
const BOLD = /\*\*([^*\n]+)\*\*/;

// Trailing punctuation that is far more likely to be sentence punctuation than
// part of the URL. Balanced closing parens are handled by BARE_URL excluding
// them outright, which is the common markdown-adjacent case.
const TRAILING_PUNCT = /[.,;:!?'"]+$/;

/**
 * Tokenize a concierge message.
 *
 * Recognises markdown links, bare URLs, site-relative paths, and bold runs.
 * Everything else passes through as text — including bullet lines and newlines,
 * which the bubble already renders correctly via `white-space: pre-wrap`.
 *
 * Unrecognised or unsafe link targets degrade to text rather than being
 * dropped, so a message never silently loses content.
 */
export function parseRichText(input: string): RichToken[] {
  if (!input) return [];
  const tokens: RichToken[] = [];
  let rest = input;
  let guard = 0;

  while (rest && guard++ < 5000) {
    const md = MD_LINK.exec(rest);
    const bare = BARE_URL.exec(rest);
    const path = SITE_PATH.exec(rest);
    const bold = BOLD.exec(rest);

    // Take whichever pattern starts earliest; ties resolve in the order below,
    // so "[text](/a)" is read as a markdown link rather than as a bare path.
    // Normalised to (start, text) so the site-path pattern's leading-context
    // capture group is accounted for rather than shifting every offset by one.
    type Candidate = { start: number; text: string; kind: "md" | "bare" | "path" | "bold"; m: RegExpExecArray };
    const candidates: Candidate[] = [];
    if (md) candidates.push({ start: md.index, text: md[0], kind: "md", m: md });
    if (bare) candidates.push({ start: bare.index, text: bare[0], kind: "bare", m: bare });
    // group 1 is the whitespace/paren before the path; group 2 is the path.
    if (path) candidates.push({ start: path.index + path[1].length, text: path[2], kind: "path", m: path });
    if (bold) candidates.push({ start: bold.index, text: bold[0], kind: "bold", m: bold });

    if (candidates.length === 0) {
      tokens.push({ type: "text", text: rest });
      break;
    }

    candidates.sort((a, b) => a.start - b.start);
    const { start, text: matched, kind, m } = candidates[0];

    if (start > 0) tokens.push({ type: "text", text: rest.slice(0, start) });

    if (kind === "bold") {
      tokens.push({ type: "bold", text: m[1] });
      rest = rest.slice(start + matched.length);
      continue;
    }

    if (kind === "md") {
      const href = safeHref(m[2]);
      // An unsafe target keeps the user's information but not the click.
      if (href) tokens.push({ type: "link", text: m[1], href });
      else tokens.push({ type: "text", text: matched });
      rest = rest.slice(start + matched.length);
      continue;
    }

    // bare URL or site path — strip sentence punctuation off the tail so it
    // stays in the prose instead of breaking the link.
    let raw = matched;
    const trailing = TRAILING_PUNCT.exec(raw);
    let tail = "";
    if (trailing) {
      tail = trailing[0];
      raw = raw.slice(0, raw.length - tail.length);
    }
    const href = safeHref(raw);
    if (href) tokens.push({ type: "link", text: raw, href });
    else tokens.push({ type: "text", text: raw });
    if (tail) tokens.push({ type: "text", text: tail });
    rest = rest.slice(start + matched.length);
  }

  // Merge adjacent text runs so the rendered output has no needless spans.
  const merged: RichToken[] = [];
  for (const t of tokens) {
    const prev = merged[merged.length - 1];
    if (t.type === "text" && prev?.type === "text") prev.text += t.text;
    else merged.push(t);
  }
  return merged.filter((t) => !(t.type === "text" && t.text === ""));
}

/** True when the href leaves the RPC site and so needs target/rel handling. */
export function isExternalHref(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

const SITE_HOSTS = new Set(["rippackscity.com", "www.rippackscity.com", "rip-packs-city.vercel.app"]);

/**
 * True when the href resolves to a host that is NOT this site — the case the
 * bubble marks visibly (2026-10-03). An absolute rippackscity.com link opens
 * in a new tab like any absolute URL but is not "off-site". Anything that
 * fails to parse is treated as off-site, never as ours.
 */
export function isOffSiteHref(href: string): boolean {
  if (!isExternalHref(href)) return false;
  try {
    return !SITE_HOSTS.has(new URL(href).host.toLowerCase());
  } catch {
    return true;
  }
}
