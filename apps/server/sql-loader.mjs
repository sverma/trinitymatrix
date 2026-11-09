import { readFile } from "node:fs/promises";

export async function load(url, context, nextLoad) {
  if (url.endsWith(".sql")) {
    const sql = await readFile(new URL(url), "utf8");
    return {
      format: "module",
      shortCircuit: true,
      source: `export default ${JSON.stringify(sql)};`
    };
  }
  return nextLoad(url, context);
}
