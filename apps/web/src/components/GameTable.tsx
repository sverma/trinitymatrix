import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode
} from "react";
import { profileBadges, type Card, type GamePublicState } from "@trinitymatrix/protocol";
import { cardLabel, validateDeclaration, validateMeld } from "@trinitymatrix/game-domain";
import {
  getTurnSoundsEnabled,
  playTurnEnded,
  playTurnStarted,
  setTurnSoundsEnabled,
  unlockTurnSounds
} from "../audio/turnSounds";

const suitSymbols = { clubs: "♣", diamonds: "♦", hearts: "♥", spades: "♠" } as const;
const suitOrder = ["spades", "diamonds", "clubs", "hearts", "joker"] as const;
const badgeSymbols = new Map(profileBadges.map(({ id, symbol }) => [id, symbol]));

type HandLayout = {
  gameId: string;
  groups: string[][];
  showCardId: string | null;
};

type MeldStatus = {
  kind: "incomplete" | "invalid" | "trinity" | "meld";
  label: string;
};

function getMeldStatus(cards: readonly Card[], wildRank: number): MeldStatus {
  if (cards.length < 3) return { kind: "incomplete", label: "Incomplete · need 3+" };

  const result = validateMeld(cards, wildRank);
  if (result.validTotals.includes(21)) return { kind: "trinity", label: "Trinity · 21" };
  if (result.valid) return { kind: "meld", label: `Valid · ${result.total}` };
  return { kind: "invalid", label: "Invalid meld" };
}

function cardAsset(card: Card): string {
  if (card.printedJoker) return `/assets/cards/${card.deck % 2 ? "red" : "black"}_of_jokers.png`;
  const names: Record<number, string> = { 1: "ace", 11: "jack", 12: "queen", 13: "king" };
  return `/assets/cards/${names[card.rank!] ?? card.rank}_of_${card.suit}.png`;
}

function rankLabel(rank: number): string {
  return ({ 1: "A", 11: "J", 12: "Q", 13: "K" } as Record<number, string>)[rank] ?? String(rank);
}

function layoutStorageKey(gameId: string, playerId: string): string {
  return `trinitymatrix:hand-layout:${gameId}:${playerId}`;
}

function reconcileLayout(layout: HandLayout, hand: readonly Card[]): HandLayout {
  const handIds = new Set(hand.map(({ id }) => id));
  const showCardId = layout.showCardId && handIds.has(layout.showCardId) ? layout.showCardId : null;
  const used = new Set<string>();
  const groups = layout.groups
    .map((group) => group.filter((id) => {
      if (!handIds.has(id) || id === showCardId || used.has(id)) return false;
      used.add(id);
      return true;
    }))
    .filter((group) => group.length > 0);
  const added = hand.map(({ id }) => id).filter((id) => id !== showCardId && !used.has(id));
  if (added.length > 0) {
    if (groups.length === 0) groups.push(added);
    else groups[groups.length - 1]!.push(...added);
  }
  return { gameId: layout.gameId, groups, showCardId };
}

function groupsForSubmission(layout: HandLayout, hand: readonly Card[]): string[][] {
  const handIds = new Set(hand.map(({ id }) => id));
  const seen = new Set<string>();
  const groups = layout.groups
    .map((group) => group.filter((id) => {
      if (!handIds.has(id) || seen.has(id)) return false;
      seen.add(id);
      return true;
    }))
    .filter((group) => group.length > 0);
  const missing = hand.map(({ id }) => id).filter((id) => !seen.has(id));
  if (missing.length > 0) {
    if (groups.length === 0) groups.push(missing);
    else groups[groups.length - 1]!.push(...missing);
  }
  return groups;
}

function loadLayout(gameId: string, playerId: string, hand: readonly Card[]): HandLayout {
  const fallback = { gameId, groups: [hand.map(({ id }) => id)], showCardId: null };
  try {
    const saved = window.sessionStorage.getItem(layoutStorageKey(gameId, playerId));
    if (!saved) return fallback;
    const value = JSON.parse(saved) as Partial<HandLayout>;
    if (!Array.isArray(value.groups)) return fallback;
    return reconcileLayout({
      gameId,
      groups: value.groups.filter(Array.isArray).map((group) => group.filter((id): id is string => typeof id === "string")),
      showCardId: typeof value.showCardId === "string" ? value.showCardId : null
    }, hand);
  } catch {
    return fallback;
  }
}

