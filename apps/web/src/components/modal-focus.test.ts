import { describe, expect, it } from "vitest";
import { isModalFocusableVisible, shouldApplyModalInitialFocus } from "./modal-focus.js";

describe("shouldApplyModalInitialFocus", () => {
  it("does not steal focus after the user has focused another control in the modal", () => {
    const scheduledActiveElement = {} as Element;
    const activeElement = {} as Element;
    const dialog = {
      contains: (candidate: Node | null) => candidate === activeElement
    };

    expect(shouldApplyModalInitialFocus(dialog, scheduledActiveElement, activeElement)).toBe(false);
  });

  it("applies initial focus while focus remains outside the modal", () => {
    const activeElement = {} as Element;
    const dialog = { contains: () => false };

    expect(shouldApplyModalInitialFocus(dialog, activeElement, activeElement)).toBe(true);
  });

  it("retains focusKey refocusing when the active control has not changed", () => {
    const activeElement = {} as Element;
    const dialog = { contains: () => true };

    expect(shouldApplyModalInitialFocus(dialog, activeElement, activeElement)).toBe(true);
  });

  it("does nothing when the modal has already unmounted", () => {
    expect(shouldApplyModalInitialFocus(null, null, null)).toBe(false);
  });
});

describe("isModalFocusableVisible", () => {
  it("excludes controls inside hidden or aria-hidden panels from the focus boundary", () => {
    const visible = { closest: () => null };
    const hidden = { closest: () => ({}) as Element };

    expect(isModalFocusableVisible(visible)).toBe(true);
    expect(isModalFocusableVisible(hidden)).toBe(false);
  });

  it("excludes controls inside inert or disabled interaction regions", () => {
    const inert = {
      closest: (selector: string) => selector.includes("[inert]") ? ({} as Element) : null
    };
    const disabled = {
      closest: (selector: string) => selector.includes(":disabled") ? ({} as Element) : null
    };

    expect(isModalFocusableVisible(inert)).toBe(false);
    expect(isModalFocusableVisible(disabled)).toBe(false);
  });
});
