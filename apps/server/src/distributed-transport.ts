import { randomUUID } from "node:crypto";
import { z } from "zod";

const envelopeBase = z.object({
  protocolVersion: z.literal(1),
  envelopeId: z.string().uuid(),
  sentAt: z.string().datetime(),
  matchId: z.string().uuid(),
  fencingToken: z.number().int().positive()
});

export const routedCommandEnvelopeSchema = envelopeBase.extend({
  kind: z.literal("game.command"),
  targetInstanceId: z.string().min(1).max(200),
  playerId: z.string().uuid(),
  clientProtocolVersion: z.number().int().positive(),
  command: z.record(z.string(), z.unknown())
}).strict();

export const routedDeadlineEnvelopeSchema = envelopeBase.extend({
  kind: z.literal("game.deadline"),
  targetInstanceId: z.string().min(1).max(200),
  deadlineType: z.enum(["turn", "showdown"]),
  expectedRevision: z.number().int().positive(),
  deadlinePayload: z.record(z.string(), z.unknown())
}).strict();

export const playerMessageEnvelopeSchema = envelopeBase.extend({
  kind: z.literal("player.message"),
  sourceInstanceId: z.string().min(1).max(200),
  targetPlayerId: z.string().uuid(),
  eventId: z.string().uuid(),
  serverMessage: z.record(z.string(), z.unknown())
}).strict();

export const publishedEventEnvelopeSchema = envelopeBase.omit({ fencingToken: true }).extend({
  kind: z.literal("game.event"),
  deliverySemantics: z.literal("committed-event-log"),
  ownershipFenceAtCommit: z.number().int().positive(),
  outboxId: z.string().uuid(),
  eventSequence: z.number().int().positive(),
  topic: z.string().min(1).max(100),
  routingKey: z.string().min(1).max(200),
  eventPayload: z.record(z.string(), z.unknown())
}).strict();

export type RoutedCommandEnvelope = z.infer<typeof routedCommandEnvelopeSchema>;
export type RoutedDeadlineEnvelope = z.infer<typeof routedDeadlineEnvelopeSchema>;
export type PlayerMessageEnvelope = z.infer<typeof playerMessageEnvelopeSchema>;
export type PublishedEventEnvelope = z.infer<typeof publishedEventEnvelopeSchema>;
export type InstanceEnvelope = RoutedCommandEnvelope | RoutedDeadlineEnvelope;

type RedisSubscriber = {
  isOpen: boolean;
  connect(): Promise<unknown>;
  subscribe(channel: string, listener: (message: string, channel: string) => void): Promise<unknown>;
  unsubscribe(channel: string): Promise<unknown>;
  quit(): Promise<unknown>;
};

type RedisPublisher = {
  isOpen: boolean;
  connect(): Promise<unknown>;
  publish(channel: string, message: string): Promise<number>;
  duplicate(): RedisSubscriber;
};

export type DistributedTransportHandlers = Readonly<{
  onInstanceEnvelope(envelope: InstanceEnvelope): Promise<void> | void;
  onPlayerMessage(envelope: PlayerMessageEnvelope): Promise<void> | void;
  onPublishedEvent(envelope: PublishedEventEnvelope): Promise<void> | void;
  onInvalidEnvelope?(error: unknown, channel: string): void;
}>;

const maxEnvelopeBytes = 64 * 1024;

/**
 * Versioned Valkey Pub/Sub transport. The subscriber is always a dedicated
 * duplicate connection because a subscribed Redis connection cannot safely be
 * reused for normal commands or publishing.
 *
 * Pub/Sub is only the low-latency delivery plane. Commands remain unacknowledged
 * until the target owner commits through PostgresDistributedGameRuntime;
 * reconnect/materialization must read PostgreSQL when delivery is interrupted.
 */
export class ValkeyDistributedGameTransport {
  private subscriber: RedisSubscriber | null = null;
  private started = false;

  constructor(
    private readonly publisher: RedisPublisher,
    private readonly namespace: string,
    readonly instanceId: string,
    private readonly handlers: DistributedTransportHandlers
  ) {}

  private channel(suffix: string): string {
    return `${this.namespace}:distributed:v1:${suffix}`;
  }

