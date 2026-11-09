import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthFlow } from "./AuthFlow";

afterEach(() => vi.unstubAllGlobals());

describe("AuthFlow", () => {
  it("moves from email entry to six-digit mock OTP verification", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ challengeId: "00000000-0000-4000-8000-000000000001", delivery: "mock" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ player: {
        id: "00000000-0000-4000-8000-000000000010",
        email: "asha@example.com",
        displayName: "Asha",
        badgeId: "rookie",
        phone: null,
        createdAt: 1,
        updatedAt: 1
      } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const authenticated = vi.fn();
    render(<AuthFlow onAuthenticated={authenticated} />);

    expect(screen.getByRole("heading", { level: 1, name: "Find your 21." })).toBeInTheDocument();
    expect(screen.getByText("At least 3 cards, totaling a multiple of 3")).toBeInTheDocument();
    expect(screen.getByText("Natural cards only—no joker or wild")).toBeInTheDocument();
    expect(screen.getByText("The highest valid meld total")).toBeInTheDocument();
    expect(screen.queryByText(/original trinity rules/i)).not.toBeInTheDocument();
    const policyNavigation = screen.getByRole("navigation", { name: "Policies and support" });
    expect(within(policyNavigation).getByRole("link", { name: "Terms of Service" })).toHaveAttribute("href", "/terms");
    expect(within(policyNavigation).getByRole("link", { name: "Privacy Policy" })).toHaveAttribute("href", "/privacy");
    expect(screen.getByText(/you must be 18 or older/i)).toBeInTheDocument();

    await user.type(screen.getByLabelText(/display name/i), "Asha");
    await user.type(screen.getByLabelText(/email address/i), "Asha@Example.com");
    await user.click(screen.getByRole("button", { name: /send verification code/i }));
    expect(await screen.findByText(/local email delivery is mocked/i)).toBeInTheDocument();
    await user.type(await screen.findByLabelText(/six-digit otp/i), "123456");
    await user.click(screen.getByRole("button", { name: /continue to lobby/i }));

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/auth/request-otp", expect.objectContaining({
      body: JSON.stringify({ email: "Asha@Example.com" })
    }));
    expect(authenticated).toHaveBeenCalledWith(expect.objectContaining({
      email: "asha@example.com",
      displayName: "Asha",
      badgeId: "rookie"
    }));
  });

  it("describes real email delivery without exposing the mock verification code", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      challengeId: "00000000-0000-4000-8000-000000000001",
      delivery: "email"
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    render(<AuthFlow onAuthenticated={vi.fn()} />);
    await user.type(screen.getByLabelText(/display name/i), "Asha");
    await user.type(screen.getByLabelText(/email address/i), "asha@example.com");
    await user.click(screen.getByRole("button", { name: /send verification code/i }));

    expect(await screen.findByText(/sent a six-digit code/i)).toHaveTextContent("asha@example.com");
    expect(screen.getByText(/expires in five minutes/i)).toBeInTheDocument();
    expect(screen.queryByText("123456")).not.toBeInTheDocument();
  });
});
