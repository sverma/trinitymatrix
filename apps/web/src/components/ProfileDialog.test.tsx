import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AuthPlayer } from "../api";
import { ProfileDialog } from "./ProfileDialog";

const player: AuthPlayer = {
  id: "p1",
  email: "asha@example.com",
  displayName: "Asha",
  badgeId: "strategist",
  phone: null,
  createdAt: 1,
  updatedAt: 1
};

describe("ProfileDialog", () => {
  it("prevents every close action while a profile save is in progress", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onSave = vi.fn(() => new Promise<void>(() => undefined));
    render(<ProfileDialog player={player} onClose={onClose} onSave={onSave} />);

    await user.click(screen.getByRole("button", { name: "Save profile" }));

    expect(onSave).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Close profile" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Close profile" }));
    expect(onClose).not.toHaveBeenCalled();
  });
});
