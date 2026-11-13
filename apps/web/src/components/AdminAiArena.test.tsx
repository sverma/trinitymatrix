import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiPlayerRoster } from "../api";
import { AdminAiArena } from "./AdminAiArena";

const roster: AiPlayerRoster = {
  enabled: true,
  dailyBudgetUsd: 10,
  players: Array.from({ length: 6 }, (_, index) => ({
    id: `00000000-0000-4000-8000-00000000000${index + 1}`,
    displayName: `Agent ${index + 1}`,
    modelId: `provider/model-${index + 1}`,
    modelName: `Model ${index + 1}`,
    available: index < 5,
    ...(index === 5 ? { reason: "Already at a table" } : {}),
    rating: 1000,
    gamesPlayed: 0,
    wins: 0
  }))
};

function mockArena(error?: string) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "/api/ai/players") return new Response(JSON.stringify(roster), { status: 200 });
    if (String(input) === "/api/admin/ai/matches" && init?.method === "POST") {
      return new Response(JSON.stringify(error ? { error } : { gameId: "00000000-0000-4000-8000-000000000100" }), { status: error ? 429 : 201 });
    }
    return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("administrator AI-only arena", () => {
  it("starts one requested match with exactly the chosen model identities", async () => {
    const user = userEvent.setup();
    const fetchMock = mockArena();
    render(<AdminAiArena />);
    const first = await screen.findByRole("checkbox", { name: "Select Agent 1" });
    expect(screen.getByText("provider/model-1")).toBeInTheDocument();
    expect(screen.getByText(/\$10\.00 daily AI spending limit/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Select Agent 6" })).toBeDisabled();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    await user.click(first);
    expect(screen.getByRole("button", { name: "Start AI-only ranked match" })).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: "Select Agent 2" }));
    await user.dblClick(screen.getByRole("button", { name: "Start AI-only ranked match" }));

    expect(await screen.findByText("AI match started; results appear in AI matches rankings.")).toBeInTheDocument();
    expect(screen.getByText("00000000-0000-4000-8000-000000000100")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /watch/i })).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Select Agent 1" })).toBeDisabled();
    const posts = fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]![0]).toBe("/api/admin/ai/matches");
    expect(JSON.parse(String(posts[0]![1]?.body))).toEqual({ agentIds: roster.players.slice(0, 2).map((agent) => agent.id) });
  });

  it("requires six distinct available identities before a six-seat match can start", async () => {
    const user = userEvent.setup();
    const fetchMock = mockArena();
    render(<AdminAiArena />);
    await screen.findByRole("checkbox", { name: "Select Agent 1" });
    await user.click(screen.getByRole("radio", { name: /6-player AI match/ }));
    for (let index = 1; index <= 5; index += 1) await user.click(screen.getByRole("checkbox", { name: `Select Agent ${index}` }));
    expect(screen.getByRole("button", { name: "Start AI-only ranked match" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("6 available AI players; 5 currently available");
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  });

  it("surfaces a server budget rejection without reporting that a match started", async () => {
    const user = userEvent.setup();
    mockArena("The daily AI budget has been reached.");
    render(<AdminAiArena />);
    await user.click(await screen.findByRole("checkbox", { name: "Select Agent 1" }));
    await user.click(screen.getByRole("checkbox", { name: "Select Agent 2" }));
    await user.click(screen.getByRole("button", { name: "Start AI-only ranked match" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("daily AI budget");
    expect(screen.queryByText("AI match started; results appear in AI matches rankings.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh AI availability" })).toBeEnabled();
  });
});
