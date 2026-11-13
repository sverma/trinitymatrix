import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, HttpApiError } from "../../api";
import { liveName, livePlayer } from "./live.test-helpers";
import { WatchApp, isWatchLocation } from "./WatchApp";
vi.mock("../AuthFlow", () => ({ AuthFlow: ({ onAuthenticated }: { onAuthenticated: (player: typeof livePlayer) => void }) => <button onClick={() => onAuthenticated(livePlayer)}>Complete spectator sign-in</button> }));
vi.mock("./WatchPage", () => ({ WatchPage: ({ gameName }: { gameName: string }) => <p>Watching {gameName}</p> }));
vi.mock("./LiveDirectory", () => ({ LiveDirectory: () => <p>Watching directory</p> }));
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
  it.each(["/live", `/watch/${liveName}`])("treats an anonymous401 at %s as sign-in and preserves the destination", async (path) => {
    const user = userEvent.setup(); const gameplay = vi.fn(); vi.stubGlobal("WebSocket", gameplay);
    vi.spyOn(api, "session").mockRejectedValue(new HttpApiError("Authentication required.", 401));
    window.history.replaceState({}, "", path);
    render(<WatchApp />);
    await user.click(await screen.findByRole("button", { name: "Complete spectator sign-in" }));
    expect(screen.getByText(path === "/live" ? "Watching directory" : `Watching ${liveName}`)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Spectator access unavailable" })).not.toBeInTheDocument();
    expect(window.location.pathname).toBe(path);
    expect(gameplay).not.toHaveBeenCalled();
  });
  it("keeps service failures retryable and returns to sign-in after the retry succeeds", async () => {
    const user = userEvent.setup(); const gameplay = vi.fn(); vi.stubGlobal("WebSocket", gameplay);
    const session = vi.spyOn(api, "session").mockRejectedValueOnce(new HttpApiError("The session service is starting.", 503)).mockResolvedValue({ authenticated: false });
    window.history.replaceState({}, "", `/watch/${liveName}`);
    render(<WatchApp />);
    expect(await screen.findByRole("alert")).toHaveTextContent("session service is starting");
    await user.click(screen.getByRole("button", { name: "Retry sign-in check" }));
    expect(await screen.findByRole("button", { name: "Complete spectator sign-in" })).toBeInTheDocument();
    expect(session).toHaveBeenCalledTimes(2);
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
