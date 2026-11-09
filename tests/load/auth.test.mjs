import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import { checkReadiness, withLoopbackAddressFallback } from "./lib/auth.mjs";

describe("non-local readiness witness", () => {
  it("requests /api/session and requires an unauthenticated 401 response", async () => {
    let status = 401;
    const paths = [];
    const server = createServer((request, response) => {
      paths.push(request.url);
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ authenticated: false }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      assert(address && typeof address === "object");
      const config = { local: false, baseUrl: new URL(`http://127.0.0.1:${address.port}`) };

      await checkReadiness(config);
      assert.deepEqual(paths, ["/api/session"]);

      status = 404;
      await assert.rejects(checkReadiness(config), /Target is not ready \(HTTP 404\)/);
      assert.deepEqual(paths, ["/api/session", "/api/session"]);
    } finally {
      server.close();
      await once(server, "close");
    }
  });
});

describe("local authentication address fallback", () => {
  it("retries EADDRNOTAVAIL once on 127.0.0.1 and returns the effective address", async () => {
    const attempted = [];
    const result = await withLoopbackAddressFallback("127.0.0.2", async (address) => {
      attempted.push(address);
      if (address === "127.0.0.2") throw Object.assign(new Error("not assigned"), { code: "EADDRNOTAVAIL" });
      return "rm_session=test";
    });
    assert.deepEqual(attempted, ["127.0.0.2", "127.0.0.1"]);
    assert.deepEqual(result, { value: "rm_session=test", localAddress: "127.0.0.1" });
  });

  it("does not hide or retry arbitrary connection errors", async () => {
    let attempts = 0;
    await assert.rejects(
      withLoopbackAddressFallback("127.0.0.2", async () => {
        attempts += 1;
        throw Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
      }),
      (error) => error.code === "ECONNREFUSED"
    );
    assert.equal(attempts, 1);
  });
});