function PlayingCard({
  card,
  wild,
  selected,
  disabled,
  onToggle,
  onMove,
  onDragStart,
  onDrop
}: {
  card: Card;
  wild: boolean;
  selected: boolean;
  disabled: boolean;
  onToggle: () => void;
  onMove: (direction: "left" | "right") => void;
  onDragStart: (event: DragEvent<HTMLButtonElement>) => void;
  onDrop: (event: DragEvent<HTMLButtonElement>, position: "before" | "after") => void;
}) {
  const red = card.suit === "diamonds" || card.suit === "hearts";
  return <button
    type="button"
    className={`playing-card ${selected ? "selected" : ""}`}
    aria-pressed={selected}
    aria-label={`${cardLabel(card)}${wild ? ", wild joker" : ""}${selected ? ", selected" : ""}. Use left and right arrow keys to rearrange.`}
    disabled={disabled}
    draggable={!disabled}
    onClick={onToggle}
    onKeyDown={(event) => {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        onMove(event.key === "ArrowLeft" ? "left" : "right");
      }
    }}
    onDragStart={onDragStart}
    onDragOver={(event) => event.preventDefault()}
    onDrop={(event) => {
      event.preventDefault();
      event.stopPropagation();
      const bounds = event.currentTarget.getBoundingClientRect();
      onDrop(event, event.clientX < bounds.left + bounds.width / 2 ? "before" : "after");
    }}
  >
    <img src={cardAsset(card)} alt="" draggable={false} />
    <span className={red ? "red-suit" : "black-suit"} aria-hidden="true">
      {card.printedJoker ? "J" : `${rankLabel(card.rank!)}${card.suit ? suitSymbols[card.suit] : ""}`}
    </span>
    {wild && <span className="wild-marker" aria-hidden="true">Wild</span>}
    {selected && <span className="selection-marker" aria-hidden="true">✓</span>}
  </button>;
}

function GameDialog({
  wrapperClassName = "",
  panelClassName,
  labelledBy,
  describedBy,
  onClose,
  children
}: {
  wrapperClassName?: string;
  panelClassName: string;
  labelledBy: string;
  describedBy?: string;
  onClose?: () => void;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const wrapper = dialogRef.current?.parentElement;
    const siblings = wrapper?.parentElement
      ? [...wrapper.parentElement.children].filter((element) => element !== wrapper && element instanceof HTMLElement) as HTMLElement[]
      : [];
    const previousOverflow = document.body.style.overflow;
    const previousInert = siblings.map((element) => element.inert);
    siblings.forEach((element) => { element.inert = true; });
    document.body.style.overflow = "hidden";
    const initialFocus = dialogRef.current?.querySelector<HTMLElement>("[data-dialog-initial-focus]") ?? dialogRef.current;
    initialFocus?.focus();

    return () => {
      siblings.forEach((element, index) => { element.inert = previousInert[index] ?? false; });
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && onClose) {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
      "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex='-1'])"
    ) ?? [])];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) {
      event.preventDefault();
      dialogRef.current?.focus();
      return;
    }
    if (document.activeElement === dialogRef.current) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return <div className={`modal-backdrop ${wrapperClassName}`.trim()} role="presentation">
    <section
      ref={dialogRef}
      className={panelClassName}
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
    >{children}</section>
  </div>;
}

function TossOverlay({ game, onComplete }: { game: GamePublicState; onComplete: () => void }) {
  const winner = game.players.find(({ id }) => id === game.toss?.winnerId);
  return <GameDialog wrapperClassName="toss-backdrop" panelClassName="toss-panel" labelledBy="toss-result-title" onClose={onComplete}>
      <span className="eyebrow">The toss</span>
      <div className="toss-cards" aria-hidden="true">
        {game.toss?.cards.map(({ playerId, card }, index) => <div key={playerId} className={playerId === game.toss?.winnerId ? "toss-winner" : ""} style={{ "--toss-index": index } as CSSProperties}>
          <img src={cardAsset(card)} alt="" />
          <span>{game.players.find(({ id }) => id === playerId)?.displayName}</span>
        </div>)}
      </div>
      <h2 id="toss-result-title">{winner?.displayName ?? "A player"} won the toss</h2>
      <p>They make the first move.</p>
      <button type="button" className="text-button" data-dialog-initial-focus onClick={onComplete}>Skip animation</button>
  </GameDialog>;
}

