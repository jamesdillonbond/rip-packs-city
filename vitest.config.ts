import { defineConfig } from "vitest/config"
import path from "path"

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
      // ⚠ PIN supabase-js TO THE ROOT COPY. Two worker directories
      // ⤵ 22 lines of history displaced VERBATIM (2026-09-02) to docs/reference/vitest-config-notes.md §1 — read them before changing the next key.
      "@supabase/supabase-js": path.resolve(
        __dirname,
        "node_modules/@supabase/supabase-js",
      ),
    },
  },
  test: {
    include: ["__tests__/**/*.test.ts", "__tests__/**/*.test.tsx"],
    environment: "node",
    // ── testTimeout: 30s, raised from vitest's 5s DEFAULT (2026-08-24) ────────
    // ⤵ 24 lines of history displaced VERBATIM (2026-09-02) to docs/reference/vitest-config-notes.md §2 — read them before changing the next key.
    testTimeout: 30_000,
    setupFiles: ["./vitest.setup.ts"],
    coverage: {
      provider: "v8",
      // ⚠ DISTINCT PER GATE, AND LOAD-BEARING. All three gates defaulted to
      // ⤵ 24 lines of history displaced VERBATIM (2026-09-02) to docs/reference/vitest-config-notes.md §3 — read them before changing the next key.
      reportsDirectory: "coverage",
      reporter: ["text", "html"],
      // Two tested layers are measured here: the pure lib/ logic (unit tests)
      // ⤵ 52 lines of history displaced VERBATIM (2026-09-02) to docs/reference/vitest-config-notes.md §4 — read them before changing the next key.
      include: [
        "lib/**/*.ts",
        "lib/**/*.tsx",
        "app/**/route.ts",
        "app/**/route.tsx",
        "supabase/functions/_shared/**/*.ts",
        "proxy.ts",
      ],
      exclude: ["lib/**/*.test.ts", "lib/**/*.d.ts"],
      // CI ratchet — set just below the current baseline so a coverage DROP
      // ⤵ 751 lines of history displaced VERBATIM (2026-09-02) to docs/reference/vitest-config-notes.md §5 — read them before changing the next key.
      thresholds: {
        statements: 91.8,
        branches: 79.4,
        functions: 93.6,
        lines: 93.85,
      },
    },
  },
})
