# 20 guards share a copy-pasted `stripComments` that hides 109,123 characters of real source — a `//` comment containing `/*` swallows every line until the next `*/`

**Filed 2026-08-22 ~21:05Z (14:05 PT), Claude Code interactive.** Found while building the D12b guard, when a correct-looking check returned **0 offenders on a file that demonstrably contains the defect**.

## The mechanism

35 test/script files define their own `stripComments`. 20 of them use this exact copy-pasted shape:

```ts
function stripComments(src: string): string {
  const blanks = (s: string) => s.replace(/[^\n]/g, " ")
  return src
    .replace(/\/\*[\s\S]*?\*\//g, blanks)                                    // <-- block comments FIRST
    .replace(/(^|[^:])\/\/.*$/gm, (m, p1) => p1 + " ".repeat(m.length - p1.length))
}
```

Block comments are stripped **before** line comments. So a perfectly ordinary line comment that mentions a glob path:

```ts
// short form used by /api/* endpoints. Distinct from SLUG_TO_DB_SLUG (long form
```

opens a block comment that the regex closes at **the next `*/` anywhere in the file** — hundreds of lines later. Everything in between is blanked and becomes invisible to the guard.

## Measured blast radius

Walked `app`, `components`, `lib`, `workers`, `supabase`, `scripts` (1,315 `.ts`/`.tsx` files) and diffed the shared strip against a correct state-machine stripper:

- **55 files** where the shared strip blanks source the correct stripper keeps
- **109,123 characters** of real source hidden
- Worst offenders: `app/api/support-chat/route.ts` (**40,439 chars**), `app/(collections)/[collection]/analytics/CollectionAnalyticsClient.tsx` (**19,649**), `app/admin/flowty-errors/ErrorTriageClient.tsx` (7,678), `app/api/profile/trophy-case/pdf/route.tsx` (4,896), `app/special-serial-owners/SpecialSerialOwnersClient.tsx` (4,716), `lib/challenges/topshot-ingest.ts` (4,015), **`lib/seo.ts` (3,707)**, `components/packs/PackTable.tsx` (3,026)

⚠ **This is not hypothetical and it hid a live P0.** `CollectionAnalyticsClient.tsx` is the D12b surface. A guard using the shared strip sees **zero** occurrences of `topshot_orderbook` in it, because the file's own `// … /api/* …` comment blanks the region containing `const orderbook = data?.topshot_orderbook`. Any honesty ratchet walking `app/` has been blind to ~19.6k chars of that file — including the branch that was publishing a 99-day-old row as market depth.

⚠ **`lib/seo.ts` is in the hidden set**, and it is the module behind both R10 (OG inheritance) and R31 (title templates). Treat any past guard result over that file as unproven.

## Why this is the documented class, not a typo

CLAUDE.md: *"Ask what a passing guard is structurally SILENT about — every guard's own derivation fixes its blast radius."* Here the silence is not in the ROOTS or the file filter, which all look correct; it is one layer below, in the **normaliser every guard runs before it looks**. A reviewer checking the roots would find nothing wrong.

It is also the copy-paste spread pattern: **35 local definitions, no shared helper.** Fixing one fixes one.

## Recommended fix, and the trap in it

1. Add **one** shared `__tests__/helpers/strip-comments.ts` implementing a state-machine stripper (tracks line/block/`'`/`"`/backtick state). A correct implementation with a positive control already exists in `__tests__/retired-orderbook-source-not-rendered-ratchet.test.ts` — lift it from there rather than writing a third variant.
2. Migrate the 20 buggy definitions to it.

⚠ **THE TRAP: several of these guards are RATCHETS with a frozen BUDGET number, and fixing the stripper will reveal previously-hidden violations.** Expect reds. Those reds are **real findings, not regressions** — do not raise the budget to make them green without triaging each one. Migrate **one guard per commit** so each population change is attributable, and re-measure each budget against the corrected stripper before touching it.

⚠ **Take a positive control on the new stripper first**, per cheap-check (10): assert it keeps `data?.topshot_orderbook` in a sample whose preceding line comment mentions `/api/*`. Without that assertion the migration can silently swap one blind stripper for another.

## Refuted if

A guard's ROOTS exclude every one of the 55 files, in which case that particular guard is unaffected. **This has not been checked per guard** — the 109k figure is the union across the walked roots, not a per-guard impact. **Each of the 20 needs its own before/after count.**
