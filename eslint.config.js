import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import stylistic from "@stylistic/eslint-plugin";
import tseslint from "typescript-eslint";

// Flat config (ESLint 10). JS recommended + typescript-eslint recommended +
// react-hooks + react-refresh, plus ESLint Stylistic as the format gate
// (replaces Prettier: one tool for lint + format).
//
// Stylistic is customized to the project's existing double-quote / semicolon
// style — its recommended preset defaults to single-quote / no-semi, which
// would force a large, noisy reformat of the whole frontend. A few overly
// aggressive rules are relaxed so the gate enforces consistency without
// churning readable code. Mirrors `cargo fmt --check` on the Rust side.
// `lint` script and CI run `eslint .` with --max-warnings 0 (parity with cargo).
export default tseslint.config(
  { ignores: ["dist"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
    },
  },
  {
    extends: [
      stylistic.configs.customize({
        quotes: "double",
        semi: true,
        jsx: true,
      }),
    ],
    files: ["**/*.{ts,tsx}"],
    rules: {
      // Match existing style: parenthesize single-arg arrows, e.g. (x) => x.
      "@stylistic/arrow-parens": ["error", "always"],
      // Match existing style: closing brace and else on one line (1tbs).
      "@stylistic/brace-style": ["error", "1tbs", { allowSingleLine: true }],
      // Keep multi-line union types and type aliases readable.
      "@stylistic/operator-linebreak": "off",
      // Too aggressive: one JSX expression per line breaks inline text.
      "@stylistic/jsx-one-expression-per-line": "off",
      // Too aggressive: splits readable single-line ternaries.
      "@stylistic/multiline-ternary": "off",
    },
  },
);