  private instanceChannel(instanceId = this.instanceId): string {
    return this.channel(`instance:${instanceId}`);
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (!this.publisher.isOpen) await this.publisher.connect();
    const subscriber = this.publisher.duplicate();
    if (!subscriber.isOpen) await subscriber.connect();
    try {
      await subscriber.subscribe(this.instanceChannel(), (message, channel) => {
        this.parseAndDispatch(message, channel, "instance");
      });
      await subscriber.subscribe(this.channel("players"), (message, channel) => {
        this.parseAndDispatch(message, channel, "player");
      });
      await subscriber.subscribe(this.channel("events"), (message, channel) => {
        this.parseAndDispatch(message, channel, "event");
      });
      this.subscriber = subscriber;
      this.started = true;
    } catch (error) {
      if (subscriber.isOpen) await subscriber.quit();
      throw error;
    }
  }

  private parseAndDispatch(message: string, channel: string, type: "instance" | "player" | "event"): void {
    try {
      if (Buffer.byteLength(message, "utf8") > maxEnvelopeBytes) throw new Error("Distributed envelope exceeds 64 KiB.");
      const decoded: unknown = JSON.parse(message);
      if (type === "instance") {
        const command = routedCommandEnvelopeSchema.safeParse(decoded);
        const deadline = routedDeadlineEnvelopeSchema.safeParse(decoded);
        const envelope = command.success ? command.data : deadline.success ? deadline.data : null;
        if (!envelope || envelope.targetInstanceId !== this.instanceId) {
          throw new Error("Invalid or incorrectly routed instance envelope.");
        }
        void Promise.resolve(this.handlers.onInstanceEnvelope(envelope)).catch((error) => {
          this.handlers.onInvalidEnvelope?.(error, channel);
        });
        return;
      }
      if (type === "player") {
        const envelope = playerMessageEnvelopeSchema.parse(decoded);
        void Promise.resolve(this.handlers.onPlayerMessage(envelope)).catch((error) => {
          this.handlers.onInvalidEnvelope?.(error, channel);
        });
        return;
      }
      const envelope = publishedEventEnvelopeSchema.parse(decoded);
      void Promise.resolve(this.handlers.onPublishedEvent(envelope)).catch((error) => {
        this.handlers.onInvalidEnvelope?.(error, channel);
      });
    } catch (error) {
      this.handlers.onInvalidEnvelope?.(error, channel);
    }
  }

  async routeCommand(input: Omit<RoutedCommandEnvelope, "protocolVersion" | "envelopeId" | "sentAt" | "kind">): Promise<number> {
    const envelope = routedCommandEnvelopeSchema.parse({
      ...input,
      protocolVersion: 1,
      envelopeId: randomUUID(),
      sentAt: new Date().toISOString(),
      kind: "game.command"
    });
    return this.publisher.publish(this.instanceChannel(input.targetInstanceId), JSON.stringify(envelope));
  }

  async routeDeadline(input: Omit<RoutedDeadlineEnvelope, "protocolVersion" | "envelopeId" | "sentAt" | "kind">): Promise<number> {
    const envelope = routedDeadlineEnvelopeSchema.parse({
      ...input,
      protocolVersion: 1,
      envelopeId: randomUUID(),
      sentAt: new Date().toISOString(),
      kind: "game.deadline"
    });
    return this.publisher.publish(this.instanceChannel(input.targetInstanceId), JSON.stringify(envelope));
  }

  async publishPlayerMessage(input: Omit<PlayerMessageEnvelope, "protocolVersion" | "envelopeId" | "sentAt" | "kind">): Promise<number> {
    const envelope = playerMessageEnvelopeSchema.parse({
      ...input,
      protocolVersion: 1,
      envelopeId: randomUUID(),
      sentAt: new Date().toISOString(),
      kind: "player.message"
    });
    return this.publisher.publish(this.channel("players"), JSON.stringify(envelope));
  }

  async publishEvent(input: Omit<PublishedEventEnvelope, "protocolVersion" | "envelopeId" | "sentAt" | "kind">): Promise<number> {
    const envelope = publishedEventEnvelopeSchema.parse({
      ...input,
      protocolVersion: 1,
      envelopeId: randomUUID(),
      sentAt: new Date().toISOString(),
      kind: "game.event"
    });
    return this.publisher.publish(this.channel("events"), JSON.stringify(envelope));
  }

  async close(): Promise<void> {
    const subscriber = this.subscriber;
    this.subscriber = null;
    this.started = false;
    if (!subscriber) return;
    await Promise.allSettled([
      subscriber.unsubscribe(this.instanceChannel()),
      subscriber.unsubscribe(this.channel("players")),
      subscriber.unsubscribe(this.channel("events"))
    ]);
    if (subscriber.isOpen) await subscriber.quit();
  }
}
