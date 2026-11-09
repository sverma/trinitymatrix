import { createClient } from "redis";
import { afterAll, describe, expect, it } from "vitest";
import { ValkeyDistributedGameTransport, type InstanceEnvelope } from "./distributed-transport";

const redisUrl = process.env.DISTRIBUTED_TRANSPORT_TEST_REDIS_URL;
const integration = describe.skipIf(!redisUrl);

integration("Valkey distributed transport integration", () => {
  const firstClient = createClient({ url: redisUrl! });
  const secondClient = createClient({ url: redisUrl! });
  let resolveReceived!: (envelope: InstanceEnvelope) => void;
  const received = new Promise<InstanceEnvelope>((resolve) => { resolveReceived = resolve; });
  const first = new ValkeyDistributedGameTransport(firstClient, "rm:transport-test", "app-a", {
    onInstanceEnvelope() {},
    onPlayerMessage() {},
    onPublishedEvent() {}
  });
  const second = new ValkeyDistributedGameTransport(secondClient, "rm:transport-test", "app-b", {
    onInstanceEnvelope: resolveReceived,
    onPlayerMessage() {},
    onPublishedEvent() {}
  });

  afterAll(async () => {
    await Promise.allSettled([first.close(), second.close()]);
    await Promise.allSettled([
      firstClient.isOpen ? firstClient.quit() : Promise.resolve(),
      secondClient.isOpen ? secondClient.quit() : Promise.resolve()
    ]);
  });

  it("delivers a versioned command between independent publisher/subscriber pairs", async () => {
    await Promise.all([first.start(), second.start()]);
    const matchId = "00000000-0000-4000-8000-000000000001";
    const playerId = "00000000-0000-4000-8000-000000000002";
    const commandId = "00000000-0000-4000-8000-000000000003";
    await first.routeCommand({
      targetInstanceId: "app-b",
      matchId,
      fencingToken: 9,
      playerId,
      clientProtocolVersion: 1,
      command: { type: "game.draw-stock", commandId, gameId: matchId, expectedRevision: 4 }
    });

    const envelope = await Promise.race([
      received,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("Valkey route timed out")), 2_000))
    ]);
    expect(envelope).toMatchObject({
      protocolVersion: 1,
      kind: "game.command",
      targetInstanceId: "app-b",
      matchId,
      playerId,
      fencingToken: 9,
      command: { commandId }
    });
  });
});
