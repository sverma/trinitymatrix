import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { api, type ChatMessage, type RealtimeChatMessage } from "../api";

const maxMessagesPerPlayer = 3;
const maxMessageLength = 280;
const reconciliationIntervalMs = 30_000;

type ChatHistoryResponse = ChatMessage[] | { messages: ChatMessage[]; remaining?: number; error?: string };

function chatMessages(response: ChatMessage[] | { messages: ChatMessage[] }) {
  return Array.isArray(response) ? response : response.messages;
}

async function fetchChatHistory(gameName: string, signal: AbortSignal): Promise<ChatHistoryResponse> {
  const response = await fetch(`/api/games/${encodeURIComponent(gameName)}/chat`, {
    cache: "no-store",
    credentials: "same-origin",
    signal
  });
  const body = await response.json().catch(() => ({})) as ChatHistoryResponse & { error?: string };
  if (!response.ok) throw new Error(!Array.isArray(body) && body.error ? body.error : "Could not load post-game chat.");
  return body;
}

function messageTime(message: ChatMessage) {
  const timestamp = new Date(message.createdAt).getTime();
  return Number.isNaN(timestamp) ? Number.MAX_SAFE_INTEGER : timestamp;
}

function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]) {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((left, right) =>
    messageTime(left) - messageTime(right) || left.id.localeCompare(right.id)
  );
}

function formatTime(value: number | string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Time unavailable" : date.toLocaleString();
}

