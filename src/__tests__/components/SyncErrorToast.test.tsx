import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import SyncErrorToast from "@/components/SyncErrorToast";

describe("SyncErrorToast", () => {
  it("renders nothing when message is null", () => {
    const { container } = render(
      <SyncErrorToast message={null} onDismiss={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders the message when provided", () => {
    render(<SyncErrorToast message="Sync failed" onDismiss={vi.fn()} />);
    expect(screen.getByText("Sync failed")).toBeInTheDocument();
  });

  it('has role="alert" for accessibility', () => {
    render(<SyncErrorToast message="Sync failed" onDismiss={vi.fn()} />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("calls onDismiss when dismiss button clicked", () => {
    const onDismiss = vi.fn();
    render(<SyncErrorToast message="Sync failed" onDismiss={onDismiss} />);
    fireEvent.click(screen.getByLabelText("Dismiss"));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("calls onDismiss on Escape key", () => {
    const onDismiss = vi.fn();
    render(<SyncErrorToast message="Sync failed" onDismiss={onDismiss} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("does not attach Escape listener when message is null", () => {
    const onDismiss = vi.fn();
    render(<SyncErrorToast message={null} onDismiss={onDismiss} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
