import { beforeEach, describe, expect, it, vi } from "vitest";

const { createClient } = vi.hoisted(() => ({
  createClient: vi.fn(() => ({ kind: "valkey-client" }))
}));

vi.mock("redis", () => ({ createClient }));

import { createValkeyClient } from "./valkey-client";

describe("createValkeyClient", () => {
  beforeEach(() => createClient.mockClear());

  it("suppresses unsupported metadata and maintenance handshake commands", () => {
    const client = createValkeyClient("rediss://cache.internal:6379");

    expect(client).toEqual({ kind: "valkey-client" });
    expect(createClient).toHaveBeenCalledOnce();
    expect(createClient).toHaveBeenCalledWith({
      url: "rediss://cache.internal:6379",
      disableClientInfo: true,
      maintNotifications: "disabled"
    });
  });
});
