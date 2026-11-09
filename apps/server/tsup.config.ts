import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "db/migrate-cli": "src/db/migrate-cli.ts",
    "ops/load-run": "../../tests/load/run.mjs"
  },
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  loader: { ".sql": "text" },
  noExternal: [/^@trinitymatrix\//]
});
