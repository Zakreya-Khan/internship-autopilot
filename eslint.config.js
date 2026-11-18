import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "coverage/**",
      "playwright-report/**",
      "test-results/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
      eqeqeq: ["error", "smart"],
    },
  },
  {
    // Hard limit: adapters must never click anything on their own, and above all never Submit.
    // The one allowed click lives in `clickWizardNext`, which refuses submit-like buttons.
    files: ["packages/adapters/src/**/*.ts", "apps/extension/src/**/*.ts"],
    rules: {
      "no-restricted-properties": [
        "error",
        {
          property: "click",
          message: "Adapters never click. Use clickWizardNext() for wizard steps only.",
        },
        { property: "requestSubmit", message: "The tool never submits an application." },
        { property: "submit", message: "The tool never submits an application." },
      ],
    },
  },
);
