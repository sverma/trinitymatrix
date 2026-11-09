import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { getPolicyPage, PolicyFooter, PolicyPage, policyLastUpdated, policyLinks } from "./PolicyPages";

describe("PolicyPages", () => {
  it.each(policyLinks)("resolves the public $path route", ({ path }) => {
    const page = getPolicyPage(`${path}/`);
    expect(page).not.toBeNull();
    expect(page?.path).toBe(path);
    expect(page?.title).not.toBe("");
  });

  it("does not intercept unrelated application routes", () => {
    expect(getPolicyPage("/")).toBeNull();
    expect(getPolicyPage("/admin")).toBeNull();
    expect(getPolicyPage("/terms/not-a-page")).toBeNull();
  });

  it("renders a semantic, navigable policy page with publication blockers", () => {
    const terms = getPolicyPage("/terms");
    if (!terms) throw new Error("Terms policy fixture is missing.");
    render(<PolicyPage page={terms} />);

    expect(screen.getByRole("main")).toHaveAttribute("id", "main-content");
    expect(screen.getByRole("heading", { level: 1, name: "Terms of Service" })).toBeInTheDocument();
    expect(screen.getByRole("note", { name: "Publication status" })).toHaveTextContent("not approved for production publication");
    expect(screen.getByText(new RegExp(`Draft last updated ${policyLastUpdated}`))).toBeInTheDocument();
    expect(screen.getByText(/legal entity name — required before launch/i)).toBeInTheDocument();

    const index = screen.getByRole("navigation", { name: "Policy pages" });
    expect(within(index).getAllByRole("link")).toHaveLength(policyLinks.length);
    expect(within(index).getByRole("link", { name: "Terms of Service" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Back to game" })).toHaveAttribute("href", "/");
  });

  it("exposes every policy and support destination from the shared footer", () => {
    render(<PolicyFooter />);
    const footerNav = screen.getByRole("navigation", { name: "Policies and support" });
    for (const { path, label } of policyLinks) {
      expect(within(footerNav).getByRole("link", { name: label })).toHaveAttribute("href", path);
    }
    expect(screen.getByText(/free social play · 18\+/i)).toBeInTheDocument();
  });

  it("states the complete Trinity meld contract without stale source branding", () => {
    const fairPlay = getPolicyPage("/fair-play");
    if (!fairPlay) throw new Error("Fair-play policy fixture is missing.");
    render(<PolicyPage page={fairPlay} />);

    expect(screen.getByText(/every meld contains at least three cards/i)).toBeInTheDocument();
    expect(screen.getByText(/3, 6, 9, 12, 15, 18, 21, 24 or 27/i)).toBeInTheDocument();
    expect(screen.getByText(/above 27 is invalid even when divisible by three/i)).toBeInTheDocument();
    expect(screen.getByText(/at least one natural-card meld totals exactly 21/i)).toBeInTheDocument();
    expect(screen.getByText(/21-point Trinity meld cannot contain either kind of wild card/i)).toBeInTheDocument();
    expect(screen.queryByText(/rummymatrix/i)).not.toBeInTheDocument();
  });
});
