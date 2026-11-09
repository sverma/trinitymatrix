import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { PrivateRoom } from "@trinitymatrix/protocol";
import { PrivateRoomQueue } from "./Queue";

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

describe("PrivateRoomQueue", () => {
  it("shows joined and pending seats and protects creator cancellation with confirmation", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn().mockResolvedValue(undefined);
    render(<PrivateRoomQueue room={room} playerId={room.creator.playerId} onBack={vi.fn()} onCancel={onCancel} />);

    expect(screen.getByText("Private · Unranked · 2 players")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Invited players ready" })).toHaveAttribute("value", "1");
    expect(screen.getByRole("list", { name: "Private table seats" })).toHaveTextContent("AshaTable creatorReady");
    expect(screen.getByRole("list", { name: "Private table seats" })).toHaveTextContent("kabir@example.comInvited");

    await user.click(screen.getByRole("button", { name: "Cancel private table" }));
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByText("Cancel this table for everyone?")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Yes, cancel table" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("lets an invited player return safely while their accepted room remains active", async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    render(<PrivateRoomQueue
      room={{
        ...room,
        playerCount: 6,
        requiredCount: 6,
        acceptedCount: 2,
        invites: [
          { ...room.invites[0]!, status: "accepted", playerId: "00000000-0000-4000-8000-000000000002", displayName: "Kabir", isCurrentUser: true },
          { seatNumber: 2, status: "pending" },
          { seatNumber: 3, status: "pending" },
          { seatNumber: 4, status: "pending" },
          { seatNumber: 5, status: "pending" }
        ]
      }}
      playerId="00000000-0000-4000-8000-000000000002"
      onBack={onBack}
      onCancel={vi.fn()}
    />);

    expect(screen.queryByRole("button", { name: "Cancel private table" })).not.toBeInTheDocument();
    expect(screen.getByText("Invited player 2")).toBeInTheDocument();
    expect(screen.getByText("Seat 2")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back to lobby" }));
    expect(onBack).toHaveBeenCalledOnce();
  });
});
