import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api";
import { BroadcastControls } from "./BroadcastControls";
import { liveName } from "./live.test-helpers";
vi.mock("./BroadcastPublisher", () => ({ BroadcastPublisher: () => <p>Publisher controls</p> }));
afterEach(() => vi.restoreAllMocks());
describe("participant broadcast withdrawal", () => {
  it("requires an explicit confirmation and stops both native and video sharing in the UI", async () => {
    const user = userEvent.setup(); const close = vi.spyOn(api, "closeLiveBroadcast").mockResolvedValue(undefined);
    render(<BroadcastControls gameName={liveName} />);
    await user.click(screen.getByText("Broadcasting all hands · 2-minute delay"));
    await user.click(screen.getByRole("button", { name: "Stop table broadcast" }));
    expect(close).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Yes, stop broadcasting" }));
    expect(await screen.findByRole("status")).toHaveTextContent("game continues privately");
    expect(screen.queryByText("Publisher controls")).not.toBeInTheDocument();
    expect(close).toHaveBeenCalledWith(liveName);
  });
});
