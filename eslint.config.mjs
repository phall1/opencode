import tsParser from "@typescript-eslint/parser"
import { plugin as opentui, recommended } from "opentui-lint"

// Proof run of opentui-lint (npm) over the Solid TUI. `spinner` is registered
// at runtime by opentui-spinner/solid and `title_shimmer` by extend() in
// component/title-shimmer.tsx, both outside the linted file, so they are
// declared here instead of per-file.
export default [
  {
    files: ["packages/tui/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { opentui },
    settings: {
      opentui: {
        framework: "solid",
        extendedElements: ["spinner", "title_shimmer"],
      },
    },
    rules: recommended,
  },
  {
    ignores: ["**/node_modules/**", "**/dist/**", "**/dist-node/**", "**/.sst/**", "**/sst-env.d.ts"],
  },
]
