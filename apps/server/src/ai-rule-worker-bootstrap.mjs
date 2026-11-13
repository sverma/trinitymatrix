// Source-mode workers use tsx's explicit import API; Node's native .ts handling
// can otherwise bypass the extensionless dependency resolver in worker threads.
import { tsImport } from "tsx/esm/api";
await tsImport(new URL("./ai-rule-worker.ts", import.meta.url).href, import.meta.url);
