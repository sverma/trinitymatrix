import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";

function listen(server) {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen(server.address()));
  });
}

function waitForOutput(child, output, pattern, timeoutMs) {
  return new Promise((resolveWait, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${pattern}. Output: ${output.value}`)), timeoutMs);
    const inspect = () => {
      if (!pattern.test(output.value)) return;
      clearTimeout(timeout);
      child.stderr.off("data", inspect);
      resolveWait();
    };
    child.stderr.on("data", inspect);
    inspect();
  });
}

function waitForExit(child, timeoutMs) {
  return Promise.race([
    new Promise((resolveExit, reject) => {
      child.once("exit", (code, signal) => resolveExit({ code, signal }));
      child.once("error", reject);
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Load harness did not stop after SIGTERM.")), timeoutMs))
  ]);
}

test("SIGTERM aborts a ramp immediately instead of starting later player groups", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trinitymatrix-load-signal-"));
  const server = createServer((request, response) => {
    response.writeHead(request.url === "/readyz" ? 200 : 404, { "content-type": "application/json" });
    response.end(request.url === "/readyz" ? "{}" : '{"error":"not found"}');
  });
  context.after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolveClose) => server.close(resolveClose));
    await rm(directory, { recursive: true, force: true });
  });
  const address = await listen(server);
  assert.equal(typeof address, "object");
  const sessions = Array.from({ length: 50 }, () => `rm_session=${randomUUID()}`);
  const sessionFile = join(directory, "sessions.json");
  await writeFile(sessionFile, JSON.stringify(sessions), { mode: 0o600 });

  const child = spawn(process.execPath, [
    resolve("tests/load/run.mjs"),
    "--base-url", `http://127.0.0.1:${address.port}`,
    "--games", "25",
    "--player-count", "2",
    "--session-file", sessionFile,
    "--ramp-up", "60s",
    "--hold", "60s",
    "--ramp-down", "60s",
    "--output", join(directory, "result.json")
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const output = { value: "" };
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { output.value += chunk; });

  await waitForOutput(child, output, /ramp-up phase/, 5_000);
  child.kill("SIGTERM");
  const exit = await waitForExit(child, 5_000);
  assert.deepEqual(exit, { code: 130, signal: null });
});
