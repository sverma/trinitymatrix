import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api";
import { liveName, livePlayer } from "./live.test-helpers";
import { WatchApp, isWatchLocation } from "./WatchApp";
vi.mock("../AuthFlow", () => ({ AuthFlow: ({ onAuthenticated }: { onAuthenticated: (player: typeof livePlayer) => void }) => <button onClick={() => onAuthenticated(livePlayer)}>Complete spectator sign-in</button> }));
vi.mock("./WatchPage", () => ({ WatchPage: ({ gameName }: { gameName: string }) => <p>Watching {gameName}</p> }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); window.history.replaceState({}, "", "/"); });
describe("spectator deep links", () => {
  it("preserves the watch URL through sign-in without opening a gameplay connection", async () => {
    const user = userEvent.setup(); const gameplay = vi.fn(); vi.stubGlobal("WebSocket", gameplay);
    vi.spyOn(api, "session").mockResolvedValue({ authenticated: false });
    window.history.replaceState({}, "", `/watch/${liveName}`);
    render(<WatchApp />);
    await user.click(await screen.findByRole("button", { name: "Complete spectator sign-in" }));
    expect(screen.getByText(`Watching ${liveName}`)).toBeInTheDocument();
    expect(window.location.pathname).toBe(`/watch/${liveName}`);
    expect(gameplay).not.toHaveBeenCalled();
  });
  it("matches only spectator entry routes", () => {
    expect(isWatchLocation({ pathname: "/live" })).toBe(true);
    expect(isWatchLocation({ pathname: `/watch/${liveName}` })).toBe(true);
    expect(isWatchLocation({ pathname: "/admin/live" })).toBe(false);
    expect(isWatchLocation({ pathname: "/watch/table/extra" })).toBe(false);
  });
});
