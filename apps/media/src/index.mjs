import { createMediaServer, loadMediaConfig, MediaManager } from "./worker.mjs";

try {
  const config = loadMediaConfig();
  const manager = new MediaManager(config, { report: (code, streamId) => process.stderr.write(`${JSON.stringify({ code, streamId })}\n`) });
  await manager.init();
  const server = createMediaServer(manager, config.secret);
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(config.port, config.host, resolve); });
  const maintenance = setInterval(() => { void manager.sweep().catch(() => process.stderr.write('{"code":"media-maintenance-failed"}\n')); }, 1_000);
  maintenance.unref();
  let stopping = false;
  const stop = async () => {
    if (stopping) return; stopping = true; clearInterval(maintenance);
    server.close(); server.closeIdleConnections();
    await manager.close();
    server.closeAllConnections();
  };
  process.once("SIGTERM", () => { void stop(); });
  process.once("SIGINT", () => { void stop(); });
} catch {
  process.stderr.write('{"code":"media-startup-failed"}\n');
  process.exitCode = 1;
}