export function GameTable({
  game,
  hand,
  playerId,
  notice,
  winner,
  onDraw,
  onDiscard,
  onDeclare,
  onSubmitHand,
  onDropGame,
  onReturnToLobby
}: {
  game: GamePublicState;
  hand: Card[];
  playerId: string;
  notice: string;
  winner: {
    id: string;
    name: string;
    reason: "declaration" | "invalid-declaration" | "player-dropped";
    score?: number | undefined;
  } | null;
  onDraw: (source: "stock" | "discard", layout: string[][]) => void;
  onDiscard: (cardId: string, layout: string[][]) => void;
  onDeclare: (discardCardId: string, melds: string[][]) => void;
  onSubmitHand: (groups: string[][]) => boolean;
  onDropGame: (layout: string[][]) => boolean;
  onReturnToLobby: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [layout, setLayout] = useState<HandLayout>(() => loadLayout(game.gameId, playerId, hand));
  const [pendingShowId, setPendingShowId] = useState<string | null>(null);
  const [showToss, setShowToss] = useState(false);
  const [confirmDrop, setConfirmDrop] = useState(false);
  const [dropRequested, setDropRequested] = useState(false);
  const [dismissedShowdownKey, setDismissedShowdownKey] = useState<string | null>(null);
  const [turnSoundsEnabled, setTurnSoundsState] = useState(getTurnSoundsEnabled);
  const previousTurnOwner = useRef<string | null>(null);
  const handHeadingRef = useRef<HTMLHeadingElement>(null);
  const countdownEndsAt = game.phase === "showdown" && game.showdown ? game.showdown.endsAt : game.turnEndsAt;
  const [clockNow, setClockNow] = useState(Date.now);
  const clock = {
    seconds: Math.max(0, Math.ceil((countdownEndsAt - clockNow) / 1000)),
    progress: Math.min(100, Math.max(0, (1 - (countdownEndsAt - clockNow) / 45_000) * 100))
  };
  const byId = useMemo(() => new Map(hand.map((card) => [card.id, card])), [hand]);
  const currentLayout = layout.gameId === game.gameId ? layout : loadLayout(game.gameId, playerId, hand);
  const selectedIds = [...selected].filter((id) => byId.has(id) && id !== currentLayout.showCardId);
  const self = game.players.find(({ id }) => id === playerId);
  const isPlaying = self?.status === "playing";
  const isMyTurn = game.phase === "playing" && game.currentPlayerId === playerId && isPlaying;
  const showdown = game.phase === "showdown" ? game.showdown : null;
  const showdownKey = showdown ? `${game.gameId}:${showdown.declarerId}` : null;
  const isShowdownResponder = Boolean(showdown?.pendingPlayerIds.includes(playerId));
  const hasSubmittedShowdown = Boolean(showdown?.submittedPlayerIds.includes(playerId));
  const isShowdownDeclarer = showdown?.declarerId === playerId;
  const showdownFinalizing = Boolean(showdown && (clock.seconds === 0 || showdown.pendingPlayerIds.length === 0));
  const hasCompleteShowdownHand = hand.length === 13;
  const canArrangeHand = Boolean(!winner && isPlaying && (
    game.phase === "playing" || (isShowdownResponder && !showdownFinalizing && hasCompleteShowdownHand)
  ));
  const hasDrawn = hand.length === 14;
  const handControlsDisabled = !canArrangeHand;
  const declarationResult = currentLayout.showCardId
    ? validateDeclaration(hand, currentLayout.showCardId, currentLayout.groups, game.wildRank)
    : null;
  const canDeclare = isMyTurn && hasDrawn && declarationResult?.valid === true;

  useEffect(() => {
    setLayout((current) => current.gameId === game.gameId
      ? reconcileLayout(current, hand)
      : loadLayout(game.gameId, playerId, hand));
    const currentIds = new Set(hand.map(({ id }) => id));
    setSelected((current) => new Set([...current].filter((id) => currentIds.has(id))));
  }, [game.gameId, hand, playerId]);

  useEffect(() => setDropRequested(false), [game.revision]);

  useEffect(() => {
    const previous = previousTurnOwner.current;
    previousTurnOwner.current = game.currentPlayerId;
    if (game.phase !== "playing" || winner || !isPlaying) return;
    if (game.currentPlayerId === playerId && previous !== playerId) {
      playTurnStarted(`${game.gameId}:${game.currentPlayerId}:${game.turnEndsAt}`);
    } else if (previous === playerId && game.currentPlayerId !== playerId) {
      playTurnEnded(`${game.gameId}:${previous}:${game.currentPlayerId}:${game.turnEndsAt}`);
    }
  }, [game.currentPlayerId, game.gameId, game.phase, game.turnEndsAt, isPlaying, playerId, winner]);

  useEffect(() => {
    if (layout.gameId !== game.gameId) return;
    window.sessionStorage.setItem(layoutStorageKey(game.gameId, playerId), JSON.stringify(layout));
  }, [game.gameId, layout, playerId]);

  useEffect(() => {
    const key = `trinitymatrix:toss-seen:${game.gameId}`;
    if (!game.toss || window.sessionStorage.getItem(key)) {
      setShowToss(false);
      return;
    }
    window.sessionStorage.setItem(key, "1");
    setShowToss(true);
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const timer = window.setTimeout(() => setShowToss(false), reducedMotion ? 900 : 3_200);
    return () => window.clearTimeout(timer);
  }, [game.gameId, game.toss]);

  useEffect(() => {
    const update = () => setClockNow(Date.now());
    update();
    const timer = window.setInterval(update, 250);
    return () => window.clearInterval(timer);
  }, [countdownEndsAt]);

  const updateGroups = (updater: (groups: string[][]) => string[][]) => {
    setLayout((current) => current.gameId === game.gameId
      ? { ...current, groups: updater(current.groups).filter((group) => group.length > 0) }
      : current);
  };

  const toggle = (cardId: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(cardId)) next.delete(cardId); else next.add(cardId);
    return next;
  });

  const createGroup = () => {
    if (selectedIds.length === 0) return;
    const selectedSet = new Set(selectedIds);
    const ordered = currentLayout.groups.flat().filter((id) => selectedSet.has(id));
    updateGroups((groups) => [...groups.map((group) => group.filter((id) => !selectedSet.has(id))), ordered]);
    setSelected(new Set());
  };

  const sortBySuit = () => {
    const cardOrder = currentLayout.groups.flat().map((id) => byId.get(id)).filter((card): card is Card => Boolean(card));
    const groups = suitOrder.map((suit) => cardOrder
      .filter((card) => suit === "joker" ? card.printedJoker : !card.printedJoker && card.suit === suit)
      .map(({ id }) => id)).filter((group) => group.length > 0);
    updateGroups(() => groups);
    setSelected(new Set());
  };

  const moveCard = (cardId: string, direction: "left" | "right") => updateGroups((groups) => {
    const next = groups.map((group) => [...group]);
    const groupIndex = next.findIndex((group) => group.includes(cardId));
    if (groupIndex < 0) return next;
    const cardIndex = next[groupIndex]!.indexOf(cardId);
    const delta = direction === "left" ? -1 : 1;
    const withinGroup = cardIndex + delta;
    if (withinGroup >= 0 && withinGroup < next[groupIndex]!.length) {
      [next[groupIndex]![cardIndex], next[groupIndex]![withinGroup]] = [next[groupIndex]![withinGroup]!, cardId];
      return next;
    }
    const nextGroupIndex = groupIndex + delta;
    if (nextGroupIndex < 0 || nextGroupIndex >= next.length) return next;
    next[groupIndex]!.splice(cardIndex, 1);
    if (direction === "left") next[nextGroupIndex]!.push(cardId);
    else next[nextGroupIndex]!.unshift(cardId);
    return next;
  });

  const placeCard = (cardId: string, targetId: string, position: "before" | "after") => {
    if (!byId.has(cardId) || cardId === targetId) return;
    updateGroups((groups) => {
      const next = groups.map((group) => group.filter((id) => id !== cardId)).filter((group) => group.length > 0);
      const groupIndex = next.findIndex((group) => group.includes(targetId));
      if (groupIndex < 0) return groups;
      const targetIndex = next[groupIndex]!.indexOf(targetId);
      next[groupIndex]!.splice(targetIndex + (position === "after" ? 1 : 0), 0, cardId);
      return next;
    });
  };

  const placeAtGroupEnd = (cardId: string, anchorId: string | undefined, fallbackIndex: number) => {
    if (!byId.has(cardId)) return;
    updateGroups((groups) => {
      const next = groups.map((group) => group.filter((id) => id !== cardId)).filter((group) => group.length > 0);
      const groupIndex = anchorId ? next.findIndex((group) => group.includes(anchorId)) : Math.min(fallbackIndex, next.length - 1);
      if (groupIndex < 0) return [[cardId]];
      next[groupIndex]!.push(cardId);
      return next;
    });
  };

  const stageShow = (cardId: string) => {
    if (!isMyTurn || !hasDrawn || handControlsDisabled || !byId.has(cardId)) return;
    setPendingShowId(cardId);
  };

  const confirmShow = () => {
    if (!pendingShowId) return;
    const cardId = pendingShowId;
    setLayout((current) => ({
      ...current,
      showCardId: cardId,
      groups: current.groups.map((group) => group.filter((id) => id !== cardId)).filter((group) => group.length > 0)
    }));
    setPendingShowId(null);
    setSelected(new Set());
  };

  const cancelStagedShow = () => setLayout((current) => {
    if (!current.showCardId) return current;
    const groups = current.groups.map((group) => [...group]);
    if (groups.length === 0) groups.push([current.showCardId]); else groups[groups.length - 1]!.push(current.showCardId);
    return { ...current, showCardId: null, groups };
  });

  const opponents = game.players.filter(({ id }) => id !== playerId);
  const aiPlayers = game.players.filter((player) => player.actorKind === "ai");
  const rankedTableLabel = aiPlayers.length === 0 ? "General" : aiPlayers.length === game.players.length ? "AI" : "Mixed";
  const currentName = game.players.find(({ id }) => id === game.currentPlayerId)?.displayName ?? "Current player";
  const showCard = currentLayout.showCardId ? byId.get(currentLayout.showCardId) : null;
  const pendingShowCard = pendingShowId ? byId.get(pendingShowId) : null;
  const declarerName = game.players.find(({ id }) => id === showdown?.declarerId)?.displayName ?? "A player";
  const showShowdownPrompt = Boolean(
    showdownKey && isShowdownResponder && !showdownFinalizing && dismissedShowdownKey !== showdownKey && !winner
  );
  const showdownWaitingCount = showdown?.pendingPlayerIds.length ?? 0;
  const showdownHeader = showdownFinalizing
    ? "Finalizing result"
    : isShowdownResponder
      ? "Arrange your hand"
      : showdownWaitingCount > 0
        ? `Waiting for ${showdownWaitingCount} ${showdownWaitingCount === 1 ? "player" : "players"}`
        : "Finalizing result";

  return <main id="main-content" className={`game-shell ${isMyTurn ? "my-turn" : ""} ${showdown ? "showdown" : ""}`.trim()}>
    <header className="game-header">
      <div><span className="eyebrow">{game.matchType === "private" ? "Private · unranked" : `${rankedTableLabel} · ranked`} · {game.playerCount} players</span><strong>Table {game.gameId.slice(0, 8)}</strong></div>
      <div className="game-header-actions">
        <div className="turn-status">
          <span className="turn-owner" aria-live="polite">{showdown
            ? showdownHeader
            : game.phase === "finished"
              ? "Round complete"
              : !isPlaying
                ? "Watching round"
                : isMyTurn
                  ? "Your turn"
                  : `${currentName}'s turn`}</span>
          {game.phase === "playing" && <span
            className="turn-timer"
            role="timer"
            aria-live="off"
            aria-label={`${clock.seconds} seconds remaining`}
            style={{ "--turn-remaining": `${100 - clock.progress}%` } as CSSProperties}
          ><span>{clock.seconds}s</span></span>}
          {showdown && !showdownFinalizing && <span
            className="turn-timer showdown-timer"
            role="timer"
            aria-live="off"
            aria-label={`${clock.seconds} seconds to arrange and submit hands`}
            style={{ "--turn-remaining": `${100 - clock.progress}%` } as CSSProperties}
          ><span>{clock.seconds}s</span></span>}
          {showdownFinalizing && <span className="showdown-finalizing" aria-hidden="true">Result</span>}
        </div>
        <button
          type="button"
          className="sound-toggle"
          aria-label="Turn sounds"
          aria-pressed={turnSoundsEnabled}
          title={turnSoundsEnabled ? "Mute turn sounds" : "Enable turn sounds"}
          onClick={() => {
            const enabled = !turnSoundsEnabled;
            setTurnSoundsEnabled(enabled);
            setTurnSoundsState(enabled);
            if (enabled) {
              void unlockTurnSounds().then((unlocked) => {
                if (unlocked) playTurnStarted(`preview:${Date.now()}`);
              });
            }
          }}
        >
          <span aria-hidden="true">{turnSoundsEnabled ? "🔔" : "🔕"}</span>
          <span>Sound</span>
        </button>
        {game.phase === "playing" && isPlaying && !winner && <button type="button" className="drop-game-button" onClick={() => setConfirmDrop(true)}>Drop game</button>}
      </div>
    </header>

    {aiPlayers.length > 0 && <details className="ai-table-models">
      <summary>AI players and models</summary>
      <ul>{aiPlayers.map((player) => <li key={player.id}><strong>{player.displayName}</strong><span>AI player</span><code>{player.aiModelId ?? "Model unavailable"}</code></li>)}</ul>
      <p>Results at this table count toward {rankedTableLabel.toLowerCase()}-match ratings.</p>
    </details>}

    <section className="table-surface" aria-label="Trinity table">
      <ol className={`opponent-list opponents-${opponents.length}`} aria-label="Other players">
        {opponents.map((player, index) => <li key={player.id} className={`${game.phase === "playing" && player.id === game.currentPlayerId ? "active" : ""} ${player.status === "dropped" ? "dropped" : player.status === "declared" ? "declared" : ""}`} aria-label={`${player.displayName}, ${player.actorKind === "ai" ? `AI player using ${player.aiModelId ?? "a configured model"}, ` : ""}${game.phase === "playing" && player.id === game.currentPlayerId ? "current turn, " : ""}${player.status === "dropped" ? "dropped" : player.status === "declared" ? "declared" : showdown?.pendingPlayerIds.includes(player.id) ? "arranging hand" : showdown?.submittedPlayerIds.includes(player.id) ? "hand submitted" : player.connected ? `${player.cardCount} cards` : "reconnecting"}`} style={{ "--seat": index } as CSSProperties}>
          <span className="avatar" aria-hidden="true">{badgeSymbols.get(player.badgeId) ?? "🌱"}</span>
          <span>{player.displayName}{player.actorKind === "ai" && <small className="ai-table-badge">AI player</small>}<small>{player.status === "dropped" ? "Dropped" : player.status === "declared" ? "Declared" : showdown?.pendingPlayerIds.includes(player.id) ? "Arranging hand" : showdown?.submittedPlayerIds.includes(player.id) ? "Hand submitted" : game.phase === "playing" && player.id === game.currentPlayerId ? "Playing now" : player.connected ? `${player.cardCount} cards` : "Reconnecting"}</small></span>
        </li>)}
      </ol>

      <div className="deck-zone">
        <div className="deck-stack">
          <button className="deck-button stock" aria-label={`Closed deck, ${game.stockCount} cards`} disabled={game.phase !== "playing" || !isMyTurn || hasDrawn || Boolean(winner) || showToss} onClick={() => onDraw("stock", groupsForSubmission(currentLayout, hand))}>
            <img className="card-back" src="/assets/trinity-card-back.png" alt="" />
            <span>Closed deck<small>{game.stockCount} cards</small></span>
          </button>
          <div className="wild-card" aria-label={`${rankLabel(game.wildRank)} is the wild joker`}><span>Joker</span><strong>{rankLabel(game.wildRank)}</strong></div>
        </div>
        <button className="deck-button discard-pile" aria-label={`Open deck${game.topDiscard ? `, ${cardLabel(game.topDiscard)}` : ", empty"}`} disabled={game.phase !== "playing" || !isMyTurn || hasDrawn || !game.topDiscard || Boolean(winner) || showToss} onClick={() => onDraw("discard", groupsForSubmission(currentLayout, hand))}>
          {game.topDiscard ? <img src={cardAsset(game.topDiscard)} alt="" /> : <span className="empty-card" aria-hidden="true" />}
          <span>Open deck<small>{game.topDiscard ? cardLabel(game.topDiscard) : "Empty"}</small></span>
        </button>
        <button
          type="button"
          className={`show-slot ${showCard ? "filled" : ""}`}
          disabled={game.phase !== "playing" || !isMyTurn || !hasDrawn || handControlsDisabled || Boolean(winner)}
          aria-label={showCard ? `${cardLabel(showCard)} staged to show` : "Show here. Select or drag your final discard."}
          onClick={() => {
            if (showCard) cancelStagedShow();
            else if (selectedIds.length === 1) stageShow(selectedIds[0]!);
          }}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => { event.preventDefault(); stageShow(event.dataTransfer.getData("text/plain")); }}
        >
          {showCard ? <img src={cardAsset(showCard)} alt="" /> : <span className="show-placeholder">Show<br />here</span>}
          <small>{showCard ? "Cancel show" : "Final discard"}</small>
        </button>
      </div>

      {self?.status === "dropped" && <aside className="dropped-panel" role="status">
        <strong>Invalid show — watching this round</strong>
        <span>Your cards are frozen while the remaining players continue.</span>
      </aside>}
    </section>

    <section className="player-area" aria-labelledby="your-hand-title">
      <div className="hand-heading">
        <div><span className="eyebrow">Your cards</span><h1 ref={handHeadingRef} id="your-hand-title" tabIndex={-1}>Your hand <small>({hand.length})</small></h1></div>
        <div className="hand-actions" aria-label="Arrange cards">
          <button className="secondary compact" disabled={handControlsDisabled || Boolean(currentLayout.showCardId)} onClick={sortBySuit}>Sort by suit</button>
          <button className="secondary compact" aria-label="Group selected" disabled={handControlsDisabled || selectedIds.length < 2} onClick={createGroup}>Group selected{selectedIds.length > 0 ? ` (${selectedIds.length})` : ""}</button>
          {selectedIds.length > 0 && <button className="secondary compact" disabled={handControlsDisabled} onClick={() => setSelected(new Set())}>Clear selection</button>}
          <button className="secondary compact icon-control" aria-label="Move selected card left" disabled={handControlsDisabled || selectedIds.length !== 1} onClick={() => moveCard(selectedIds[0]!, "left")}>←</button>
          <button className="secondary compact icon-control" aria-label="Move selected card right" disabled={handControlsDisabled || selectedIds.length !== 1} onClick={() => moveCard(selectedIds[0]!, "right")}>→</button>
        </div>
      </div>

      <div className="hand-groups">
        {currentLayout.groups.map((group, groupIndex) => {
          const anchorId = group[0];
          const groupCards = group.map((id) => byId.get(id)).filter((card): card is Card => Boolean(card));
          const meldStatus = getMeldStatus(groupCards, game.wildRank);
          return <section
            className={`hand-group meld-${meldStatus.kind}`}
            key={`${groupIndex}-${anchorId ?? "empty"}`}
            role="group"
            aria-label={`Group ${groupIndex + 1}, ${group.length} cards: ${meldStatus.label}`}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              placeAtGroupEnd(event.dataTransfer.getData("text/plain"), anchorId, groupIndex);
            }}
          >
            <span className="meld-status" aria-hidden="true">{meldStatus.label}</span>
            <div className="group-label">
              <span>Group {groupIndex + 1}</span>
              {groupIndex > 0 && <button type="button" disabled={handControlsDisabled} onClick={() => updateGroups((groups) => groups.map((item, index) => index === groupIndex - 1 ? [...item, ...groups[groupIndex]!] : item).filter((_, index) => index !== groupIndex))}>Merge left</button>}
            </div>
            <div className="card-fan">
              {groupCards.map((card) => <PlayingCard
                key={card.id}
                card={card}
                wild={card.printedJoker || card.rank === game.wildRank}
                selected={selected.has(card.id)}
                disabled={handControlsDisabled}
                onToggle={() => toggle(card.id)}
                onMove={(direction) => moveCard(card.id, direction)}
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("text/plain", card.id);
                }}
                onDrop={(event, position) => placeCard(event.dataTransfer.getData("text/plain"), card.id, position)}
              />)}
            </div>
          </section>;
        })}
      </div>

      <div className="move-actions">
        {showdown ? <>
          <p className="instruction" id="showdown-instruction">{showdownFinalizing
            ? "All responses are in or time has expired. Finalizing the verified result…"
            : isShowdownResponder
              ? hasCompleteShowdownHand
                ? `${declarerName} declared. Arrange all 13 cards into groups, then submit your hand.`
                : "Restoring your 13-card hand before you arrange and submit it…"
              : hasSubmittedShowdown
                ? `Your hand is submitted. Waiting for ${showdownWaitingCount} ${showdownWaitingCount === 1 ? "player" : "players"}.`
                : isShowdownDeclarer
                  ? `Your declaration was accepted. Waiting for ${showdownWaitingCount} ${showdownWaitingCount === 1 ? "player" : "players"} to submit.`
                  : "Waiting for the remaining players to submit their arranged hands."}</p>
          {isShowdownResponder && !showdownFinalizing && <button
            type="button"
            className="primary showdown-submit"
            aria-describedby="showdown-instruction"
            disabled={!hasCompleteShowdownHand}
            onClick={() => onSubmitHand(groupsForSubmission(currentLayout, hand))}
          >Submit arranged hand</button>}
        </> : <>
        <p className="instruction">{!isPlaying
          ? "You are watching the remaining players after an invalid show."
          : currentLayout.showCardId
            ? declarationResult?.valid
              ? `Ready to declare — ${declarationResult.score} points across valid melds, including a natural 21 with no joker or wild card.`
              : <>Not ready to declare. <span className="declaration-reason">{declarationResult?.reason ?? "Arrange all 13 cards into valid Trinity melds."}</span></>
            : !isMyTurn
              ? "Arrange your cards while you wait for the next move."
              : !hasDrawn
                ? "Pick one card from the closed deck or open deck."
                : "Select one card to discard, or move it to Show here to declare."}</p>
        {!currentLayout.showCardId && <button className="danger" disabled={!isMyTurn || !hasDrawn || selectedIds.length !== 1 || Boolean(winner)} onClick={() => { onDiscard(selectedIds[0]!, groupsForSubmission(currentLayout, hand)); setSelected(new Set()); }}>Discard</button>}
        {!currentLayout.showCardId && <button className="primary" disabled={!isMyTurn || !hasDrawn || selectedIds.length !== 1 || Boolean(winner)} onClick={() => stageShow(selectedIds[0]!)}>Show selected</button>}
        {currentLayout.showCardId && <button className="secondary" disabled={Boolean(winner)} onClick={cancelStagedShow}>Cancel show</button>}
        {currentLayout.showCardId && <button className="primary declare-button" disabled={!canDeclare || Boolean(winner)} onClick={() => onDeclare(currentLayout.showCardId!, currentLayout.groups)}>Declare</button>}
        </>}
      </div>
    </section>

    <p className="sr-status" role="status" aria-live="polite">{notice}</p>

    {showToss && game.phase === "playing" && game.toss && <TossOverlay game={game} onComplete={() => setShowToss(false)} />}

    {showShowdownPrompt && <GameDialog
      panelClassName="confirmation-dialog showdown-dialog"
      labelledBy="showdown-title"
      describedBy="showdown-description"
    >
      <span className="eyebrow">Declaration accepted</span>
      <h2 id="showdown-title">{declarerName} declared. Arrange your 13 cards.</h2>
      <p id="showdown-description">Drawing and discarding have ended. Review your groups and submit your hand before the response timer ends.</p>
      <div className="dialog-actions">
        <button className="primary" data-dialog-initial-focus={hasCompleteShowdownHand ? true : undefined} disabled={!hasCompleteShowdownHand} onClick={() => {
          setDismissedShowdownKey(showdownKey);
          window.requestAnimationFrame(() => handHeadingRef.current?.focus());
        }}>{hasCompleteShowdownHand ? "Arrange my hand" : "Restoring hand…"}</button>
      </div>
    </GameDialog>}

    {pendingShowCard && <GameDialog panelClassName="confirmation-dialog" labelledBy="show-confirmation-title" onClose={() => setPendingShowId(null)}>
      <span className="eyebrow">Commit your show</span>
      <img src={cardAsset(pendingShowCard)} alt={cardLabel(pendingShowCard)} />
      <h2 id="show-confirmation-title">Use this as your final discard?</h2>
      <p>After confirming, arrange the remaining 13 cards into melds totaling 3–27 in steps of 3, including one meld worth exactly 21.</p>
      <div className="dialog-actions">
        <button className="secondary" data-dialog-initial-focus onClick={() => setPendingShowId(null)}>No, keep arranging</button>
        <button className="primary" onClick={confirmShow}>Yes, prepare show</button>
      </div>
    </GameDialog>}

    {confirmDrop && <GameDialog panelClassName="confirmation-dialog drop-confirmation" labelledBy="drop-confirmation-title" onClose={() => { if (!dropRequested) setConfirmDrop(false); }}>
      <span className="eyebrow">Concede this round</span>
      <h2 id="drop-confirmation-title">Drop this game?</h2>
      <p>{game.playerCount === 2
        ? `${opponents[0]?.displayName ?? "Your opponent"} will win immediately. The replay and post-game chat will open next.`
        : "You will lose this round. The remaining players will continue while you watch."}</p>
      <div className="dialog-actions">
        <button className="secondary" data-dialog-initial-focus disabled={dropRequested} onClick={() => setConfirmDrop(false)}>Keep playing</button>
        <button className="danger" disabled={dropRequested} onClick={() => {
          if (onDropGame(groupsForSubmission(currentLayout, hand))) setDropRequested(true);
        }}>{dropRequested ? "Dropping…" : "Yes, drop and lose"}</button>
      </div>
    </GameDialog>}

    {winner && <GameDialog panelClassName="result-dialog" labelledBy="result-title">
      <span className="eyebrow">Round complete</span>
      <h2 id="result-title">{winner.id === playerId ? "You won!" : `${winner.name} won`}</h2>
      <p>{winner.reason === "player-dropped"
        ? "Another player dropped, so the last active player won the round."
        : winner.reason === "invalid-declaration" && self?.status === "dropped"
            ? "Your show was invalid, so the remaining player won the round."
          : winner.reason === "invalid-declaration"
            ? "The other player's show was invalid, so the remaining player won the round."
            : `The winning declaration was validated by the server${winner.score === undefined ? "." : ` for ${winner.score} points.`}`}</p>
      <button className="primary" data-dialog-initial-focus onClick={onReturnToLobby}>Replay and chat</button>
    </GameDialog>}
  </main>;
}
