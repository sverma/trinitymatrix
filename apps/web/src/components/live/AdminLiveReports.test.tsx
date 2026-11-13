import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api";
import { AdminLiveReports } from "./AdminLiveReports";
import { liveComment, liveName } from "./live.test-helpers";
afterEach(() => vi.restoreAllMocks());
describe("broadcast report moderation", () => {
  it("lets an unlocked administrator resolve a report by removing its released comment", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "broadcastReports").mockResolvedValue({ reports: [{ id: "report1", broadcastName: liveName, comment: liveComment("Reported text"), reason: "Spam", createdAt: Date.now() }], nextCursor: null });
    const resolve = vi.spyOn(api, "resolveBroadcastReport").mockResolvedValue(undefined);
    render(<AdminLiveReports />);
    await user.click(await screen.findByRole("button", { name: "Remove reported message" }));
    expect(await screen.findByRole("heading", { name: "No pending reports" })).toBeInTheDocument();
    expect(resolve).toHaveBeenCalledWith("report1", true);
  });
});
