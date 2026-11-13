import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiPlayer, AiPlayerRoster } from "../api";
import { AiPlayers } from "./AiPlayers";

const agents: AiPlayer[] = Array.from({ length: 6 }, (_, index) => ({
  id: `00000000-0000-4000-8000-00000000000${index + 1}`,
  displayName: `Agent ${index + 1}`,
  modelId: `provider/model-${index + 1}`,
  modelName: `Model ${index + 1}`,
  available: index < 5,
  ...(index === 5 ? { reason: "Already at a table" } : {}),
  rating: 1000,
  gamesPlayed: 0,
  wins: 0
}));

function mockArena(roster: AiPlayerRoster = { enabled: true, players: agents, dailyBudgetUsd: 10 }, matchError?: string) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "/api/ai/players") return new Response(JSON.stringify(roster), { status: 200 });
    if (String(input) === "/api/ai/matches" && init?.method === "POST") {
      return new Response(JSON.stringify(matchError ? { error: matchError } : { gameId: "00000000-0000-4000-8000-000000000100" }), { status: matchError ? 409 : 201 });
    }
    return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("AI opponent selection", () => {
  it("shows exact model identities and starts only the selected available opponent", async () => {
    const user = userEvent.setup();
    const fetchMock = mockArena();
    render(<AiPlayers connected privateTableOpen={false} />);

    const first = await screen.findByRole("radio", { name: "Select Agent 1" });
    expect(screen.getByText("provider/model-1")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Select Agent 6" })).toBeDisabled();
    expect(screen.getByText("Already at a table")).toBeInTheDocument();
    expect(screen.getByText(/\$10\.00 daily AI spending limit/)).toBeInTheDocument();
    const start = screen.getByRole("button", { name: "Play against selected AI" });
    expect(start).toBeDisabled();

    await user.click(first);
    expect(screen.getByRole("radio", { name: "Select Agent 2" })).toBeEnabled();
    await user.click(start);

    expect(await screen.findByRole("status")).toHaveTextContent("AI table created");
    expect(screen.getByRole("button", { name: "Opening AI table…" })).toBeDisabled();
    const posts = fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String(posts[0]![1]?.body))).toEqual({ agentIds: [agents[0]!.id] });
  });

  it("requires five different AI players for a six-seat match", async () => {
    const user = userEvent.setup();
    const fetchMock = mockArena();
    render(<AiPlayers connected privateTableOpen={false} />);
    await screen.findByRole("radio", { name: "Select Agent 1" });
    await user.click(screen.getByRole("radio", { name: /Five AI opponents/ }));
    const start = screen.getByRole("button", { name: "Play against selected AIs" });
    for (let index = 1; index <= 4; index += 1) await user.click(screen.getByRole("checkbox", { name: `Select Agent ${index}` }));
    expect(start).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: "Select Agent 5" }));
    expect(start).toBeEnabled();
    await user.click(start);
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(JSON.parse(String(post[1]?.body))).toEqual({ agentIds: agents.slice(0, 5).map((agent) => agent.id) });
  });

  it("selects players beyond the original five while preserving the five-opponent table limit", async () => {
    const user = userEvent.setup();
    const expanded = Array.from({ length: 8 }, (_, index) => ({
      ...agents[0]!,
      id: `00000000-0000-4000-8000-00000000000${index + 1}`,
      displayName: `Agent ${index + 1}`,
      modelId: `provider/model-${index + 1}-explicitly-versioned-language-model`,
      modelName: `Model ${index + 1}`,
      available: index !== 2,
      ...(index === 2 ? { reason: "Model paused for qualification" } : {})
    }));
    const fetchMock = mockArena({ enabled: true, players: expanded, dailyBudgetUsd: 10 });
    render(<AiPlayers connected privateTableOpen={false} />);
    await user.click(await screen.findByRole("radio", { name: "Select Agent 8" }));
    expect(screen.getAllByRole("radio", { name: /^Select Agent/ })).toHaveLength(8);
    expect(screen.getByRole("radio", { name: "Select Agent 8" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Select Agent 3" })).toBeDisabled();
    expect(screen.getByText(expanded[7]!.modelId)).toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: /Five AI opponents/ }));
    expect(screen.getAllByRole("checkbox", { name: /^Select Agent/ })).toHaveLength(8);
    const selected = [0, 1, 4, 6, 7];
    for (const index of selected) await user.click(screen.getByRole("checkbox", { name: `Select Agent ${index + 1}` }));
    expect(screen.getByRole("checkbox", { name: "Select Agent 4" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Play against selected AIs" }));
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(JSON.parse(String(post[1]?.body))).toEqual({ agentIds: selected.map((index) => expanded[index]!.id) });
  });

  it("keeps a failed reservation recoverable and shows the server's availability reason", async () => {
    const user = userEvent.setup();
    mockArena(undefined, "The daily AI budget has been reached.");
    render(<AiPlayers connected privateTableOpen={false} />);
    await user.click(await screen.findByRole("radio", { name: "Select Agent 1" }));
    await user.click(screen.getByRole("button", { name: "Play against selected AI" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("daily AI budget");
    expect(screen.getByRole("button", { name: "Refresh AI players" })).toBeEnabled();
  });

  it("does not start games while the socket is disconnected or a private table is open", async () => {
    const user = userEvent.setup();
    const fetchMock = mockArena();
    const { rerender } = render(<AiPlayers connected={false} privateTableOpen={false} />);
    await user.click(await screen.findByRole("radio", { name: "Select Agent 1" }));
    expect(screen.getByRole("button", { name: "Play against selected AI" })).toBeDisabled();
    expect(screen.getByText("Waiting for your game connection…")).toBeInTheDocument();
    rerender(<AiPlayers connected privateTableOpen />);
    expect(screen.getByRole("button", { name: "Play against selected AI" })).toBeDisabled();
    expect(screen.getByText(/cancel your existing private table/)).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  });

  it("keeps the lobby usable when no model-backed players are configured", async () => {
    mockArena({ enabled: false, players: [], dailyBudgetUsd: 10 });
    render(<AiPlayers connected privateTableOpen={false} />);
    expect(await screen.findByRole("heading", { name: "AI players are unavailable" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Play against/ })).not.toBeInTheDocument();
  });
});
