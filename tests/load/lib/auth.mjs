import { readFile, stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

function requestJson(url, { method = "GET", body, headers = {}, localAddress, timeoutMs = 10_000 } = {}) {
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const requestFn = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const request = requestFn(url, {
      method,
      localAddress,
      headers: {
        accept: "application/json",
        "user-agent": "trinitymatrix-controlled-load-player/1.0",
        ...(payload ? { "content-type": "application/json", "content-length": String(payload.length) } : {}),
        ...headers
      },
      timeout: timeoutMs
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > 1024 * 1024) {
          request.destroy(new Error("HTTP response exceeded 1 MiB."));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed = null;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          reject(new Error(`Expected JSON from ${url.pathname}, received status ${response.statusCode}.`));
          return;
        }
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body: parsed });
      });
    });
    request.on("timeout", () => request.destroy(new Error(`HTTP request timed out after ${timeoutMs}ms.`)));
    request.on("error", reject);
    if (payload) request.write(payload);
    request.end();
  });
}

export function localAddressForPlayer(index) {
  const addressIndex = 2 + Math.floor(index / 50);
  if (addressIndex > 254) throw new Error("The local auth source pool supports at most 12,650 players.");
  return `127.0.0.${addressIndex}`;
}

export async function withLoopbackAddressFallback(preferredAddress, operation) {
  try {
    return { value: await operation(preferredAddress), localAddress: preferredAddress };
  } catch (error) {
    if (error?.code !== "EADDRNOTAVAIL" || preferredAddress === "127.0.0.1") throw error;
    return { value: await operation("127.0.0.1"), localAddress: "127.0.0.1" };
  }
}

export async function checkReadiness(config) {
  // Non-local environments may keep operational health endpoints private. An
  // unauthenticated API response verifies that the public application route is reachable.
  const path = config.local ? "/readyz" : "/api/session";
  const response = await requestJson(new URL(path, config.baseUrl), {
    timeoutMs: 5_000
  });
  const expected = config.local ? 200 : 401;
  if (response.status !== expected) {
    throw new Error(`Target is not ready (HTTP ${response.status}).`);
  }
}

function cookieFromHeaders(headers) {
  const raw = headers["set-cookie"];
  const setCookie = Array.isArray(raw) ? raw[0] : raw;
  const cookie = setCookie?.split(";", 1)[0];
  if (!cookie?.startsWith("rm_session=")) throw new Error("Authentication did not return an rm_session cookie.");
  return cookie;
}

export async function authenticateMockPlayer(config, index, runId) {
  if (!config.local) throw new Error("Mock OTP authentication is restricted to localhost.");
  const email = `tm-load-${runId}-${String(index + 1).padStart(4, "0")}@example.test`;
  const displayName = `Load ${String(index + 1).padStart(4, "0")}`;
  const startedAt = performance.now();
  const authenticated = await withLoopbackAddressFallback(localAddressForPlayer(index), async (localAddress) => {
    const requested = await requestJson(new URL("/api/auth/request-otp", config.baseUrl), {
      method: "POST",
      localAddress,
      headers: { origin: config.baseUrl.origin },
      body: { email }
    });
    if (requested.status !== 200 || typeof requested.body?.challengeId !== "string" || requested.body?.delivery !== "mock") {
      throw new Error(`Mock OTP request failed with HTTP ${requested.status}; confirm the local server uses AUTH_PROVIDER=mock.`);
    }
    const verified = await requestJson(new URL("/api/auth/verify-otp", config.baseUrl), {
      method: "POST",
      localAddress,
      headers: { origin: config.baseUrl.origin },
      body: {
        challengeId: requested.body.challengeId,
        code: config.mockOtpCode,
        displayName
      }
    });
    if (verified.status !== 200) throw new Error(`Mock OTP verification failed with HTTP ${verified.status}.`);
    return cookieFromHeaders(verified.headers);
  });
  return {
    cookie: authenticated.value,
    localAddress: authenticated.localAddress,
    authMs: performance.now() - startedAt
  };
}

export async function loadSessionPool(path, requiredCount) {
  const metadata = await stat(path);
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    throw new Error("Session file permissions are too broad; use chmod 600.");
  }
  const parsed = JSON.parse(await readFile(path, "utf8"));
  const entries = Array.isArray(parsed) ? parsed : parsed?.sessions;
  if (!Array.isArray(entries)) throw new Error("Session file must be an array or an object containing a sessions array.");
  const sessions = entries.map((entry, index) => {
    const cookie = typeof entry === "string" ? entry : entry?.cookie;
    if (typeof cookie !== "string" || !/^rm_session=[0-9a-f-]{36}$/i.test(cookie)) {
      throw new Error(`Session entry ${index + 1} is not an rm_session cookie.`);
    }
    return { cookie, localAddress: undefined, authMs: 0 };
  });
  if (sessions.length < requiredCount) {
    throw new Error(`Session file contains ${sessions.length} sessions; ${requiredCount} unique sessions are required.`);
  }
  const selected = sessions.slice(0, requiredCount);
  if (new Set(selected.map(({ cookie }) => cookie)).size !== selected.length) {
    throw new Error("Session cookies must be unique; sharing one player session replaces its WebSocket.");
  }
  return selected;
}

export { requestJson };