function machineTime(value: number | string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function PostGameChat({
  gameName,
  playerId,
  realtimeMessages = [],
  connectionGeneration = 0
}: {
  gameName: string;
  playerId: string;
  realtimeMessages?: readonly RealtimeChatMessage[];
  connectionGeneration?: number;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [serverRemaining, setServerRemaining] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [reconciliationError, setReconciliationError] = useState("");
  const [notice, setNotice] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const knownMessageIds = useRef(new Set<string>());
  const hasReconciled = useRef(false);
  const pendingSubmission = useRef<{ message: string; clientMessageId: string } | null>(null);

  useEffect(() => {
    knownMessageIds.current.clear();
    hasReconciled.current = false;
    setAnnouncement("");
  }, [gameName]);

  useEffect(() => {
    let disposed = false;
    let pollingTimer: number | null = null;
    let requestInFlight = false;
    let activeRequest: AbortController | null = null;

    const canReconcile = () => document.visibilityState === "visible" && navigator.onLine !== false;
    const stopPolling = () => {
      if (pollingTimer !== null) window.clearInterval(pollingTimer);
      pollingTimer = null;
    };
    const pauseReconciliation = () => {
      stopPolling();
      activeRequest?.abort();
      activeRequest = null;
      requestInFlight = false;
    };

    const reconcile = async () => {
      if (disposed || !canReconcile() || requestInFlight) return;
      requestInFlight = true;
      const request = new AbortController();
      activeRequest = request;
      const reportFailure = !hasReconciled.current;
      try {
        const response = await fetchChatHistory(gameName, request.signal);
        if (disposed || request.signal.aborted) return;
        const incoming = chatMessages(response);
        let newestUnannounced: ChatMessage | null = null;
        for (const message of incoming) {
          const isNew = !knownMessageIds.current.has(message.id);
          knownMessageIds.current.add(message.id);
          if (hasReconciled.current && isNew && message.playerId !== playerId) newestUnannounced = message;
        }
        setMessages((current) => mergeMessages(current, incoming));
        if (!Array.isArray(response) && typeof response.remaining === "number") setServerRemaining(response.remaining);
        if (newestUnannounced) {
          setAnnouncement(`New message from ${newestUnannounced.displayName}: ${newestUnannounced.message}`);
        }
        hasReconciled.current = true;
        setReconciliationError("");
      } catch (reason) {
        if (!disposed && !request.signal.aborted && reportFailure) {
          setReconciliationError(reason instanceof Error ? reason.message : "Could not load post-game chat.");
        }
      } finally {
        if (activeRequest !== request) return;
        activeRequest = null;
        requestInFlight = false;
        if (!disposed && !request.signal.aborted && reportFailure) setLoading(false);
      }
    };

    const startPolling = () => {
      stopPolling();
      if (!canReconcile()) return;
      pollingTimer = window.setInterval(() => {
        if (!canReconcile()) {
          pauseReconciliation();
          return;
        }
        void reconcile();
      }, reconciliationIntervalMs);
    };
    const refreshAndRestartPolling = () => {
      if (!canReconcile()) {
        pauseReconciliation();
        return;
      }
      void reconcile();
      startPolling();
    };
    const handleVisibilityChange = () => refreshAndRestartPolling();
    const handleFocus = () => refreshAndRestartPolling();
    const handleOnline = () => refreshAndRestartPolling();
    const handleOffline = () => pauseReconciliation();

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleFocus);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    refreshAndRestartPolling();

    return () => {
      disposed = true;
      pauseReconciliation();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, [connectionGeneration, gameName, playerId]);

  useEffect(() => {
    const incoming = realtimeMessages
      .filter((event) => event.gameName === gameName)
      .map((event) => event.message);
    if (incoming.length === 0) return;
    setLoading(false);
    setMessages((current) => mergeMessages(current, incoming));

    let newestUnannounced: ChatMessage | null = null;
    for (const message of incoming) {
      if (knownMessageIds.current.has(message.id)) continue;
      knownMessageIds.current.add(message.id);
      if (message.playerId !== playerId) newestUnannounced = message;
    }
    if (newestUnannounced) setAnnouncement(`New message from ${newestUnannounced.displayName}: ${newestUnannounced.message}`);
  }, [gameName, playerId, realtimeMessages]);

  const sentCount = useMemo(
    () => messages.filter((message) => message.playerId === playerId).length,
    [messages, playerId]
  );
  const remaining = Math.max(0, Math.min(maxMessagesPerPlayer - sentCount, serverRemaining ?? maxMessagesPerPlayer));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const message = draft.trim();
    setError("");
    setNotice("");
    if (!message) {
      setError("Write a message before sending.");
      return;
    }
    if (message.length > maxMessageLength) {
      setError(`Messages cannot be longer than ${maxMessageLength} characters.`);
      return;
    }
    if (remaining === 0) {
      setError("You have used all 3 post-game messages for this game.");
      return;
    }
    setSending(true);
    try {
      const clientMessageId = pendingSubmission.current?.message === message
        ? pendingSubmission.current.clientMessageId
        : crypto.randomUUID();
      pendingSubmission.current = { message, clientMessageId };
      const response = await api.postGameChat(gameName, message, clientMessageId);
      if ("messages" in response) setMessages((current) => mergeMessages(current, response.messages));
      else setMessages((current) => mergeMessages(current, [response.message]));
      if (typeof response.remaining === "number") setServerRemaining(response.remaining);
      pendingSubmission.current = null;
      setDraft("");
      setNotice("Message sent.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not send your message.");
    } finally {
      setSending(false);
    }
  };

  return <section className="portal-panel chat-panel" aria-labelledby="chat-title">
    <div className="section-heading">
      <div>
        <span className="eyebrow">Post-game chat</span>
        <h2 id="chat-title">Good game, in three messages</h2>
      </div>
      <span className="status-pill">{remaining} of 3 left</span>
    </div>
    <p className="section-description">Each player may send up to three messages after the game. Keep it friendly and table-focused.</p>
    <p className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">{announcement}</p>
    {reconciliationError && <p className="form-error compact-error" role="alert">{reconciliationError}</p>}

    {loading ? <p className="loading-inline" role="status">Loading messages…</p> : messages.length === 0
      ? <p className="empty-chat">No messages yet. You can be the first to say good game.</p>
      : <ol className="chat-messages" aria-label="Post-game messages">
        {messages.map((message) => <li key={message.id} className={message.playerId === playerId ? "mine" : ""}>
          <div><strong>{message.displayName}</strong><time dateTime={machineTime(message.createdAt)}>{formatTime(message.createdAt)}</time></div>
          <p>{message.message}</p>
        </li>)}
      </ol>}

    <form className="chat-composer" onSubmit={submit}>
      <label htmlFor={`chat-message-${gameName}`}>Your message</label>
      <textarea
        id={`chat-message-${gameName}`}
        rows={3}
        maxLength={maxMessageLength}
        value={draft}
        disabled={sending || remaining === 0}
        aria-describedby={`chat-count-${gameName} chat-error-${gameName}`}
        aria-invalid={Boolean(error)}
        onChange={(event) => {
          setDraft(event.target.value);
          pendingSubmission.current = null;
          setError("");
          setNotice("");
        }}
      />
      <div className="composer-meta">
        <span id={`chat-count-${gameName}`}>{draft.length} / {maxMessageLength} characters</span>
        <span>{sentCount} of 3 messages sent</span>
      </div>
      <p id={`chat-error-${gameName}`} className="form-error compact-error" role={error ? "alert" : undefined}>{error}</p>
      <p className="form-notice" role="status">{notice}</p>
      <button className="primary" disabled={sending || remaining === 0}>{sending ? "Sending…" : remaining === 0 ? "Message limit reached" : "Send message"}</button>
    </form>
  </section>;
}
