import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import jsxA11y from "eslint-plugin-jsx-a11y";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Accessibility programme (platform review 2026-10-11, C10). eslint-config-next
  // registers `jsx-a11y` but enables only six of its rules (alt-text, aria-props,
  // aria-proptypes, aria-unsupported-elements, role-has-required-aria-props,
  // role-supports-aria-props). This block turns on the plugin's full
  // `recommended` set for the two trees that render UI. It is RATCHETED, not
  // gated: every rule was baselined at its 2026-10-12 count in
  // eslint-ratchet.json (scripts/check-eslint-ratchet.mjs --write), so each can
  // only go down from here and a new violation reds the commit that adds it.
  // ⚠ NO `plugins` KEY HERE, DELIBERATELY. The `jsx-a11y` namespace is already
  // registered by eslint-config-next above, and flat config refuses a second
  // registration whose object differs — which it does, because next loads the
  // plugin through `_interop_require_wildcard` (a fresh namespace wrapper), so
  // `plugins: { "jsx-a11y": jsxA11y }` dies with `Cannot redefine plugin
  // "jsx-a11y"` (measured 2026-10-12). The import below is used only for the
  // RULE LIST; the rule prefix resolves against next's registration.
  {
    files: ["app/**/*.{js,jsx,ts,tsx}", "components/**/*.{js,jsx,ts,tsx}"],
    rules: { ...jsxA11y.flatConfigs.recommended.rules },
  },
  // `no-unused-vars` honours the `_` prefix for ARGUMENTS, caught errors and
  // destructured array slots (2026-10-19). Measured that day: 187 of the rule's
  // 305 hits were names their authors had already written as `_params`, `_t`,
  // `_init` — positional parameters of a mock or handler signature, which cannot
  // be deleted without shifting the ones after them. The prefix is the author's
  // claim that the slot is unused ON PURPOSE; counting it anyway taught nothing
  // and buried the 118 hits that are real dead code. ⚠ Plain VARIABLES are NOT
  // exempted: an `_`-named `const` that nothing reads is still dead code.
  // `ignoreRestSiblings` covers `const { x: _drop, ...rest } = obj`, the idiom
  // for "everything but x" — the dropped key exists only to shape `rest`.
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // ⚠ ISTANBUL'S HTML REPORT ASSETS, AND LEAVING THEM IN MADE THE RATCHET'S
    // OWN READING DEPEND ON BUILD ARTIFACTS. `npm run test:coverage*` writes
    // vendored files (prettify.js, block-navigation.js, sorter.js) into these
    // three directories; eslint linted all 9 of them. They contribute ZERO rule
    // violations, so the 715 baseline was never contaminated — but each carries
    // an `eslint-disable` that suppresses nothing, so the ratchet printed
    // "3 eslint-disable directive(s) suppress nothing" pointing at vendored code
    // nobody here wrote.
    //
    // ⭐ THE TELL IS THAT THE NUMBER MOVES WITH WHETHER COVERAGE WAS LAST RUN:
    // `scripts/run-lint-ratchet.mjs`'s own header records "3072 files", measured
    // on a box with no coverage output; this box read 3081 with it. A fresh
    // clone would print 0 suppressions and a future reader would conclude three
    // were fixed. An instrument whose population depends on build output cannot
    // be compared across runs — so the population is now the source tree.
    "coverage/**",
    "coverage-components/**",
    "coverage-workers/**",
    // 🚨 SAME DEFECT, LARGER BLAST RADIUS — and this one DID contaminate the
    // baseline. An agent run with `isolation: "worktree"` checks a SECOND FULL
    // COPY of this repo out under `.claude/worktrees/<name>/`, and eslint walks
    // it: measured 2026-09-20, `npm run lint:ratchet` read **6208 files, 1425
    // violations** against a 712 baseline and reported all NINETEEN rules as
    // regressions at once — `no-unused-vars` 353 → 707, `no-html-link-for-pages`
    // 114 → 228, and so on down the list.
    //
    // ⭐ THE TELL WAS THAT EVERY RULE DOUBLED EXACTLY. A perfect ratio across
    // nineteen independent rules is not nineteen regressions, it is one
    // population counted twice — the repo linting its own second checkout. The
    // stray worktree held zero unique commits and a clean status; it was left
    // behind by an agent run that never cleaned up, and `git worktree list` was
    // the only thing that named it.
    //
    // A worktree is transient and per-machine, so its presence must not be able
    // to move this instrument at all. `.claude/` carries no project source —
    // three tracked files, all hooks/settings, none lintable.
    ".claude/**",
    // ⚠ Same class, and the reason these need naming EXPLICITLY: eslint's flat
    // config does NOT read `.gitignore`. Both of these are gitignored scratch
    // space — `_to_delete/` is where the QA sweeps drop screenshots and probe
    // scripts (scripts/qa/README.md), `Rip Packs City/` holds archived Cowork
    // handoff patches — so `git status` stays clean while the ratchet's
    // population silently tracks whatever was last left lying around. 23 files
    // and 1 violation on 2026-09-20. Neither is source; neither should be able
    // to move this number.
    "_to_delete/**",
    "Rip Packs City/**",
  ]),
]);

export default eslintConfig;
