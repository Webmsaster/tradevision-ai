import { useEffect, useRef } from "react";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Round 58 Fix 4: module-level stack of active focus traps so nested
// modals (e.g. ConfirmDialog opened FROM TradeDetailModal) play nicely.
// Without it, every active trap installs its own keydown listener and
// they ALL try to handle Tab — the inner trap wraps focus correctly but
// the outer trap's restore-focus then targets a DOM node that no longer
// exists, breaking WCAG 2.4.3 (Focus Order). The stack ensures only the
// TOP trap handles Tab, and `document.body.contains` guards restore-focus
// against stale nodes.
const trapStack: HTMLElement[] = [];

export function _resetFocusTrapStackForTests() {
  trapStack.length = 0;
}

/**
 * Trap keyboard focus within a container while `active` is true.
 * Automatically focuses the first focusable element on activation
 * and restores focus to the previously focused element on deactivation.
 *
 * Multi-modal stacking: when nested traps are active, only the topmost
 * one handles Tab. Restore-focus is skipped if the saved element is no
 * longer in the document (prevents WCAG 2.4.3 violations on rapid
 * open/close).
 */
export function useFocusTrap(active: boolean) {
  const containerRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active || !containerRef.current) return;

    // Phase 67 (R45-UI-M2): only capture the previous-focused element
    // ONCE per active=true cycle. On rapid open/close/open transitions
    // the second activation captured a focusable INSIDE the modal as
    // "previous" — restore-focus then trapped the user back inside.
    if (previousFocusRef.current === null) {
      previousFocusRef.current = document.activeElement as HTMLElement;
    }

    const container = containerRef.current;
    trapStack.push(container);

    const focusableElements = () =>
      Array.from(
        container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((el) => el.offsetParent !== null); // visible only

    // Focus the first focusable element
    const elements = focusableElements();
    if (elements.length > 0) {
      elements[0]!.focus();
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== "Tab") return;
      // Only the topmost trap handles Tab — nested modals would
      // otherwise compete and produce inconsistent focus order.
      if (trapStack[trapStack.length - 1] !== container) return;

      const elements = focusableElements();
      if (elements.length === 0) return;

      // Guarded by elements.length === 0 above; non-null assertions here
      // are loop-invariant safe.
      const first = elements[0]!;
      const last = elements[elements.length - 1]!;

      if (e.shiftKey) {
        // Shift+Tab: if focus is on first element, wrap to last
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        // Tab: if focus is on last element, wrap to first
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      // Pop ourselves off the stack (use indexOf in case effects unmount
      // out-of-order under StrictMode / unusual renders).
      const idx = trapStack.lastIndexOf(container);
      if (idx !== -1) trapStack.splice(idx, 1);

      // Restore focus only if the previously-focused element is still in
      // the DOM. A no-longer-rendered target = silently swallow focus
      // (browser default = body) — that's still better than throwing or
      // focusing a detached node.
      const target = previousFocusRef.current;
      if (
        target &&
        typeof target.focus === "function" &&
        document.body.contains(target)
      ) {
        target.focus();
      }
      previousFocusRef.current = null;
    };
  }, [active]);

  return containerRef;
}
