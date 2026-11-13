import { Worker } from "node:worker_threads";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { build } from "tsup";
import { createDeck } from "@trinitymatrix/game-domain";
import { describe, expect, it } from "vitest";
import { AiRuleToolService, aiRuleWorkerUrl } from "./ai-rule-tool-service";
import type { AiRulesInput } from "./ai-rule-tools";

const input: AiRulesInput = { hand: createDeck().slice(0, 13), wildRank: 7 };
const sourceWorker = () => new Worker(new URL("./ai-rule-worker-bootstrap.mjs", import.meta.url), { execArgv: [] });
const stuckWorker = () => new Worker("const {parentPort}=require('node:worker_threads');parentPort.on('message',()=>{while(true){}});", { eval: true, execArgv: [] });

describe("bounded AI rules worker service", () => {
  it("runs the real development worker and reuses it for later own-hand jobs", async () => {
    let created = 0;
    const service = new AiRuleToolService({ workerFactory: () => { created++; return sourceWorker(); } });
    try {
      expect((await service.compute(input, 3_000)).status).toBe("complete");
      expect((await service.compute({ ...input, wildRank: 6 }, 3_000)).status).toBe("complete");
      expect(created).toBe(1);
    } finally { await service.stop(); }
  });

  it("keeps the event loop responsive and terminates/replaces a stuck worker at its hard deadline", async () => {
    let created = 0; let heartbeats = 0;
    const service = new AiRuleToolService({ workerFactory: () => ++created === 1 ? stuckWorker() : sourceWorker() });
    const timer = setInterval(() => { heartbeats++; }, 5);
    try {
      const facts = await service.compute(input, 80);
      expect(facts).toMatchObject({ status: "unavailable", reason: "time-budget", readyHand: null, immediateDeclaration: null });
      expect(heartbeats).toBeGreaterThan(2);
      expect((await service.compute(input, 3_000)).status).toBe("complete");
      expect(created).toBe(2);
    } finally { clearInterval(timer); await service.stop(); }
  });

  it("bounds pending jobs at8 and cancels every active/queued promise during shutdown", async () => {
    let created = 0;
    const service = new AiRuleToolService({ workerFactory: () => { created++; return stuckWorker(); } });
    const work = Array.from({ length: 9 }, () => service.compute(input, 3_000));
    expect(await service.compute(input, 3_000)).toMatchObject({ status: "unavailable", reason: "tool-error" });
    await service.stop();
    expect((await Promise.all(work)).every(({ status }) => status === "unavailable")).toBe(true);
    expect((await service.compute(input)).status).toBe("unavailable");
    expect(created).toBe(1);
  });

  it("includes waiting time in each job's deadline", async () => {
    const service = new AiRuleToolService({ workerFactory: stuckWorker });
    try {
      const active = service.compute(input, 3_000);
      expect(await service.compute(input, 25)).toMatchObject({ status: "unavailable", reason: "time-budget" });
      await service.cancelAll();
      expect((await active).status).toBe("unavailable");
    } finally { await service.stop(); }
  });

  it("cancels a stale active revision and lets the next job run in a fresh worker", async () => {
    let created = 0; const controller = new AbortController();
    const service = new AiRuleToolService({ workerFactory: () => ++created === 1 ? stuckWorker() : sourceWorker() });
    try {
      const previous = service.compute(input, 3_000, controller.signal);
      const next = service.compute(input, 3_000);
      controller.abort();
      expect((await previous).status).toBe("unavailable");
      expect((await next).status).toBe("complete");
      expect(created).toBe(2);
    } finally { await service.stop(); }
  });

  it("turns malformed worker replies into unavailable facts", async () => {
    const service = new AiRuleToolService({ workerFactory: () => new Worker("const {parentPort}=require('node:worker_threads');parentPort.on('message',({id})=>parentPort.postMessage({id,facts:{status:'complete'}}));", { eval: true, execArgv: [] }) });
    try { expect(await service.compute(input, 1_000)).toMatchObject({ status: "unavailable", reason: "tool-error" }); }
    finally { await service.stop(); }
  });

  it("never sends extra actor, opponent or hidden-stock fields into the worker", async () => {
    let observed: unknown;
    const service = new AiRuleToolService({ workerFactory: () => {
      const worker = new Worker("const {parentPort}=require('node:worker_threads');parentPort.on('message',({id,input})=>{parentPort.postMessage({observed:input});parentPort.postMessage({id,facts:{rulesRevision:'trinity-rules/1.0.0',toolVersion:'shared-own-hand-legality/1.0.0',status:'unavailable',reason:'tool-error',readyHand:null,immediateDeclaration:null}});});", { eval: true, execArgv: [] });
      worker.on("message", (message: { observed?: unknown }) => { if (message.observed) observed = message.observed; });
      return worker;
    } });
    try {
      const extra = { ...input, opponentHands: [["hidden"]], stock: ["future"], playerId: "private-actor", memory: "private memory" };
      await service.compute(extra, 1_000);
      expect(observed).toEqual(input);
      expect(JSON.stringify(observed)).not.toMatch(/hidden|future|private/);
    } finally { await service.stop(); }
  });

  it("resolves source, bundled-index and bundled-ops worker entry URLs", () => {
    expect(aiRuleWorkerUrl("file:///repo/apps/server/src/ai-rule-tool-service.ts").pathname).toBe("/repo/apps/server/src/ai-rule-worker-bootstrap.mjs");
    expect(aiRuleWorkerUrl("file:///repo/apps/server/dist/index.js").pathname).toBe("/repo/apps/server/dist/ops/ai-rule-worker.js");
    expect(aiRuleWorkerUrl("file:///repo/apps/server/dist/chunk-ABCD.js").pathname).toBe("/repo/apps/server/dist/ops/ai-rule-worker.js");
    expect(aiRuleWorkerUrl("file:///repo/apps/server/dist/ops/ai-check.js").pathname).toBe("/repo/apps/server/dist/ops/ai-rule-worker.js");
  });

  it("runs the production-bundled service and worker without a TypeScript loader", async () => {
    const directory = await mkdtemp(join(tmpdir(), "trinity-rules-bundle-"));
    try {
      await build({ config: false, entry: {
        index: fileURLToPath(new URL("./ai-rule-tool-service.ts", import.meta.url)),
        "ops/ai-rule-worker": fileURLToPath(new URL("./ai-rule-worker.ts", import.meta.url))
      }, outDir: directory, format: ["esm"], platform: "node", target: "node22", noExternal: [/^@trinitymatrix\//], silent: true });
      await writeFile(join(directory, "package.json"), JSON.stringify({ type: "module" }));
      const script = "const {AiRuleToolService}=await import(process.argv[1]);const service=new AiRuleToolService();try{const facts=await service.compute(JSON.parse(process.argv[2]),3000);process.stdout.write(JSON.stringify({status:facts.status,toolVersion:facts.toolVersion}));if(facts.status!=='complete')process.exitCode=1;}finally{await service.stop();}";
      const environment = { ...process.env }; delete environment.NODE_OPTIONS;
      const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script, pathToFileURL(join(directory, "index.js")).href, JSON.stringify(input)], { timeout: 5_000, env: environment });
      expect(JSON.parse(stdout)).toEqual({ status: "complete", toolVersion: "shared-own-hand-legality/1.0.0" });
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 10_000);
});
