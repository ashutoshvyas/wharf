import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "gateway/dist/**",
      "prototype/**",
      // Next generates this file; it is gitignored and not ours to lint.
      "next-env.d.ts",
      "test-results/**",
    ],
  },
  {
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "ssh2",
              message:
                "ssh2 may only be imported from lib/ssh.ts (single SSH choke point — architecture §4.1).",
            },
          ],
        },
      ],
    },
  },
  {
    // The panel-side choke point and the gateway service are the only
    // legitimate ssh2 consumers (architecture §4.1 / §4.2).
    files: ["lib/ssh.ts", "gateway/**"],
    rules: { "no-restricted-imports": "off" },
  },
];

export default eslintConfig;
