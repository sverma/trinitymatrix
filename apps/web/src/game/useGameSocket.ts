import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Card,
  GamePublicState,
  PlayerCount,
  PrivateInvitation,
  PrivateRoom,
  ServerMessage
} from "@trinitymatrix/protocol";
import { parseServerMessage } from "@trinitymatrix/protocol";
import type { AiPlayerForfeit, RealtimeChatMessage } from "../api";

type ConnectionState = "connecting" | "connected" | "disconnected" | "authentication-required" | "session-replaced";
const heartbeatIntervalMs = 20_000;
const pongTimeoutMs = 10_000;

export function useGameSocket(enabled: boolean, onAuthenticationRequired?: (reason: string) => void) {
  const socketRef = useRef<WebSocket | null>(null);
  const desiredQueue = useRef<PlayerCount | null>(null);
  const reconnectTimer = useRef<number | null>(null);
  const reconnectAttempt = useRef(0);
  const authenticatedPlayerId = useRef<string | null>(null);
  const currentGameName = useRef<string | null>(null);
  const activeGameId = useRef<string | null>(null);
  const lastTechnicalDrop = useRef<AiPlayerForfeit | null>(null);
  const viewedPrivateRoom = useRef<PrivateRoom | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [queue, setQueue] = useState<{ joined: number; required: number; playerCount: PlayerCount } | null>(null);
  const [game, setGame] = useState<GamePublicState | null>(null);
  const [hand, setHand] = useState<Card[]>([]);
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [notice, setNotice] = useState("Connecting to the game service…");
  const [winner, setWinner] = useState<{
    id: string;
    name: string;
    reason: "declaration" | "invalid-declaration" | "player-dropped";
    score?: number | undefined;
    technicalForfeit?: AiPlayerForfeit;
  } | null>(null);
  const [aiForfeits, setAiForfeits] = useState<AiPlayerForfeit[]>([]);
  const [completedGameName, setCompletedGameName] = useState<string | null>(null);
  const [realtimeChatMessages, setRealtimeChatMessages] = useState<RealtimeChatMessage[]>([]);
  const [connectionGeneration, setConnectionGeneration] = useState(0);
  const [privateRoom, setPrivateRoom] = useState<PrivateRoom | null>(null);
  const [privateRoomUpdates, setPrivateRoomUpdates] = useState<PrivateRoom[]>([]);
  const [privateInvitations, setPrivateInvitations] = useState<PrivateInvitation[]>([]);

  const send = useCallback((message: object) => {
    if (socketRef.current?.readyState !== WebSocket.OPEN) {
      setNotice("The game connection is not ready yet.");
      return false;
    }
    socketRef.current.send(JSON.stringify(message));
    return true;
  }, []);

  useEffect(() => {
    if (!enabled) {
      setRealtimeChatMessages([]);
      setConnectionGeneration(0);
      viewedPrivateRoom.current = null;
      activeGameId.current = null;
      lastTechnicalDrop.current = null;
      setAiForfeits([]);
      setPrivateRoom(null);
      setPrivateRoomUpdates([]);
      setPrivateInvitations([]);
      return;
    }
    let stopped = false;
    let heartbeat: number | null = null;
    let pongWatchdog: number | null = null;
    let awaitingPongAt: number | null = null;
    let terminalClose = false;
    let recoveringConnectivity = false;

    const isOnline = () => typeof navigator === "undefined" || navigator.onLine !== false;
    const isVisible = () => typeof document === "undefined" || document.visibilityState !== "hidden";

    const clearReconnectTimer = () => {
      if (reconnectTimer.current !== null) window.clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    };

    const clearPongWait = () => {
      if (pongWatchdog !== null) window.clearTimeout(pongWatchdog);
      pongWatchdog = null;
      awaitingPongAt = null;
    };

    const stopHeartbeat = () => {
      if (heartbeat !== null) window.clearInterval(heartbeat);
      heartbeat = null;
      clearPongWait();
    };

    function scheduleReconnect() {
      if (stopped || terminalClose || reconnectTimer.current !== null) return;
      if (!isOnline()) {
        setNotice("You are offline. Reconnecting when the network returns…");
        return;
      }
      const attempt = reconnectAttempt.current++;
      const delay = Math.min(1_000 * (2 ** attempt), 15_000) + Math.floor(Math.random() * 500);
      reconnectTimer.current = window.setTimeout(() => {
        reconnectTimer.current = null;
        connect();
      }, delay);
    }

    function retireUnresponsiveSocket(socket: WebSocket, reason: string) {
      if (socketRef.current !== socket) return;
      stopHeartbeat();
      socketRef.current = null;
      setConnection("disconnected");
      setNotice("Connection became unresponsive. Reconnecting…");
      try {
        socket.close(4000, reason);
      } catch {
        // The socket is already retired locally; reconnect still proceeds.
      } finally {
        // Do not wait indefinitely for a close handshake from a half-open mobile
        // connection. The retired socket is ignored by its guarded listeners.
        scheduleReconnect();
      }
    }

    const sendHeartbeat = (socket: WebSocket) => {
      if (stopped || terminalClose || socketRef.current !== socket || socket.readyState !== WebSocket.OPEN) return;
      if (!isOnline() || !isVisible() || awaitingPongAt !== null) return;
      const at = Date.now();
      awaitingPongAt = at;
      try {
        socket.send(JSON.stringify({ type: "ping", at }));
      } catch {
        retireUnresponsiveSocket(socket, "Heartbeat send failed");
        return;
      }
      pongWatchdog = window.setTimeout(() => {
        if (socketRef.current !== socket || awaitingPongAt !== at) return;
        if (!isOnline() || !isVisible()) {
          clearPongWait();
          return;
        }
        retireUnresponsiveSocket(socket, "Heartbeat timed out");
      }, pongTimeoutMs);
    };

    const startHeartbeat = (socket: WebSocket) => {
      stopHeartbeat();
      heartbeat = window.setInterval(() => sendHeartbeat(socket), heartbeatIntervalMs);
    };

    function connect() {
      if (stopped || terminalClose) return;
      const current = socketRef.current;
      if (current && current.readyState !== WebSocket.CLOSED) return;
      if (!isOnline()) {
        setConnection("disconnected");
        setNotice("You are offline. Reconnecting when the network returns…");
        return;
      }
      clearReconnectTimer();
      setConnection("connecting");
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
      socketRef.current = socket;
      socket.addEventListener("open", () => {
        setNotice("Authenticating the game connection…");
      });
      socket.addEventListener("message", (event) => {
        if (socketRef.current !== socket) return;
        try {
          const message: ServerMessage = parseServerMessage(JSON.parse(String(event.data)));
          if (message.type === "pong") {
            if (awaitingPongAt === message.at) {
              clearPongWait();
              if (recoveringConnectivity) {
                recoveringConnectivity = false;
                setConnection("connected");
                setNotice("Connected.");
              }
            }
          } else if (message.type === "session.ready") {
            recoveringConnectivity = false;
            reconnectAttempt.current = 0;
            authenticatedPlayerId.current = message.playerId;
            setPlayerId(message.playerId);
            setConnection("connected");
            setConnectionGeneration((current) => current + 1);
            setNotice("Connected.");
            if (desiredQueue.current) socket.send(JSON.stringify({ type: "queue.join", playerCount: desiredQueue.current }));
            startHeartbeat(socket);
          } else if (message.type === "queue.status") {
            setQueue(message);
            setNotice(`${message.joined} of ${message.required} players joined the ${message.playerCount}-player queue.`);
          } else if (message.type === "game.started") {
            const { type: _type, hand: nextHand, ...state } = message;
            if (activeGameId.current !== state.gameId) {
              lastTechnicalDrop.current = null;
              setAiForfeits([]);
            }
            setGame(state);
            activeGameId.current = state.gameId;
            currentGameName.current = state.gameName;
            setCompletedGameName(null);
            setHand(nextHand);
            setQueue(null);
            setWinner(null);
            viewedPrivateRoom.current = null;
            setPrivateRoom(null);
            desiredQueue.current = null;
            setNotice("Match found. Cards have been dealt.");
          } else if (message.type === "game.state") {
            const { type: _type, ...state } = message;
            setGame(state);
          } else if (message.type === "game.hand") {
            setHand(message.hand);
          } else if (message.type === "game.ended") {
            setCompletedGameName(currentGameName.current);
            const technicalForfeit = message.reason === "player-dropped" ? lastTechnicalDrop.current : null;
            setWinner({ id: message.winnerId, name: message.winnerName, reason: message.reason, score: message.score,
              ...(technicalForfeit ? { technicalForfeit } : {}) });
            setNotice(technicalForfeit ? `${message.winnerName} won after ${technicalForfeit.playerName} forfeited. ${technicalForfeit.reason}`
              : `${message.winnerName} won the game${message.score === undefined ? "." : ` with ${message.score} points.`}`);
          } else if (message.type === "game.player-dropped") {
            const technical = message.reasonCode && message.reason ? {
              playerId: message.playerId, playerName: message.playerName, reasonCode: message.reasonCode, reason: message.reason
            } : null;
            lastTechnicalDrop.current = technical;
            if (technical) setAiForfeits((current) => [...current.filter((entry) => entry.playerId !== technical.playerId), technical]);
            setNotice(technical ? `${message.playerName} forfeited. ${technical.reason}` : message.playerId === authenticatedPlayerId.current
              ? "You dropped from the game. Returning to the lobby…"
              : `${message.playerName} dropped from the game.`);
          } else if (message.type === "game.left") {
            setCompletedGameName(currentGameName.current);
            currentGameName.current = null;
            activeGameId.current = null;
            setGame((current) => current?.gameId === message.gameId ? null : current);
            setHand([]);
            setQueue(null);
            setWinner(null);
            desiredQueue.current = null;
            setNotice("You dropped from the game and returned to the lobby.");
          } else if (message.type === "command.rejected" || message.type === "error") {
            setNotice(message.message);
            if (message.type === "command.rejected") {
              setGame((current) => current ? { ...current, revision: message.revision } : current);
            }
          } else if (message.type === "game.declaration-rejected") {
            setNotice(message.playerId === authenticatedPlayerId.current
              ? `Invalid show: ${message.reason} You are now watching the rest of this round.`
              : `${message.playerName} left active play after an invalid show.`);
          } else if (message.type === "chat.message") {
            setRealtimeChatMessages((current) => {
              const event = { gameName: message.gameName, message: message.message };
              const existingIndex = current.findIndex(({ message: existing }) => existing.id === message.message.id);
              if (existingIndex === -1) return [...current, event].slice(-100);
              const next = [...current];
              next[existingIndex] = event;
              return next;
            });
          } else if (message.type === "private.room-status") {
            setPrivateRoomUpdates((current) => {
              const withoutRoom = current.filter(({ roomCode }) => roomCode !== message.room.roomCode);
              return [...withoutRoom, message.room].slice(-50);
            });
            if (message.room.status === "cancelled" || message.room.status === "completed") {
              setPrivateInvitations((current) => current.filter(({ roomCode }) => roomCode !== message.room.roomCode));
            }
            if (viewedPrivateRoom.current?.roomCode === message.room.roomCode) {
              if (message.room.status === "cancelled" || message.room.status === "completed") {
                viewedPrivateRoom.current = null;
                setPrivateRoom(null);
                setNotice(message.room.status === "cancelled"
                  ? "The private table was cancelled."
                  : "The private table has finished.");
              } else {
                viewedPrivateRoom.current = message.room;
                setPrivateRoom(message.room);
                setNotice(message.room.status === "active"
                  ? "Your private table is starting…"
                  : `${message.room.acceptedCount} of ${message.room.requiredCount} private players are ready.`);
              }
            }
          } else if (message.type === "private.invitation") {
            setPrivateInvitations((current) => {
              const withoutInvitation = current.filter(({ roomCode }) => roomCode !== message.invitation.roomCode);
              return [...withoutInvitation, message.invitation].slice(-50);
            });
          }
        } catch {
          setNotice("The server sent an unreadable update. Reconnecting may help.");
        }
      });
      socket.addEventListener("close", (event) => {
        if (socketRef.current !== socket) return;
        stopHeartbeat();
        socketRef.current = null;
        if (!stopped) {
          if (event.code === 4001) {
            terminalClose = true;
            clearReconnectTimer();
            desiredQueue.current = null;
            setQueue(null);
            setGame(null);
            setHand([]);
            authenticatedPlayerId.current = null;
            setPlayerId(null);
            setWinner(null);
            activeGameId.current = null;
            viewedPrivateRoom.current = null;
            setPrivateRoom(null);
            setPrivateRoomUpdates([]);
            setPrivateInvitations([]);
            setConnection("session-replaced");
            setNotice(event.reason || "This account was opened in another window.");
            return;
          }
          if (event.code === 1008) {
            terminalClose = true;
            clearReconnectTimer();
            desiredQueue.current = null;
            setQueue(null);
            setGame(null);
            setHand([]);
            authenticatedPlayerId.current = null;
            setPlayerId(null);
            setWinner(null);
            activeGameId.current = null;
            viewedPrivateRoom.current = null;
            setPrivateRoom(null);
            setPrivateRoomUpdates([]);
            setPrivateInvitations([]);
            setConnection("authentication-required");
            setNotice(event.reason || "Your session is no longer valid.");
            onAuthenticationRequired?.(event.reason || "Authentication required");
            return;
          }
          setConnection("disconnected");
          setNotice(event.code === 4000
            ? "Connection became unresponsive. Reconnecting…"
            : "Connection lost. Reconnecting…");
          scheduleReconnect();
        }
      });
      socket.addEventListener("error", () => socket.close());
    }

    const recoverConnection = () => {
      if (stopped || terminalClose || !isOnline() || !isVisible()) return;
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) {
        sendHeartbeat(socket);
        return;
      }
      if (socket && socket.readyState !== WebSocket.CLOSED) return;
      clearReconnectTimer();
      connect();
    };

    const handleVisibilityChange = () => {
      if (!isVisible()) {
        clearPongWait();
        return;
      }
      recoverConnection();
    };

    const handleOffline = () => {
      clearPongWait();
      if (!terminalClose) {
        recoveringConnectivity = true;
        setConnection("disconnected");
        setNotice("You are offline. Reconnecting when the network returns…");
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("online", recoverConnection);
    window.addEventListener("offline", handleOffline);
    connect();
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("online", recoverConnection);
      window.removeEventListener("offline", handleOffline);
      stopHeartbeat();
      clearReconnectTimer();
      socketRef.current?.close(1000, "Leaving page");
      socketRef.current = null;
    };
  }, [enabled, onAuthenticationRequired]);

  const joinQueue = (playerCount: PlayerCount) => {
    desiredQueue.current = playerCount;
    setQueue({ joined: 0, required: playerCount, playerCount });
    setNotice(`Joining the ${playerCount}-player ranking queue…`);
    send({ type: "queue.join", playerCount });
  };

  const leaveQueue = () => {
    desiredQueue.current = null;
    send({ type: "queue.leave" });
    setQueue(null);
    setNotice("You left matchmaking.");
  };

  const gameCommand = (payload: object) => {
    if (!game) return false;
    return send({
      ...payload,
      commandId: crypto.randomUUID(),
      gameId: game.gameId,
      expectedRevision: game.revision
    });
  };

  const openPrivateRoom = (room: PrivateRoom) => {
    if (activeGameId.current) return;
    if (desiredQueue.current) send({ type: "queue.leave" });
    desiredQueue.current = null;
    setQueue(null);
    viewedPrivateRoom.current = room;
    setPrivateRoom(room);
    setPrivateRoomUpdates((current) => {
      const withoutRoom = current.filter(({ roomCode }) => roomCode !== room.roomCode);
      return [...withoutRoom, room].slice(-50);
    });
    setPrivateInvitations((current) => current.map((invitation) =>
      invitation.roomCode === room.roomCode ? { ...invitation, status: "accepted" } : invitation
    ));
    setNotice(`${room.acceptedCount} of ${room.requiredCount} private players are ready.`);
  };

  const closePrivateRoom = () => {
    viewedPrivateRoom.current = null;
    setPrivateRoom(null);
    setNotice("The private table is still available from your lobby.");
  };

  const removePrivateRoom = (roomCode: string) => {
    if (viewedPrivateRoom.current?.roomCode === roomCode) {
      viewedPrivateRoom.current = null;
      setPrivateRoom(null);
    }
    setPrivateRoomUpdates((current) => current.filter((room) => room.roomCode !== roomCode));
    setPrivateInvitations((current) => current.filter((invitation) => invitation.roomCode !== roomCode));
    setNotice("Private table cancelled.");
  };

  const returnToLobby = () => {
    activeGameId.current = null;
    lastTechnicalDrop.current = null;
    setAiForfeits([]);
    setGame(null);
    setHand([]);
    setWinner(null);
    setQueue(null);
    desiredQueue.current = null;
    setNotice("Returned to the lobby.");
  };

  return {
    connection,
    queue,
    game,
    hand,
    playerId,
    notice,
    winner,
    aiForfeits,
    completedGameName,
    realtimeChatMessages,
    connectionGeneration,
    privateRoom,
    privateRoomUpdates,
    privateInvitations,
    joinQueue,
    leaveQueue,
    returnToLobby,
    openPrivateRoom,
    closePrivateRoom,
    removePrivateRoom,
    clearCompletedGame: () => setCompletedGameName(null),
    draw: (source: "stock" | "discard", layout?: string[][]) => gameCommand({ type: "game.draw", source, ...(layout ? { layout } : {}) }),
    discard: (cardId: string, layout?: string[][]) => gameCommand({ type: "game.discard", cardId, ...(layout ? { layout } : {}) }),
    declare: (discardCardId: string, melds: string[][]) => gameCommand({ type: "game.declare", discardCardId, melds }),
    submitHand: (groups: string[][]) => gameCommand({ type: "game.submit-hand", groups }),
    dropGame: (layout?: string[][]) => gameCommand({ type: "game.drop", ...(layout ? { layout } : {}) })
  };
}
