import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ErrorBoundary } from "@/components/ErrorBoundary";

function ThrowingChild({
  message = "Boom",
}: {
  message?: string;
}): React.ReactElement {
  throw new Error(message);
}

describe("ErrorBoundary", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Silence React's error logging so test output stays clean
    consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("renders children when no error", () => {
    render(
      <ErrorBoundary>
        <div>Happy path</div>
      </ErrorBoundary>,
    );
    expect(screen.getByText("Happy path")).toBeInTheDocument();
  });

  it("renders fallback UI on child error", () => {
    render(
      <ErrorBoundary>
        <ThrowingChild />
      </ErrorBoundary>,
    );
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(screen.getByText(/unexpected error/i)).toBeInTheDocument();
  });

  it("displays the error message", () => {
    render(
      <ErrorBoundary>
        <ThrowingChild message="Specific failure" />
      </ErrorBoundary>,
    );
    expect(screen.getByText("Specific failure")).toBeInTheDocument();
  });

  it("renders Try again and dashboard buttons", () => {
    render(
      <ErrorBoundary>
        <ThrowingChild />
      </ErrorBoundary>,
    );
    expect(screen.getByText("Try again")).toBeInTheDocument();
    const dashLink = screen.getByText("Go to Dashboard");
    expect(dashLink.getAttribute("href")).toBe("/");
  });

  it("recovers when Try again is clicked and child no longer throws", () => {
    let shouldThrow = true;
    function ConditionalChild(): React.ReactElement {
      if (shouldThrow) throw new Error("First render fail");
      return <div>Recovered</div>;
    }

    const { rerender } = render(
      <ErrorBoundary>
        <ConditionalChild />
      </ErrorBoundary>,
    );
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();

    shouldThrow = false;
    fireEvent.click(screen.getByText("Try again"));
    rerender(
      <ErrorBoundary>
        <ConditionalChild />
      </ErrorBoundary>,
    );
    expect(screen.getByText("Recovered")).toBeInTheDocument();
  });
});
