import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityEvent, ActivityOverview, ActivitySession, ActivityUser } from "@trinitymatrix/protocol";
import { activityApi } from "../activity-api";
import { HttpApiError } from "../api";
import { AdminActivity, activityDuration } from "./AdminActivity";

const person: ActivityUser = {
  userId: "11111111-1111-4111-8111-111111111111", displayName: "Asha", email: "asha@example.test", actorKind: "human",
  lastSeenAt: "2026-11-27T11:58:00Z", lastSignInAt: "2026-11-27T10:00:00Z", status: "active",
  signIns: 8, sessionCount: 2, activeSeconds: 2520, matches: 6, wins: 4, losses: 1, drops: 1, interactions: 42
};
const robot: ActivityUser = { ...person, userId: "22222222-2222-4222-8222-222222222222", displayName: "Terra AI", email: "agent@ai.trinitymatrix.invalid", actorKind: "ai", signIns: 0, sessionCount: 0, activeSeconds: 0 };
const overview: ActivityOverview = {
  from: "2026-11-20T12:00:00Z", to: "2026-11-27T12:00:00Z", trackingSince: "2026-11-27T08:00:00Z", retentionDays: 90, generatedAt: "2026-11-27T12:00:00Z",
  summary: { signIns: 8, uniqueUsers: 2, activeUsers: 1, activeSeconds: 2520, matches: 6, wins: 4, losses: 1, drops: 1, interactions: 42 },
  daily: [{ date: "2026-11-27", signIns: 8, activeSeconds: 2520, matches: 6, interactions: 42 }],
  pages: [{ page: "table", views: 10, activeSeconds: 1800 }], actions: [{ action: "cards.group", count: 12, source: "browser" }, { action: "game.draw", count: 30, source: "server" }]
};
const events: ActivityEvent[] = [{
  id: "event-one", occurredAt: "2026-11-27T10:00:00Z", userId: person.userId, displayName: person.displayName, email: person.email, actorKind: "human",
  kind: "auth", action: "auth.login", source: "server", page: null, gameName: null, outcome: null
}, {
  id: "event-two", occurredAt: "2026-11-27T09:00:00Z", userId: robot.userId, displayName: robot.displayName, email: robot.email, actorKind: "ai",
  kind: "match", action: "match.won", source: "server", page: null, gameName: "lucky-falcon-12345678", outcome: "won"
}];
const session: ActivitySession = {
  id: "ANALYTICS_UUID_NEVER_RENDER", userId: person.userId, displayName: person.displayName, email: person.email, actorKind: "human",
  startedAt: "2026-11-27T09:00:00Z", signedInAt: "2026-11-27T09:00:00Z", lastSeenAt: "2026-11-27T10:00:00Z", endedAt: "2026-11-27T10:00:00Z", expiresAt: "2026-11-27T21:00:00Z", activeSeconds: 2520, lastPage: "table"
};

function setup() {
  return {
    overview: vi.spyOn(activityApi, "overview").mockResolvedValue(structuredClone(overview)),
    users: vi.spyOn(activityApi, "users").mockResolvedValue({ items: [person, robot], nextCursor: null }),
    events: vi.spyOn(activityApi, "events").mockResolvedValue({ items: events, nextCursor: null }),
    sessions: vi.spyOn(activityApi, "sessions").mockResolvedValue({ items: [session], nextCursor: null })
  };
}

