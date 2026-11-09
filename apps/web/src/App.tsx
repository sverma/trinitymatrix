import { useCallback, useEffect, useState } from "react";
import { api, type AuthPlayer } from "./api";
import { AuthFlow } from "./components/AuthFlow";
import { AdminPortal, isAdminLocation } from "./components/AdminPortal";
import { GameTable } from "./components/GameTable";
import { Lobby } from "./components/Lobby";
import { getPolicyPage, PolicyPage } from "./components/PolicyPages";
import type { PlayerSection } from "./components/PlayerViews";
import { PrivateRoomQueue, Queue } from "./components/Queue";
import { useGameSocket } from "./game/useGameSocket";
import { registerPwa } from "./pwa";
import { unlockTurnSounds } from "./audio/turnSounds";

function PlayerApp() {
  const [player, setPlayer] = useState<AuthPlayer | null>(null);
  const [playerSection, setPlayerSection] = useState<PlayerSection>("play");
  const [loading, setLoading] = useState(true);
  const [update, setUpdate] = useState<(() => Promise<void>) | null>(null);
  const [pwaMessage, setPwaMessage] = useState("");
  const [sessionMessage, setSessionMessage] = useState("");
  const handleAuthenticationRequired = useCallback((reason: string) => {
    setSessionMessage(reason === "Origin not allowed"
      ? "This address is not allowed to open a game connection. Use http://localhost:8180."
      : "Your session expired. Please sign in again.");
    setPlayer(null);
  }, []);
  const socket = useGameSocket(Boolean(player), handleAuthenticationRequired);

  useEffect(() => {
    if (player && !socket.game && !socket.queue && socket.completedGameName) setPlayerSection("history");
  }, [player, socket.completedGameName, socket.game, socket.queue]);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "auto" });
  }, [player, playerSection, socket.game?.gameId, socket.completedGameName, socket.privateRoom?.roomCode]);

  useEffect(() => {
    api.session().then((session) => {
      if (session.authenticated && session.player) setPlayer(session.player);
    }).catch(() => undefined).finally(() => setLoading(false));
  }, []);

  useEffect(() => registerPwa((applyUpdate) => setUpdate(() => applyUpdate), () => setPwaMessage("TrinityMatrix is ready for offline launch. Live games still require a connection.")), []);

  useEffect(() => {
    const unlock = () => { void unlockTurnSounds(); };
    window.addEventListener("pointerdown", unlock, { capture: true });
    window.addEventListener("keydown", unlock, { capture: true });
    return () => {
      window.removeEventListener("pointerdown", unlock, { capture: true });
      window.removeEventListener("keydown", unlock, { capture: true });
    };
  }, []);

  if (loading) return <main id="main-content" className="loading-screen"><div className="brand-mark" aria-hidden="true">TM</div><p>Preparing the lobby…</p></main>;

  let content;
  if (!player) {
    content = <AuthFlow onAuthenticated={(authenticatedPlayer) => {
      setSessionMessage("");
      setPlayer(authenticatedPlayer);
    }} />;
  } else if (socket.connection === "session-replaced") {
    content = <main id="main-content" className="loading-screen session-replaced-screen">
      <div className="brand-mark" aria-hidden="true">TM</div>
      <h1>Game open in another window</h1>
      <p>This account can control one game window at a time. Continue in the other window, or move the session back here.</p>
      <button type="button" className="primary" onClick={() => window.location.reload()}>Use this window instead</button>
    </main>;
  } else if (socket.game && socket.playerId) {
    content = <GameTable
      game={socket.game}
      hand={socket.hand}
      playerId={socket.playerId}
      notice={socket.notice}
      winner={socket.winner}
      onDraw={socket.draw}
      onDiscard={socket.discard}
      onDeclare={socket.declare}
      onSubmitHand={socket.submitHand}
      onDropGame={socket.dropGame}
      onReturnToLobby={socket.returnToLobby}
    />;
  } else if (socket.privateRoom) {
    content = <PrivateRoomQueue
      room={socket.privateRoom}
      playerId={player.id}
      onBack={socket.closePrivateRoom}
      onCancel={async () => {
        const roomCode = socket.privateRoom!.roomCode;
        await api.cancelPrivateMatch(roomCode);
        socket.removePrivateRoom(roomCode);
      }}
    />;
  } else if (socket.queue) {
    content = <Queue {...socket.queue} onLeave={socket.leaveQueue} />;
  } else {
    content = <Lobby
      player={player}
      section={playerSection}
      openGameName={socket.completedGameName}
      onArchiveClosed={socket.clearCompletedGame}
      realtimeChatMessages={socket.realtimeChatMessages}
      realtimePrivateInvitations={socket.privateInvitations}
      realtimePrivateRooms={socket.privateRoomUpdates}
      connectionGeneration={socket.connectionGeneration}
      onOpenPrivateRoom={socket.openPrivateRoom}
      onSectionChange={setPlayerSection}
      onJoin={(count) => { setPlayerSection("play"); socket.joinQueue(count); }}
      onLogout={async () => { await api.logout(); setPlayerSection("play"); setPlayer(null); }}
      onUpdateProfile={async (profile) => {
        const result = await api.updateProfile(profile);
        setPlayer(result.player);
      }}
    />;
  }

  return <>
    {socket.connection === "disconnected" && player && <div className="connection-banner" role="alert">Connection lost. Reconnecting safely…</div>}
    {sessionMessage && !player && <div className="connection-banner" role="alert">{sessionMessage}</div>}
    {update && <div className="update-banner" role="status">A new version is ready. <button onClick={() => void update()}>Update now</button><button onClick={() => setUpdate(null)}>Later</button></div>}
    {pwaMessage && <div className="toast" role="status">{pwaMessage}<button aria-label="Dismiss" onClick={() => setPwaMessage("")}>×</button></div>}
    {content}
  </>;
}

export function App() {
  const policyPage = getPolicyPage(window.location.pathname);
  if (policyPage) return <PolicyPage page={policyPage} />;
  return isAdminLocation(window.location) ? <AdminPortal /> : <PlayerApp />;
}
