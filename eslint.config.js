// Phase 66 (R45-CFG-9): minimal ESLint setup. Round 45 audit found this
// project had no lint-step at all — TS strict catches type errors but
// not the React-hooks-rules-of-hooks class of bugs (conditional hooks,
// hooks in loops, etc.) that have hit this codebase before (Phase 33
// fixed EquityCurve useId vs early-return).
//
// Soft rollout: only react-hooks/rules-of-hooks as ERROR (correctness),
// other rules as WARN so existing code stays buildable. Tighten over
// time as warnings get cleared.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "out/**",
      "build/**",
      "dist/**",
      "scripts/exploratory/**",
      "scripts/_*.ts", // experimental sweep scripts
      "playwright-report/**",
      ".playwright-test-results*/**",
      "tools/**", // python tooling (pyright handles it)
      ".claude/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      // Critical correctness — fail.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      // Style / hygiene — warn only for now (existing code volume too
      // large to fix in a single phase; clear over time).
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "off", // engine-config spreads use `any` heavily
      "@typescript-eslint/no-empty-object-type": "off",
      "no-empty": "off",
      "no-useless-escape": "warn",
      "no-prototype-builtins": "off",
      "no-control-regex": "off",
      "no-useless-assignment": "warn",
      "preserve-caught-error": "warn",
      "no-unused-vars": "off", // typescript-eslint handles this for TS files
    },
  },
];
