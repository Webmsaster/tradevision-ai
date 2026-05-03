import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { Skeleton } from "@/components/Skeleton";

describe("Skeleton", () => {
  it("renders a single text skeleton by default", () => {
    const { container } = render(<Skeleton />);
    const items = container.querySelectorAll(".skeleton");
    expect(items.length).toBe(1);
    expect(items[0]!.className).toContain("skeleton-text");
  });

  it("renders count items", () => {
    const { container } = render(<Skeleton count={5} />);
    expect(container.querySelectorAll(".skeleton").length).toBe(5);
  });

  it("applies card variant class", () => {
    const { container } = render(<Skeleton variant="card" />);
    expect(container.querySelector(".skeleton-card")).toBeInTheDocument();
  });

  it("applies table-row variant class", () => {
    const { container } = render(<Skeleton variant="table-row" />);
    expect(container.querySelector(".skeleton-table-row")).toBeInTheDocument();
  });
});
