import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DistributedMatchmaker } from "./distributed-matchmaker";
import { RankingGame } from "./game";

describe("distributed live gameplay coordinator", () => {
  afterEach(() => vi.useRealTimers());

  it("does not expose an accepted move until its durable event is committed and delivered by the outbox", async () => {
    const first = randomUUID();
    const second = randomUUID();
    const game = new RankingGame([
      { id: first, displayName: "Asha", badgeId: "rookie" },
      { id: second, displayName: "Bela", badgeId: "strategist" }
    ], () => 0);
    const activePlayer = game.currentPlayerId;
    const snapshot = game.snapshot();
    const materialized = {
      matchId: game.id,
      publicName: game.publicName,
      playerCount: 2 as const,
      matchType: "general" as const,
      status: "active" as const,
      eventSequence: 1,
      eventType: "game.started",
      eventPayload: {
        state: snapshot,
        matchType: "general",
        privateRoomCode: null,
        result: null,
        actorPlayerId: null
      },
      participants: snapshot.seats.map((seat, seatNumber) => ({
        playerId: seat.id,
        seatNumber,
        displayName: seat.displayName,
        badgeId: seat.badgeId
      })),
      privateRoomCode: null
    };
    const commitTransition = vi.fn(async (_input: {
      event: { eventId: string; payload: { state: { revision: number } } };
      nextDeadline: { expectedRevision: number };
    }) => ({
      disposition: "committed" as const,
      eventSequence: 2,
      result: { accepted: true }
    }));
    const runtime = {
      getActiveMatchIdForPlayer: vi.fn(async () => game.id),
      getRoute: vi.fn(async () => ({
        matchId: game.id,
        ownerInstanceId: "app-a",
        fencingToken: 1,
        leaseExpiresAt: new Date(Date.now() + 30_000),
        protocolMin: 1,
        protocolMax: 1,
        draining: false
      })),
      loadMaterializedGame: vi.fn(async () => materialized),
      getWaitingMatchmakingTicket: vi.fn(async () => null),
      commitTransition
    };
    const repository = {
      listPrivateRoomsForUser: vi.fn(async () => [])
    };
    const transport = { routeCommand: vi.fn(), publishPlayerMessage: vi.fn(async () => 1) };
    const leases = { track: vi.fn(), forget: vi.fn() };
    const reportError = vi.fn();
    const reconnectMetrics = {
      recordReconnectSuccess: vi.fn(),
      recordReconnectFailure: vi.fn()
    };
    const coordinator = new DistributedMatchmaker(
      runtime as never,
      repository as never,
      transport as never,
      leases as never,
      "app-a",
      "ap-south-1",
      reportError,
      reconnectMetrics
    );
    const send = vi.fn();
    const socket = { readyState: 1, send, close: vi.fn() };
    await coordinator.register({
      playerId: activePlayer,
      email: `${activePlayer}@example.test`,
      displayName: "Asha",
      badgeId: "rookie",
      socket: socket as never
    });
    expect(reconnectMetrics.recordReconnectSuccess).toHaveBeenCalledOnce();
    expect(reconnectMetrics.recordReconnectFailure).not.toHaveBeenCalled();
    send.mockClear();

    const command = {
      type: "game.draw" as const,
      commandId: randomUUID(),
      gameId: game.id,
      expectedRevision: 1,
      source: "stock" as const
    };
    await coordinator.onInstanceEnvelope({
      protocolVersion: 1,
      envelopeId: randomUUID(),
      sentAt: new Date().toISOString(),
      kind: "game.command",
      targetInstanceId: "app-a",
      matchId: game.id,
      fencingToken: 1,
      playerId: activePlayer,
      clientProtocolVersion: 1,
      command
    });

    expect(commitTransition).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
    const transition = commitTransition.mock.calls[0]![0];
    expect(transition.event.payload.state.revision).toBe(2);
    expect(transition.nextDeadline.expectedRevision).toBe(2);

    coordinator.onPublishedEvent({
      protocolVersion: 1,
      envelopeId: randomUUID(),
      sentAt: new Date().toISOString(),
      kind: "game.event",
      matchId: game.id,
      deliverySemantics: "committed-event-log",
      ownershipFenceAtCommit: 1,
      outboxId: transition.event.eventId,
      eventSequence: 2,
      topic: "game.event",
      routingKey: game.id,
      eventPayload: {
        eventId: transition.event.eventId,
        eventType: command.type,
        matchId: game.id,
        sequence: 2,
        fencingToken: 1,
        payload: transition.event.payload
      }
    });
    expect(send.mock.calls.map(([message]) => JSON.parse(message).type)).toEqual(["game.hand", "game.state"]);

    coordinator.onPublishedEvent({
      protocolVersion: 1,
      envelopeId: randomUUID(),
      sentAt: new Date().toISOString(),
      kind: "game.event",
      matchId: game.id,
      deliverySemantics: "committed-event-log",
      ownershipFenceAtCommit: 1,
      outboxId: randomUUID(),
      eventSequence: 1,
      topic: "game.event",
      routingKey: game.id,
      eventPayload: {
        eventId: randomUUID(),
        eventType: "game.started",
        matchId: game.id,
        sequence: 1,
        fencingToken: 1,
        payload: materialized.eventPayload
      }
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("does not suppress a committed event for a peer when one player hydrates before outbox delivery", async () => {
    const first = randomUUID();
    const second = randomUUID();
    const game = new RankingGame([
      { id: first, displayName: "Asha", badgeId: "rookie" },
      { id: second, displayName: "Bela", badgeId: "strategist" }
    ], () => 0);
    const reconnectingPlayer = game.currentPlayerId;
    const peer = reconnectingPlayer === first ? second : first;
    const commandId = randomUUID();
    expect(game.apply(reconnectingPlayer, {
      type: "game.draw",
      commandId,
      gameId: game.id,
      expectedRevision: 1,
      source: "stock"
    })).toEqual({ accepted: true });
    const snapshot = game.snapshot();
    const eventId = randomUUID();
    const payload = {
      state: snapshot,
      matchType: "general" as const,
      privateRoomCode: null,
      result: { accepted: true as const },
      actorPlayerId: reconnectingPlayer
    };
    const materialized = {
      matchId: game.id,
      publicName: game.publicName,
      playerCount: 2 as const,
      matchType: "general" as const,
      status: "active" as const,
      eventSequence: 2,
      eventType: "game.draw",
      eventPayload: payload,
      participants: snapshot.seats.map((seat, seatNumber) => ({
        playerId: seat.id,
        seatNumber,
        displayName: seat.displayName,
        badgeId: seat.badgeId
      })),
      privateRoomCode: null
    };
    const runtime = {
      getActiveMatchIdForPlayer: vi.fn(async (playerId: string) =>
        playerId === reconnectingPlayer ? game.id : null
      ),
      loadMaterializedGame: vi.fn(async () => materialized),
      getRoute: vi.fn(async () => ({
        matchId: game.id,
        ownerInstanceId: "app-a",
        fencingToken: 1,
        leaseExpiresAt: new Date(Date.now() + 30_000),
        protocolMin: 1,
        protocolMax: 1,
        draining: false
      })),
      getWaitingMatchmakingTicket: vi.fn(async () => null)
    };
    const repository = { listPrivateRoomsForUser: vi.fn(async () => []) };
    const coordinator = new DistributedMatchmaker(
      runtime as never,
      repository as never,
      { routeCommand: vi.fn(), publishPlayerMessage: vi.fn() } as never,
      { track: vi.fn(), forget: vi.fn() } as never,
      "app-a",
      "ap-south-1",
      vi.fn()
    );
    const peerSend = vi.fn();
    const reconnectingSend = vi.fn();
    await coordinator.register({
      playerId: peer,
      displayName: "Peer",
      socket: { readyState: 1, send: peerSend, close: vi.fn() } as never
    });
    await coordinator.register({
      playerId: reconnectingPlayer,
      displayName: "Reconnect",
      socket: { readyState: 1, send: reconnectingSend, close: vi.fn() } as never
    });
    peerSend.mockClear();
    reconnectingSend.mockClear();

    coordinator.onPublishedEvent({
      protocolVersion: 1,
      envelopeId: randomUUID(),
      sentAt: new Date().toISOString(),
      kind: "game.event",
      matchId: game.id,
      deliverySemantics: "committed-event-log",
      ownershipFenceAtCommit: 1,
      outboxId: eventId,
      eventSequence: 2,
      topic: "game.event",
      routingKey: game.id,
      eventPayload: {
        eventId,
        eventType: "game.draw",
        matchId: game.id,
        sequence: 2,
        fencingToken: 1,
        payload
      }
    });

    expect(peerSend.mock.calls.map(([message]) => JSON.parse(message).type)).toEqual(["game.hand", "game.state"]);
    expect(JSON.parse(peerSend.mock.calls.at(-1)![0])).toEqual(expect.objectContaining({ revision: 2 }));
    expect(reconnectingSend).not.toHaveBeenCalled();
  });

  it("reloads reconnect hydration when a newer live event wins the inverse interleaving", async () => {
    const first = randomUUID();
    const second = randomUUID();
    const game = new RankingGame([
      { id: first, displayName: "Asha", badgeId: "rookie" },
      { id: second, displayName: "Bela", badgeId: "strategist" }
    ], () => 0);
    const playerId = game.currentPlayerId;
    expect(game.apply(playerId, {
      type: "game.draw",
      commandId: randomUUID(),
      gameId: game.id,
      expectedRevision: 1,
      source: "stock"
    })).toEqual({ accepted: true });
    const revisionTwo = game.snapshot();
    expect(game.apply(playerId, {
      type: "game.discard",
      commandId: randomUUID(),
      gameId: game.id,
      expectedRevision: 2,
      cardId: game.handFor(playerId)[0]!.id
    })).toEqual({ accepted: true });
    const revisionThree = game.snapshot();
    const payload = (state: typeof revisionTwo, result: { accepted: true }) => ({
      state,
      matchType: "general" as const,
      privateRoomCode: null,
      result,
      actorPlayerId: playerId
    });
    const materialized = (state: typeof revisionTwo, sequence: number, eventType: string) => ({
      matchId: game.id,
      publicName: game.publicName,
      playerCount: 2 as const,
      matchType: "general" as const,
      status: "active" as const,
      eventSequence: sequence,
      eventType,
      eventPayload: payload(state, { accepted: true }),
      participants: state.seats.map((seat, seatNumber) => ({
        playerId: seat.id,
        seatNumber,
        displayName: seat.displayName,
        badgeId: seat.badgeId
      })),
      privateRoomCode: null
    });
    let resolveFirstRead!: (value: ReturnType<typeof materialized>) => void;
    const firstRead = new Promise<ReturnType<typeof materialized>>((resolve) => {
      resolveFirstRead = resolve;
    });
    const loadMaterializedGame = vi.fn()
      .mockImplementationOnce(async () => firstRead)
      .mockResolvedValue(materialized(revisionThree, 3, "game.discard"));
    const runtime = {
      getActiveMatchIdForPlayer: vi.fn(async () => game.id),
      loadMaterializedGame,
      getRoute: vi.fn(async () => ({
        matchId: game.id,
        ownerInstanceId: "app-a",
        fencingToken: 1,
        leaseExpiresAt: new Date(Date.now() + 30_000),
        protocolMin: 1,
        protocolMax: 1,
        draining: false
      }))
    };
    const coordinator = new DistributedMatchmaker(
      runtime as never,
      {} as never,
      {} as never,
      {} as never,
      "app-a",
      "ap-south-1",
      vi.fn()
    );
    const send = vi.fn();
    const registering = coordinator.register({
      playerId,
      displayName: "Asha",
      socket: { readyState: 1, send, close: vi.fn() } as never
    });
    await vi.waitFor(() => expect(loadMaterializedGame).toHaveBeenCalledOnce());

    resolveFirstRead(materialized(revisionTwo, 2, "game.draw"));
    const eventId = randomUUID();
    coordinator.onPublishedEvent({
      protocolVersion: 1,
      envelopeId: randomUUID(),
      sentAt: new Date().toISOString(),
      kind: "game.event",
      matchId: game.id,
      deliverySemantics: "committed-event-log",
      ownershipFenceAtCommit: 1,
      outboxId: eventId,
      eventSequence: 3,
      topic: "game.event",
      routingKey: game.id,
      eventPayload: {
        eventId,
        eventType: "game.discard",
        matchId: game.id,
        sequence: 3,
        fencingToken: 1,
        payload: payload(revisionThree, { accepted: true })
      }
    });
    await registering;

    const messages = send.mock.calls.map(([message]) => JSON.parse(message));
    expect(messages.map(({ type }) => type)).toEqual(["session.ready", "game.hand", "game.state", "game.started"]);
    expect(messages.filter(({ revision }) => revision !== undefined).map(({ revision }) => revision)).toEqual([3, 3]);
    expect(loadMaterializedGame).toHaveBeenCalledTimes(2);
  });

  it("reloads a stale reconnect SELECT after terminal fanout without recreating player watermarks", async () => {
    const first = randomUUID();
    const second = randomUUID();
    const game = new RankingGame([
      { id: first, displayName: "Asha", badgeId: "rookie" },
      { id: second, displayName: "Bela", badgeId: "strategist" }
    ], () => 0);
    const initial = game.snapshot();
    const terminal = game.apply(first, {
      type: "game.drop",
      commandId: randomUUID(),
      gameId: game.id,
      expectedRevision: 1
    });
    expect(terminal).toEqual(expect.objectContaining({ accepted: true, ended: expect.any(Object) }));
    const finished = game.snapshot();
    const materialized = (state: typeof initial, sequence: number, result: typeof terminal | null) => ({
      matchId: game.id,
      publicName: game.publicName,
      playerCount: 2 as const,
      matchType: "general" as const,
      status: result ? "completed" as const : "active" as const,
      eventSequence: sequence,
      eventType: result ? "game.drop" : "game.started",
      eventPayload: {
        state,
        matchType: "general" as const,
        privateRoomCode: null,
        result,
        actorPlayerId: result ? first : null
      },
      participants: state.seats.map((seat, seatNumber) => ({
        playerId: seat.id,
        seatNumber,
        displayName: seat.displayName,
        badgeId: seat.badgeId
      })),
      privateRoomCode: null
    });
    let resolveStaleRead!: (value: ReturnType<typeof materialized>) => void;
    const staleRead = new Promise<ReturnType<typeof materialized>>((resolve) => {
      resolveStaleRead = resolve;
    });
    const loadMaterializedGame = vi.fn()
      .mockImplementationOnce(async () => staleRead)
      .mockResolvedValue(materialized(finished, 2, terminal));
    const runtime = {
      getActiveMatchIdForPlayer: vi.fn(async () => game.id),
      loadMaterializedGame,
      getRoute: vi.fn(async () => ({
        matchId: game.id,
        ownerInstanceId: "app-a",
        fencingToken: 1,
        leaseExpiresAt: new Date(Date.now() + 30_000),
        protocolMin: 1,
        protocolMax: 1,
        draining: false
      }))
    };
    const coordinator = new DistributedMatchmaker(
      runtime as never,
      {} as never,
      {} as never,
      {} as never,
      "app-a",
      "ap-south-1",
      vi.fn()
    );
    const send = vi.fn();
    const registering = coordinator.register({
      playerId: second,
      displayName: "Bela",
      socket: { readyState: 1, send, close: vi.fn() } as never
    });
    await vi.waitFor(() => expect(loadMaterializedGame).toHaveBeenCalledOnce());

    resolveStaleRead(materialized(initial, 1, null));
    const eventId = randomUUID();
    coordinator.onPublishedEvent({
      protocolVersion: 1,
      envelopeId: randomUUID(),
      sentAt: new Date().toISOString(),
      kind: "game.event",
      matchId: game.id,
      deliverySemantics: "committed-event-log",
      ownershipFenceAtCommit: 1,
      outboxId: eventId,
      eventSequence: 2,
      topic: "game.event",
      routingKey: game.id,
      eventPayload: {
        eventId,
        eventType: "game.drop",
        matchId: game.id,
        sequence: 2,
        fencingToken: 1,
        payload: {
          state: finished,
          matchType: "general",
          privateRoomCode: null,
          result: terminal,
          actorPlayerId: first
        }
      }
    });
    await registering;

    const messages = send.mock.calls.map(([message]) => JSON.parse(message));
    expect(messages.filter(({ revision }) => revision !== undefined).map(({ revision }) => revision)).toEqual([2, 2]);
    expect(messages.find(({ type }) => type === "game.started")).toEqual(expect.objectContaining({
      revision: 2,
      phase: "finished"
    }));
    expect(messages.filter(({ type }) => type === "game.ended")).toHaveLength(2);
    expect(loadMaterializedGame).toHaveBeenCalledTimes(2);
    const internal = coordinator as unknown as {
      deliveredEventSequences: Map<string, number>;
      deliveredPlayerEventSequences: Map<string, Map<string, number>>;
    };
    expect(internal.deliveredEventSequences.get(game.id)).toBe(2);
    expect(internal.deliveredPlayerEventSequences.has(game.id)).toBe(false);
  });

  it("sends equal-revision hydration to initialize a replacement socket", async () => {
    const first = randomUUID();
    const second = randomUUID();
    const game = new RankingGame([
      { id: first, displayName: "Asha", badgeId: "rookie" },
      { id: second, displayName: "Bela", badgeId: "strategist" }
    ], () => 0);
    const snapshot = game.snapshot();
    const materialized = {
      matchId: game.id,
      publicName: game.publicName,
      playerCount: 2 as const,
      matchType: "general" as const,
      status: "active" as const,
      eventSequence: 1,
      eventType: "game.started",
      eventPayload: {
        state: snapshot,
        matchType: "general" as const,
        privateRoomCode: null,
        result: null,
        actorPlayerId: null
      },
      participants: snapshot.seats.map((seat, seatNumber) => ({
        playerId: seat.id,
        seatNumber,
        displayName: seat.displayName,
        badgeId: seat.badgeId
      })),
      privateRoomCode: null
    };
    const runtime = {
      getActiveMatchIdForPlayer: vi.fn(async () => game.id),
      loadMaterializedGame: vi.fn(async () => materialized),
      getRoute: vi.fn(async () => ({
        matchId: game.id,
        ownerInstanceId: "app-a",
        fencingToken: 1,
        leaseExpiresAt: new Date(Date.now() + 30_000),
        protocolMin: 1,
        protocolMax: 1,
        draining: false
      }))
    };
    const coordinator = new DistributedMatchmaker(
      runtime as never,
      {} as never,
      {} as never,
      {} as never,
      "app-a",
      "ap-south-1",
      vi.fn()
    );
    const firstSocket = { readyState: 1, send: vi.fn(), close: vi.fn() };
    await coordinator.register({ playerId: first, displayName: "Asha", socket: firstSocket as never });
    const replacementSend = vi.fn();
    await coordinator.register({
      playerId: first,
      displayName: "Asha",
      socket: { readyState: 1, send: replacementSend, close: vi.fn() } as never
    });

    expect(firstSocket.close).toHaveBeenCalledWith(4001, "Session opened in another window");
    expect(replacementSend.mock.calls.map(([message]) => JSON.parse(message).type)).toEqual([
      "session.ready",
      "game.started"
    ]);
    expect(JSON.parse(replacementSend.mock.calls[1]![0])).toEqual(expect.objectContaining({ revision: 1 }));
  });

  it("releases per-player watermarks after terminal fanout while retaining global suppression", () => {
    const first = randomUUID();
    const second = randomUUID();
    const game = new RankingGame([
      { id: first, displayName: "Asha", badgeId: "rookie" },
      { id: second, displayName: "Bela", badgeId: "strategist" }
    ], () => 0);
    const initial = game.snapshot();
    const terminal = game.apply(first, {
      type: "game.drop",
      commandId: randomUUID(),
      gameId: game.id,
      expectedRevision: 1
    });
    expect(terminal).toEqual(expect.objectContaining({ accepted: true, ended: expect.any(Object) }));
    const finished = game.snapshot();
    const coordinator = new DistributedMatchmaker(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      "app-a",
      "ap-south-1",
      vi.fn()
    );
    const firstSend = vi.fn();
    const secondSend = vi.fn();
    const internal = coordinator as unknown as {
      connections: Map<string, unknown>;
      deliveredEventSequences: Map<string, number>;
      deliveredPlayerEventSequences: Map<string, Map<string, number>>;
    };
    internal.connections.set(first, {
      playerId: first,
      displayName: "Asha",
      socket: { readyState: 1, send: firstSend, close: vi.fn() }
    });
    internal.connections.set(second, {
      playerId: second,
      displayName: "Bela",
      socket: { readyState: 1, send: secondSend, close: vi.fn() }
    });
    const terminalEventId = randomUUID();
    coordinator.onPublishedEvent({
      protocolVersion: 1,
      envelopeId: randomUUID(),
      sentAt: new Date().toISOString(),
      kind: "game.event",
      matchId: game.id,
      deliverySemantics: "committed-event-log",
      ownershipFenceAtCommit: 1,
      outboxId: terminalEventId,
      eventSequence: 2,
      topic: "game.event",
      routingKey: game.id,
      eventPayload: {
        eventId: terminalEventId,
        eventType: "game.drop",
        matchId: game.id,
        sequence: 2,
        fencingToken: 1,
        payload: {
          state: finished,
          matchType: "general",
          privateRoomCode: null,
          result: terminal,
          actorPlayerId: first
        }
      }
    });

    expect(internal.deliveredEventSequences.get(game.id)).toBe(2);
    expect(internal.deliveredPlayerEventSequences.has(game.id)).toBe(false);
    firstSend.mockClear();
    secondSend.mockClear();
    const oldEventId = randomUUID();
    coordinator.onPublishedEvent({
      protocolVersion: 1,
      envelopeId: randomUUID(),
      sentAt: new Date().toISOString(),
      kind: "game.event",
      matchId: game.id,
      deliverySemantics: "committed-event-log",
      ownershipFenceAtCommit: 1,
      outboxId: oldEventId,
      eventSequence: 1,
      topic: "game.event",
      routingKey: game.id,
      eventPayload: {
        eventId: oldEventId,
        eventType: "game.started",
        matchId: game.id,
        sequence: 1,
        fencingToken: 1,
        payload: {
          state: initial,
          matchType: "general",
          privateRoomCode: null,
          result: null,
          actorPlayerId: null
        }
      }
    });
    expect(firstSend).not.toHaveBeenCalled();
    expect(secondSend).not.toHaveBeenCalled();
  });

  it("heartbeats local queue tickets in a batch and silently drops tickets already matched elsewhere", async () => {
    const first = randomUUID();
    const second = randomUUID();
    const firstTicket = randomUUID();
    const secondTicket = randomUUID();
    const runtime = {
      heartbeatMatchmakingTickets: vi.fn(async () => [{
        ticketId: firstTicket,
        playerId: first,
        playerCount: 2 as const,
        region: "ap-south-1",
        protocolVersion: 1,
        enqueuedAt: new Date(),
        heartbeatAt: new Date(),
        expiresAt: new Date(Date.now() + 90_000)
      }])
    };
    const reportError = vi.fn();
    const coordinator = new DistributedMatchmaker(
      runtime as never,
      {} as never,
      {} as never,
      {} as never,
      "app-a",
      "ap-south-1",
      reportError
    );
    const socket = { readyState: 1, send: vi.fn(), close: vi.fn() };
    const internal = coordinator as unknown as {
      connections: Map<string, unknown>;
      queueTickets: Map<string, { ticketId: string; playerCount: 2 }>;
      heartbeatTickets(): Promise<void>;
    };
    internal.connections.set(first, { playerId: first, displayName: "Asha", socket });
    internal.connections.set(second, { playerId: second, displayName: "Bela", socket });
    internal.queueTickets.set(first, { ticketId: firstTicket, playerCount: 2 });
    internal.queueTickets.set(second, { ticketId: secondTicket, playerCount: 2 });

    await internal.heartbeatTickets();

    expect(runtime.heartbeatMatchmakingTickets).toHaveBeenCalledWith({
      tickets: [
        { playerId: first, ticketId: firstTicket },
        { playerId: second, ticketId: secondTicket }
      ],
      ttlMs: 90_000
    });
    expect(internal.queueTickets.has(first)).toBe(true);
    expect(internal.queueTickets.has(second)).toBe(false);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("does not overlap a slow matchmaking heartbeat with the next interval", async () => {
    vi.useFakeTimers();
    const playerId = randomUUID();
    const ticketId = randomUUID();
    let finishHeartbeat!: (value: readonly never[]) => void;
    const heartbeat = new Promise<readonly never[]>((resolve) => {
      finishHeartbeat = resolve;
    });
    const runtime = { heartbeatMatchmakingTickets: vi.fn(() => heartbeat) };
    const reportError = vi.fn();
    const coordinator = new DistributedMatchmaker(
      runtime as never,
      {} as never,
      {} as never,
      {} as never,
      "app-a",
      "ap-south-1",
      reportError
    );
    const socket = { readyState: 1, send: vi.fn(), close: vi.fn() };
    const internal = coordinator as unknown as {
      connections: Map<string, unknown>;
      queueTickets: Map<string, { ticketId: string; playerCount: 2 }>;
    };
    internal.connections.set(playerId, { playerId, displayName: "Asha", socket });
    internal.queueTickets.set(playerId, { ticketId, playerCount: 2 });
    await coordinator.restore();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(runtime.heartbeatMatchmakingTickets).toHaveBeenCalledOnce();

    finishHeartbeat([]);
    await vi.advanceTimersByTimeAsync(0);
    await coordinator.shutdown();
    expect(reportError).not.toHaveBeenCalled();
  });
});
