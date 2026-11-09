import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrivateInvitation, PrivateRoom } from "@trinitymatrix/protocol";
import { Lobby } from "./Lobby";

const room: PrivateRoom = {
  roomCode: "amber-table-123456",
  playerCount: 2,
  status: "waiting",
  creator: { playerId: "00000000-0000-4000-8000-000000000001", displayName: "Asha" },
  invites: [{ seatNumber: 1, email: "kabir@example.com", status: "pending" }],
  acceptedCount: 1,
  requiredCount: 2,
  createdAt: "2026-08-24T09:00:00.000Z"
};

const invitation: PrivateInvitation = {
  roomCode: room.roomCode,
  playerCount: 2,
  creatorDisplayName: "Asha",
  status: "pending",
  createdAt: room.createdAt
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ invitations: [], createdRooms: [] }), { status: 200 })));
});

afterEach(() => vi.unstubAllGlobals());

describe("Lobby", () => {
  const player = {
    id: "00000000-0000-4000-8000-000000000001",
    email: "asha@example.com",
    displayName: "Asha",
    badgeId: "rookie" as const,
    phone: null,
    createdAt: 1,
    updatedAt: 1
  };

  it("offers only separate 2-player and 6-player ranking queues", async () => {
    const user = userEvent.setup();
    const onJoin = vi.fn();
    render(<Lobby player={player} onJoin={onJoin} onLogout={vi.fn()} onUpdateProfile={vi.fn()} />);

    expect(screen.getByRole("heading", { level: 1, name: "Make every meld count." })).toBeInTheDocument();
    expect(screen.getByText("Every total is a multiple of 3")).toBeInTheDocument();
    expect(screen.getByText("Natural cards only—no joker or wild")).toBeInTheDocument();
    expect(screen.getByText("Higher melds are invalid")).toBeInTheDocument();
    expect(screen.getByText("Ranking")).toBeInTheDocument();
    expect(screen.getByText("Points")).toBeInTheDocument();
    expect(screen.queryByText(/cash/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: /full table/i }));
    await user.click(screen.getByRole("button", { name: /find a 6-player match/i }));
    expect(onJoin).toHaveBeenCalledWith(6);
  });

  it("lets the signed-in player edit their name, badge, and optional phone", async () => {
    const user = userEvent.setup();
    const onUpdateProfile = vi.fn().mockResolvedValue(undefined);
    render(<Lobby player={player} onJoin={vi.fn()} onLogout={vi.fn()} onUpdateProfile={onUpdateProfile} />);

    await user.click(screen.getByRole("button", { name: "Open profile for Asha" }));
    expect(screen.getByRole("dialog", { name: "Make the table yours" })).toBeInTheDocument();
    expect(screen.getByLabelText("Email address")).toHaveValue("asha@example.com");
    await user.clear(screen.getByLabelText("Display name"));
    await user.type(screen.getByLabelText("Display name"), "Asha V");
    await user.click(screen.getByRole("radio", { name: /Strategist/i }));
    await user.clear(screen.getByLabelText("ISD code"));
    await user.type(screen.getByLabelText("ISD code"), "44");
    await user.type(screen.getByLabelText("National number"), "7700900123");
    await user.click(screen.getByRole("button", { name: "Save profile" }));

    expect(onUpdateProfile).toHaveBeenCalledWith({
      displayName: "Asha V",
      badgeId: "strategist",
      phone: { countryCode: "+44", nationalNumber: "7700900123" }
    });
  });

  it("requires exactly one or five distinct invite emails before creating a private table", async () => {
    const user = userEvent.setup();
    const onOpenPrivateRoom = vi.fn();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") return new Response(JSON.stringify({ room: { ...room, playerCount: 6, requiredCount: 6, invites: [
        "one@example.com", "two@example.com", "three@example.com", "four@example.com", "five@example.com"
      ].map((email, index) => ({ seatNumber: index + 1, email, status: "pending" })) } }), { status: 201 });
      return new Response(JSON.stringify({ invitations: [], createdRooms: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<Lobby player={player} onJoin={vi.fn()} onLogout={vi.fn()} onUpdateProfile={vi.fn()} onOpenPrivateRoom={onOpenPrivateRoom} />);

    await user.click(screen.getByRole("button", { name: /Private table.*Invite-only/i }));
    expect(screen.getByRole("textbox", { name: "Invite 1 email" })).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: /Five friends/i }));
    const inputs = screen.getAllByRole("textbox", { name: /Invite \d email/ });
    expect(inputs).toHaveLength(5);
    for (const [index, input] of inputs.entries()) await user.type(input, index < 2 ? "same@example.com" : `${index + 1}@example.com`);
    await user.click(screen.getByRole("button", { name: "Create 6-player private table" }));
    expect(screen.getByRole("alert")).toHaveTextContent("different email address");

    await user.clear(inputs[1]!);
    await user.type(inputs[1]!, "two@example.com");
    await user.click(screen.getByRole("button", { name: "Create 6-player private table" }));
    expect(onOpenPrivateRoom).toHaveBeenCalledWith(expect.objectContaining({ playerCount: 6 }));
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(JSON.parse(String(post[1]?.body))).toEqual({
      playerCount: 6,
      inviteEmails: ["same@example.com", "two@example.com", "3@example.com", "4@example.com", "5@example.com"]
    });
  });

  it("shows a recoverable error when a private-table response is incomplete", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") return new Response(JSON.stringify({}), { status: 201 });
      return new Response(JSON.stringify({ invitations: [], createdRooms: [] }), { status: 200 });
    }));
    render(<Lobby player={player} onJoin={vi.fn()} onLogout={vi.fn()} onUpdateProfile={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /Private table.*Invite-only/i }));
    await user.type(screen.getByRole("textbox", { name: "Invite 1 email" }), "guest@example.com");
    await user.click(screen.getByRole("button", { name: "Create 2-player private table" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("private table response was incomplete");
    expect(screen.getByRole("heading", { name: "Make every meld count." })).toBeInTheDocument();
  });

  it("shows and accepts a received private invitation without hiding general matchmaking", async () => {
    const user = userEvent.setup();
    const onOpenPrivateRoom = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/private-matches" && !init?.method) return new Response(JSON.stringify({ invitations: [invitation], createdRooms: [] }), { status: 200 });
      if (url.endsWith("/accept")) return new Response(JSON.stringify({ room: { ...room, invites: [{ ...room.invites[0]!, status: "accepted", playerId: "00000000-0000-4000-8000-000000000002", displayName: "Kabir" }], acceptedCount: 2 } }), { status: 200 });
      return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
    }));
    render(<Lobby player={{ ...player, id: "00000000-0000-4000-8000-000000000002", email: "kabir@example.com", displayName: "Kabir" }} onJoin={vi.fn()} onLogout={vi.fn()} onUpdateProfile={vi.fn()} onOpenPrivateRoom={onOpenPrivateRoom} />);

    expect(await screen.findByRole("heading", { name: "Private tables waiting for you" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Find a 2-player match/i })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Accept invitation" }));
    expect(onOpenPrivateRoom).toHaveBeenCalledWith(expect.objectContaining({ acceptedCount: 2 }));
  });
});
