import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import ConfirmDialog from "@/components/ConfirmDialog";

describe("ConfirmDialog", () => {
  it("renders nothing when closed", () => {
    const { container } = render(
      <ConfirmDialog
        isOpen={false}
        title="Delete?"
        message="Are you sure?"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders title and message when open", () => {
    render(
      <ConfirmDialog
        isOpen
        title="Delete Trade"
        message="This cannot be undone."
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText("Delete Trade")).toBeInTheDocument();
    expect(screen.getByText("This cannot be undone.")).toBeInTheDocument();
  });

  it("uses default button labels", () => {
    render(
      <ConfirmDialog
        isOpen
        title="T"
        message="M"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText("Confirm")).toBeInTheDocument();
    expect(screen.getByText("Cancel")).toBeInTheDocument();
  });

  it("uses custom button labels", () => {
    render(
      <ConfirmDialog
        isOpen
        title="T"
        message="M"
        confirmLabel="Delete"
        cancelLabel="Keep"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText("Delete")).toBeInTheDocument();
    expect(screen.getByText("Keep")).toBeInTheDocument();
  });

  it("calls onConfirm when confirm button clicked", () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        isOpen
        title="T"
        message="M"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("Confirm"));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("calls onCancel when cancel button clicked", () => {
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        isOpen
        title="T"
        message="M"
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByText("Cancel"));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("calls onCancel when overlay clicked", () => {
    const onCancel = vi.fn();
    const { container } = render(
      <ConfirmDialog
        isOpen
        title="T"
        message="M"
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );
    const overlay = container.querySelector(".confirm-overlay")!;
    fireEvent.click(overlay);
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("does not call onCancel when dialog body clicked", () => {
    const onCancel = vi.fn();
    const { container } = render(
      <ConfirmDialog
        isOpen
        title="T"
        message="M"
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );
    const dialog = container.querySelector(".confirm-dialog")!;
    fireEvent.click(dialog);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("calls onCancel when Escape pressed", () => {
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        isOpen
        title="T"
        message="M"
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("has proper aria attributes", () => {
    const { container } = render(
      <ConfirmDialog
        isOpen
        title="T"
        message="M"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const overlay = container.querySelector('[role="dialog"]');
    expect(overlay).toHaveAttribute("aria-modal", "true");
    expect(overlay).toHaveAttribute("aria-labelledby", "confirm-title");
  });

  it("locks body scroll when open", () => {
    const { unmount } = render(
      <ConfirmDialog
        isOpen
        title="T"
        message="M"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(document.body.style.overflow).toBe("hidden");
    unmount();
    expect(document.body.style.overflow).toBe("");
  });
});
