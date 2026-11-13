import { useCallback, useEffect, useState } from "react";
import { publicGameNameSchema } from "@trinitymatrix/protocol";
import { api, HttpApiError, type AuthPlayer } from "../../api";
import { AuthFlow } from "../AuthFlow";
import { LiveDirectory } from "./LiveDirectory";
import { WatchPage } from "./WatchPage";

export function isWatchLocation(location: Pick<Location, "pathname">) { return /^\/(?:live\/?|watch\/[^/]+\/?)$/.test(location.pathname); }

/** Spectators authenticate over HTTP and never create a gameplay WebSocket. */
export function WatchApp() {
  const [player, setPlayer] = useState<AuthPlayer | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const authenticationRequired = useCallback(() => setPlayer(null), []);
  useEffect(() => {
    let active = true; setLoading(true); setError("");
    api.session().then((response) => { if (active) setPlayer(response.authenticated && response.player ? response.player : null); })
      .catch((cause) => {
        if (!active) return;
        if (cause instanceof HttpApiError && cause.status === 401) setPlayer(null);
        else setError(cause instanceof Error ? cause.message : "Your spectator session could not be checked.");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [retry]);
  if (loading) return <main id="main-content" className="loading-screen" role="status">Preparing spectator access…</main>;
  if (error) return <main id="main-content" className="live-shell"><h1>Spectator access unavailable</h1><p role="alert">{error}</p><button className="secondary" onClick={() => setRetry((value) => value + 1)}>Retry sign-in check</button></main>;
  if (!player) return <AuthFlow onAuthenticated={setPlayer} />;
  const name = window.location.pathname.match(/^\/watch\/([^/]+)/)?.[1];
  let gameName: string | undefined;
  try { gameName = name ? publicGameNameSchema.parse(decodeURIComponent(name)) : undefined; } catch { gameName = ""; }
  return <main id="main-content" className="live-shell">
    <header className="live-app-header"><a className="wordmark" href="/" aria-label="TrinityMatrix home"><span>TM</span> TrinityMatrix</a><nav aria-label="Spectator navigation"><a href="/live">Watch tables</a><a href="/">Play</a></nav><span>{player.displayName}</span><button className="text-button" onClick={() => { void api.logout().then(() => setPlayer(null)).catch(() => setError("Sign-out could not be confirmed. Please retry your session check.")); }}>Sign out</button></header>
    {gameName === "" ? <section className="live-empty"><h1>Broadcast not found</h1><a href="/live">Find a table</a></section>
      : gameName ? <WatchPage gameName={gameName} player={player} onAuthenticationRequired={authenticationRequired} /> : <LiveDirectory onAuthenticationRequired={authenticationRequired} />}
  </main>;
}