describe("administrator Activity panel", () => {
  beforeEach(() => { vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible"); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("shows meaningful sign-in, active-time, verified outcome and interaction views with collection limits", async () => {
    setup(); render(<AdminActivity />);
    expect(await screen.findByRole("heading", { name: "People and AI players" })).toBeInTheDocument();
    expect(screen.getByText("Successful sign-ins").closest("article")).toHaveTextContent("8");
    expect(screen.getByText("Estimated active time", { selector: ".metric-card span" }).closest("article")).toHaveTextContent("42m");
    expect(screen.getByRole("table", { name: "Daily activity in UTC" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Daily activity chart, scroll horizontally" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("region", { name: "Player activity table, scroll horizontally" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByText(/Earlier match outcomes can still appear/)).toBeInTheDocument();
    expect(screen.getByText(/does not add simultaneous tabs together/)).toBeInTheDocument();
    const people = screen.getByRole("table", { name: "Player activity in the selected window" });
    expect(within(people).getByRole("columnheader", { name: "Dropped" })).toBeInTheDocument();
    expect(within(people).getByText("asha@example.test")).toBeInTheDocument();
    expect(within(people).getByText("AI player")).toBeInTheDocument();
    expect(screen.queryByText(robot.email)).not.toBeInTheDocument();
    expect(screen.getAllByText("Server verified").length).toBeGreaterThan(0);
    expect(screen.getByText("Browser reported")).toBeInTheDocument();
    expect(screen.getByText(/Won a match/)).toBeInTheDocument();
  });

  it("scopes all views to an inspected user and shows session metadata without identifiers", async () => {
    const mock = setup(); const user = userEvent.setup(); render(<AdminActivity />);
    await user.click(await screen.findByRole("button", { name: "Inspect activity for Asha" }));
    expect(await screen.findByRole("heading", { name: "Browser sessions" })).toBeInTheDocument();
    expect(mock.sessions).toHaveBeenLastCalledWith(expect.objectContaining({ userId: person.userId }), undefined, expect.any(AbortSignal));
    expect(mock.overview.mock.calls.at(-1)![0]).toMatchObject({ userId: person.userId });
    expect(screen.queryByText(session.id)).not.toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Recorded browser sessions" })).toHaveTextContent("42m");
    expect(screen.getByRole("region", { name: "Browser sessions table, scroll horizontally" })).toHaveAttribute("tabindex", "0");
    await user.click(screen.getByRole("button", { name: "Show all players" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Browser sessions" })).not.toBeInTheDocument());
  });

  it("applies actor, name/email and timeline-category filters without leaking earlier-scope results", async () => {
    const mock = setup(); const user = userEvent.setup(); render(<AdminActivity />);
    await screen.findByRole("heading", { name: "People and AI players" });
    await user.selectOptions(screen.getByLabelText("Player type"), "human");
    await waitFor(() => expect(mock.overview.mock.calls.at(-1)![0].actorKind).toBe("human"));
    await user.type(screen.getByLabelText("Name or email"), " asha@example.test ");
    await user.click(screen.getByRole("button", { name: "Search activity" }));
    await waitFor(() => expect(mock.overview.mock.calls.at(-1)![0].q).toBe("asha@example.test"));
    await user.selectOptions(screen.getByLabelText("Event category"), "auth");
    await waitFor(() => expect(mock.events.mock.calls.at(-1)![1]).toBe("auth"));
    await user.click(screen.getByRole("button", { name: "Clear search" }));
    await waitFor(() => expect(mock.overview.mock.calls.at(-1)![0].q).toBeUndefined());
  });

  it("keeps pagination on its original time window and pauses refresh while reading older pages", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-27T12:00:00Z"));
    const mock = setup();
    mock.users.mockResolvedValueOnce({ items: [person], nextCursor: "page-two" }).mockResolvedValue({ items: [robot], nextCursor: null });
    await act(async () => { render(<AdminActivity />); });
    const initial = mock.users.mock.calls[0]![0];
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Load more players" })); });
    expect(mock.users.mock.calls[1]![0]).toEqual(initial);
    expect(mock.users.mock.calls[1]![1]).toBe("page-two");
    expect(screen.getByText("Refresh paused · older pages")).toBeInTheDocument();
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(mock.overview).toHaveBeenCalledTimes(1);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Refresh activity" })); });
    expect(mock.overview).toHaveBeenCalledTimes(2);
    expect(Date.parse(mock.overview.mock.calls[1]![0].to)).toBe(Date.parse(initial.to) + 30_000);
  });

  it("refreshes a moving preset window without overlapping requests or refreshing a hidden tab", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-27T12:00:00Z"));
    const mock = setup();
    let resolve: (value: ActivityOverview) => void = () => undefined;
    mock.overview.mockResolvedValueOnce(overview).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const mounted = render(<AdminActivity />); await act(async () => undefined);
    await act(async () => { vi.advanceTimersByTime(15_000); });
    expect(mock.overview).toHaveBeenCalledTimes(2);
    expect(Date.parse(mock.overview.mock.calls[1]![0].to) - Date.parse(mock.overview.mock.calls[0]![0].to)).toBe(15_000);
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(mock.overview).toHaveBeenCalledTimes(2);
    await act(async () => { resolve(overview); });
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(mock.overview).toHaveBeenCalledTimes(2);
    mounted.unmount();
  });

  it("ignores an older request that resolves after an actor filter changed", async () => {
    const mock = setup(); let first: (value: ActivityOverview) => void = () => undefined;
    mock.overview.mockImplementationOnce(() => new Promise((done) => { first = done; })).mockResolvedValue({ ...overview, summary: { ...overview.summary, signIns: 0 } });
    mock.users.mockResolvedValueOnce({ items: [person], nextCursor: null }).mockResolvedValue({ items: [robot], nextCursor: null });
    render(<AdminActivity />);
    fireEvent.change(screen.getByLabelText("Player type"), { target: { value: "ai" } });
    await screen.findByRole("button", { name: "Inspect activity for Terra AI" });
    await act(async () => { first(overview); });
    expect(screen.queryByRole("button", { name: "Inspect activity for Asha" })).not.toBeInTheDocument();
    expect(screen.getByText("Successful sign-ins").closest("article")).toHaveTextContent("0");
  });

  it("validates custom ranges and survives returning to an unfinished date draft", async () => {
    const mock = setup(); const user = userEvent.setup(); render(<AdminActivity />);
    await screen.findByRole("heading", { name: "People and AI players" });
    await user.click(screen.getByRole("button", { name: "Custom dates" }));
    const start = screen.getByLabelText("From (local time)"); const end = screen.getByLabelText("To (local time)");
    fireEvent.change(start, { target: { value: "2026-01-01T00:00" } });
    fireEvent.change(end, { target: { value: "2026-05-01T00:00" } });
    await user.click(screen.getByRole("button", { name: "Apply dates" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("no more than 90 days");
    fireEvent.change(start, { target: { value: "" } });
    await user.click(screen.getByRole("button", { name: "7 days" }));
    await user.click(screen.getByRole("button", { name: "Custom dates" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Choose valid start and end dates");
    fireEvent.change(screen.getByLabelText("From (local time)"), { target: { value: "2026-01-01T00:00" } });
    fireEvent.change(screen.getByLabelText("To (local time)"), { target: { value: "2026-01-02T00:00" } });
    await user.click(screen.getByRole("button", { name: "Apply dates" }));
    await waitFor(() => expect(mock.overview.mock.calls.at(-1)![0].from).toBe(new Date("2026-01-01T00:00").toISOString()));
    expect(screen.getByText("Fixed custom window")).toBeInTheDocument();
  });

  it("recovers an initial failure and clearly labels an empty result", async () => {
    const mock = setup(); mock.overview.mockRejectedValueOnce(new Error("Temporary database failure")).mockResolvedValue({ ...overview, daily: [], pages: [], actions: [], summary: { signIns: 0, uniqueUsers: 0, activeUsers: 0, activeSeconds: 0, matches: 0, wins: 0, losses: 0, drops: 0, interactions: 0 } });
    mock.users.mockResolvedValue({ items: [], nextCursor: null }); mock.events.mockResolvedValue({ items: [], nextCursor: null });
    const user = userEvent.setup(); render(<AdminActivity />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Temporary database failure");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No players match this activity window and filters.")).toBeInTheDocument();
    expect(screen.getByText("No events match these filters.")).toBeInTheDocument();
    expect(screen.getByText("No page activity recorded.")).toBeInTheDocument();
  });

  it("clears previously visible activity if administrator access expires", async () => {
    const mock = setup(); const user = userEvent.setup(); render(<AdminActivity />);
    await screen.findByRole("button", { name: "Inspect activity for Asha" });
    mock.overview.mockRejectedValue(new HttpApiError("Unlock your administrator passkey again.", 403));
    await user.click(screen.getByRole("button", { name: "Refresh activity" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Unlock your administrator passkey again.");
    expect(screen.queryByText("asha@example.test")).not.toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Player activity in the selected window" })).not.toBeInTheDocument();
  });

  it("clears privileged player data when pagination loses administrator access", async () => {
    const mock = setup();
    mock.users.mockResolvedValueOnce({ items: [person], nextCursor: "next-people" }).mockRejectedValue(new HttpApiError("Administrator access expired.", 403));
    const user = userEvent.setup(); render(<AdminActivity />);
    await user.click(await screen.findByRole("button", { name: "Load more players" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Administrator access expired.");
    expect(screen.queryByText(person.email)).not.toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Player activity in the selected window" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Activity timeline" })).not.toBeInTheDocument();
  });

  it("clears selected-user and session details when session pagination loses authentication", async () => {
    const mock = setup();
    mock.sessions.mockResolvedValueOnce({ items: [session], nextCursor: "next-sessions" }).mockRejectedValue(new HttpApiError("Sign in again.", 401));
    const user = userEvent.setup(); render(<AdminActivity />);
    await user.click(await screen.findByRole("button", { name: "Inspect activity for Asha" }));
    await user.click(await screen.findByRole("button", { name: "Load more sessions" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Sign in again.");
    expect(screen.queryByText(person.email)).not.toBeInTheDocument();
    expect(screen.queryByText("Inspecting player")).not.toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Recorded browser sessions" })).not.toBeInTheDocument();
  });

  it("labels a resumed session's first observed timestamp without inventing a sign-in", async () => {
    const mock = setup(); mock.sessions.mockResolvedValue({ items: [{ ...session, signedInAt: null }], nextCursor: null });
    const user = userEvent.setup(); render(<AdminActivity />);
    await user.click(await screen.findByRole("button", { name: "Inspect activity for Asha" }));
    expect(await screen.findByText("First observed · resumed session")).toBeInTheDocument();
    expect(screen.getByText(/not an inferred sign-in/)).toBeInTheDocument();
  });

  it("formats estimated time without implying sub-minute precision", () => {
    expect([0, 20, 60, 3599, 3660].map(activityDuration)).toEqual(["0m", "<1m", "1m", "59m", "1h 1m"]);
  });
});
