import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, HttpApiError } from "../../api";
import { liveSummary } from "./live.test-helpers";
import { LiveDirectory } from "./LiveDirectory";

afterEach(() => vi.restoreAllMocks());
describe("live broadcast directory", () => {
  it("hides agent version suffixes in archived table titles and rosters", async () => {
    const players = liveSummary.players.map((player) => player.actorKind === "ai" ? { ...player, displayName: `${player.displayName} · v2` } : player);
    vi.spyOn(api, "liveDirectory").mockResolvedValue({ broadcasts: [{ ...liveSummary, players, title: players.map(({ displayName }) => displayName).join(" · ") }], nextCursor: null, serverNow: Date.now() });
    render(<LiveDirectory />);
    expect(await screen.findByRole("link", { name: "Asha · Model AI" })).toBeInTheDocument();
    expect(screen.getByText("Model AI")).toBeInTheDocument();
    expect(screen.queryByText(/Model AI · v2/)).not.toBeInTheDocument();
  });

  it("filters and searches without losing bounded pagination or duplicating tables", async () => {
    const user = userEvent.setup();
    const other = { ...liveSummary, gameName: "royal-falcon-87654321", title: "Another table" };
    const request = vi.spyOn(api, "liveDirectory").mockResolvedValueOnce({ broadcasts: [liveSummary], nextCursor: "page2", serverNow: Date.now() })
      .mockResolvedValueOnce({ broadcasts: [liveSummary, other], nextCursor: null, serverNow: Date.now() })
      .mockResolvedValue({ broadcasts: [other], nextCursor: null, serverNow: Date.now() });
    render(<LiveDirectory />);
    await screen.findByRole("link", { name: liveSummary.title });
    await user.click(screen.getByRole("button", { name: "Load more broadcasts" }));
    expect(await screen.findByRole("link", { name: "Another table" })).toHaveAttribute("href", "/watch/royal-falcon-87654321");
    expect(screen.getAllByRole("link", { name: liveSummary.title })).toHaveLength(1);
    expect(request).toHaveBeenNthCalledWith(2, expect.objectContaining({ cursor: "page2" }));
    await user.selectOptions(screen.getByLabelText("Players"), "ai");
    await user.type(screen.getByLabelText("Search tables or players"), "Mistral");
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ composition: "ai", q: "Mistral" }), expect.any(AbortSignal));
    expect(screen.getAllByText("All hands revealed · 2-minute minimum delay")).toHaveLength(1);
  });
  it("returns expired spectator sessions to sign-in", async () => {
    const authenticationRequired = vi.fn();
    vi.spyOn(api, "liveDirectory").mockRejectedValue(new HttpApiError("Sign in required.", 401));
    render(<LiveDirectory onAuthenticationRequired={authenticationRequired} />);
    await waitFor(() => expect(authenticationRequired).toHaveBeenCalledOnce());
  });
});
