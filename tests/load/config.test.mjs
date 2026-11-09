import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  confirmationPhrase,
  isLocalTarget,
  parseDuration,
  parseLoadConfig,
  publicConfig
} from "./lib/config.mjs";

describe("load configuration", () => {
  it("parses bounded game shapes and durations", () => {
    const config = parseLoadConfig([
      "--base-url", "http://127.0.0.1:8181",
      "--player-count", "6",
      "--games", "50",
      "--ramp-up", "1.5m",
      "--hold", "30s",
      "--ramp-down", "500ms"
    ], "/repo");
    assert.equal(config.players, 300);
    assert.equal(config.rampUpMs, 90_000);
    assert.equal(config.holdMs, 30_000);
    assert.equal(config.rampDownMs, 500);
    assert.equal(publicConfig(config).authMode, "mock-otp");
    assert.equal(parseDuration("2m", "test"), 120_000);
  });

  it("rejects unsupported targets and non-local hosts without an environment allowlist", () => {
    assert.throws(() => parseLoadConfig(["--games", "26"]), /must be one of/);
    assert.throws(
      () => parseLoadConfig(["--base-url", "https://example.com", "--games", "25"]),
      /TRINITY_LOAD_ALLOWED_ORIGIN/
    );
    assert.throws(
      () => parseLoadConfig(["--base-url", "http://localhost:8181", "--games", "25"]),
      /127\.0\.0\.1/
    );
  });

  it("requires pre-issued sessions and an exact confirmation for an allowlisted target", () => {
    const environment = { TRINITY_LOAD_ALLOWED_ORIGIN: "https://load.example.test" };
    assert.throws(
      () => parseLoadConfig(["--base-url", "https://load.example.test", "--games", "25"], "/repo", environment),
      /session-file/
    );
    const dryRun = parseLoadConfig([
      "--base-url", "https://load.example.test",
      "--games", "25",
      "--player-count", "2",
      "--dry-run"
    ], "/repo", environment);
    assert.equal(confirmationPhrase(dryRun), "LOAD 25x2 ON https://load.example.test");
    assert.equal(isLocalTarget(dryRun.baseUrl), false);
    assert.throws(
      () => parseLoadConfig(["--base-url", "https://other.example.test", "--dry-run"], "/repo", environment),
      /not the origin allowlisted/
    );
  });

  it("rejects unsafe or non-canonical allowlist values", () => {
    const target = ["--base-url", "https://load.example.test", "--dry-run"];
    assert.throws(
      () => parseLoadConfig(target, "/repo", { TRINITY_LOAD_ALLOWED_ORIGIN: "http://load.example.test" }),
      /non-local HTTPS origin/
    );
    assert.throws(
      () => parseLoadConfig(target, "/repo", { TRINITY_LOAD_ALLOWED_ORIGIN: "https://load.example.test/path" }),
      /without credentials, path, query, or fragment/
    );
    assert.throws(
      () => parseLoadConfig(target, "/repo", { TRINITY_LOAD_ALLOWED_ORIGIN: "https://load.example.test/" }),
      /canonical origin form/
    );
  });

  it("does not expose the removed private routing override", () => {
    assert.throws(() => parseLoadConfig([
      "--connect-host", "internal.example.test"
    ]), /Unknown option --connect-host/);
  });

  it("accepts an allowlisted target only with the bound target/count confirmation", () => {
    const environment = { TRINITY_LOAD_ALLOWED_ORIGIN: "https://load.example.test" };
    const config = parseLoadConfig([
      "--base-url", "https://load.example.test",
      "--games", "50",
      "--player-count", "6",
      "--session-file", "sessions.json",
      "--confirm-non-local", "LOAD 50x6 ON https://load.example.test"
    ], "/repo", environment);
    assert.equal(config.sessionFile, "/repo/sessions.json");
    assert.equal(publicConfig(config).authMode, "session-file");
    assert.throws(() => parseLoadConfig([
      "--base-url", "https://load.example.test",
      "--games", "50",
      "--player-count", "6",
      "--session-file", "sessions.json",
      "--confirm-non-local", "LOAD 25x2 ON https://load.example.test"
    ], "/repo", environment), /Non-local safety confirmation required/);
  });
});
