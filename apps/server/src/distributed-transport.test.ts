import { describe, expect, it, vi } from "vitest";
import {
  ValkeyDistributedGameTransport,
  type RoutedCommandEnvelope
} from "./distributed-transport";

class FakeSubscriber {
  isOpen = false;
  readonly listeners = new Map<string, (message: string, channel: string) => void>();
  readonly unsubscribed: string[] = [];
  quitCalled = false;

  async connect() { this.isOpen = true; }
  async subscribe(channel: string, listener: (message: string, channel: string) => void) {
    this.listeners.set(channel, listener);
  }
  async unsubscribe(channel: string) { this.unsubscribed.push(channel); }
  async quit() { this.quitCalled = true; this.isOpen = false; }
  emit(channel: string, message: unknown) {
    this.listeners.get(channel)?.(typeof message === "string" ? message : JSON.stringify(message), channel);
  }
}

class FakePublisher {
  isOpen = false;
  readonly subscriber = new FakeSubscriber();
  readonly published: Array<{ channel: string; message: string }> = [];
  async connect() { this.isOpen = true; }
  duplicate() { return this.subscriber; }
  async publish(channel: string, message: string) {
    this.published.push({ channel, message });
    return 1;
  }
}

const ids = {
  match: "00000000-0000-4000-8000-000000000001",
  player: "00000000-0000-4000-8000-000000000002",
  event: "00000000-0000-4000-8000-000000000003",
  command: "00000000-0000-4000-8000-000000000004"
} as const;

describe("Valkey distributed game transport", () => {
  it("uses a dedicated subscriber and routes strict versioned envelopes", async () => {
    const publisher = new FakePublisher();
    const onInstanceEnvelope = vi.fn();
    const invalid = vi.fn();
    const transport = new ValkeyDistributedGameTransport(
      publisher,
      "trinitymatrix:production:v1",
      "app-a",
      {
        onInstanceEnvelope,
        onPlayerMessage: vi.fn(),
        onPublishedEvent: vi.fn(),
        onInvalidEnvelope: invalid
      }
    );
    await transport.start();

    expect(publisher.isOpen).toBe(true);
    expect(publisher.subscriber.isOpen).toBe(true);
    expect(publisher.subscriber.listeners.size).toBe(3);

    await transport.routeCommand({
      targetInstanceId: "app-b",
      matchId: ids.match,
      fencingToken: 7,
      playerId: ids.player,
      clientProtocolVersion: 1,
      command: { type: "game.draw-stock", commandId: ids.command }
    });
    const routed = publisher.published.at(-1)!;
    expect(routed.channel).toBe("trinitymatrix:production:v1:distributed:v1:instance:app-b");
    expect(JSON.parse(routed.message)).toMatchObject({
      protocolVersion: 1,
      kind: "game.command",
      targetInstanceId: "app-b",
      matchId: ids.match,
      fencingToken: 7
    });

    const valid: RoutedCommandEnvelope = {
      protocolVersion: 1,
      envelopeId: ids.event,
      sentAt: "2026-08-29T12:00:00.000Z",
      kind: "game.command",
      targetInstanceId: "app-a",
      matchId: ids.match,
      fencingToken: 7,
      playerId: ids.player,
      clientProtocolVersion: 1,
      command: { type: "game.draw-stock", commandId: ids.command }
    };
    const ownChannel = "trinitymatrix:production:v1:distributed:v1:instance:app-a";
    publisher.subscriber.emit(ownChannel, valid);
    expect(onInstanceEnvelope).toHaveBeenCalledWith(valid);

    publisher.subscriber.emit(ownChannel, { ...valid, protocolVersion: 2 });
    publisher.subscriber.emit(ownChannel, { ...valid, targetInstanceId: "app-b" });
    expect(invalid).toHaveBeenCalledTimes(2);

    await transport.close();
    expect(publisher.subscriber.unsubscribed).toHaveLength(3);
    expect(publisher.subscriber.quitCalled).toBe(true);
  });

  it("rejects oversized or malformed messages before invoking handlers", async () => {
    const publisher = new FakePublisher();
    const onInstanceEnvelope = vi.fn();
    const invalid = vi.fn();
    const transport = new ValkeyDistributedGameTransport(publisher, "rm", "app-a", {
      onInstanceEnvelope,
      onPlayerMessage: vi.fn(),
      onPublishedEvent: vi.fn(),
      onInvalidEnvelope: invalid
    });
    await transport.start();
    const channel = "rm:distributed:v1:instance:app-a";
    publisher.subscriber.emit(channel, "not-json");
    publisher.subscriber.emit(channel, "x".repeat(64 * 1024 + 1));
    expect(onInstanceEnvelope).not.toHaveBeenCalled();
    expect(invalid).toHaveBeenCalledTimes(2);
  });
});
