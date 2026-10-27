type FocusBoundary = Pick<HTMLElement, "contains">;
type FocusVisibilityBoundary = Pick<HTMLElement, "closest">;

export function isModalFocusableVisible(candidate: FocusVisibilityBoundary): boolean {
  return candidate.closest(':disabled, [hidden], [aria-hidden="true"], [inert]') === null;
}

export function shouldApplyModalInitialFocus(
  dialog: FocusBoundary | null,
  scheduledActiveElement: Element | null,
  activeElement: Element | null
) {
  return Boolean(dialog && (
    activeElement === scheduledActiveElement
    || !activeElement
    || !dialog.contains(activeElement)
  ));
}
