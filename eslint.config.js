import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "data/**",
      "prd/**",
      "coverage/**",
      // The desktop app's generated bundle and Rust build output (ADR-011).
      "apps/desktop/build/**",
      "apps/desktop/src-tauri/target/**",
      "apps/desktop/src-tauri/gen/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    files: ["apps/client/src/**", "apps/desktop/ui/**"],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    files: ["apps/desktop/scripts/**"],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
);
