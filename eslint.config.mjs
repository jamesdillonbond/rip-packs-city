import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
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
  ]),
]);

export default eslintConfig;
