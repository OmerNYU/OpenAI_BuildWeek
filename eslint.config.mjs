import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", ".failspec/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.vitest }
    },
    plugins: { "react-hooks": reactHooks },
    rules: reactHooks.configs.recommended.rules
  },
  {
    files: ["apps/server/**/*.ts", "packages/**/*.ts"],
    languageOptions: {
      globals: { ...globals.node, ...globals.vitest }
    }
  }
);
