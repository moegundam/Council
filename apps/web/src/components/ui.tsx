"use client";

import { AlertTriangle, RefreshCw, X } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { isModalFocusableVisible, shouldApplyModalInitialFocus } from "./modal-focus";

const focusableSelector = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function modalFocusableElements(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(focusableSelector)).filter(isModalFocusableVisible);
}

export function PageState({ loading, error }: { loading: boolean; error: string | null }) {
  if (loading) return <main className="page-state"><span className="spinner" />載入中</main>;
  if (error) return <main className="page-state error-state">{error}</main>;
  return null;
}

export function Modal({
  title,
  open,
  onClose,
  children,
  closeDisabled = false,
  describedBy,
  busy = false,
  focusKey,
  restoreFocusId,
  variant = "dialog"
}: {
  title: string;
  open: boolean;
  onClose(): void;
  children: ReactNode;
  closeDisabled?: boolean;
  describedBy?: string | undefined;
  busy?: boolean;
  focusKey?: string | number | undefined;
  restoreFocusId?: string | undefined;
  variant?: "dialog" | "drawer";
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  const closeDisabledRef = useRef(closeDisabled);
  const restoreFocusIdRef = useRef(restoreFocusId);
  const titleId = useId();

  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => { closeDisabledRef.current = closeDisabled; }, [closeDisabled]);
  useEffect(() => { restoreFocusIdRef.current = restoreFocusId; }, [restoreFocusId]);

  useEffect(() => {
    if (!open) return;
    const scheduledActiveElement = document.activeElement;
    const frame = requestAnimationFrame(() => {
      const dialog = dialogRef.current;
      if (!shouldApplyModalInitialFocus(dialog, scheduledActiveElement, document.activeElement)) return;
      const body = dialog?.querySelector<HTMLElement>(".modal-body");
      const firstBodyControl = body ? modalFocusableElements(body)[0] : undefined;
      const firstDialogControl = dialog ? modalFocusableElements(dialog)[0] : undefined;
      (firstBodyControl ?? firstDialogControl ?? dialog)?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [focusKey, open]);

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!closeDisabledRef.current) onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const focusable = modalFocusableElements(dialog);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      if (!active || !focusable.includes(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      const fallback = restoreFocusIdRef.current ? document.getElementById(restoreFocusIdRef.current) : null;
      (previousFocus?.isConnected ? previousFocus : fallback)?.focus();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className={`modal-backdrop ${variant === "drawer" ? "drawer-backdrop" : ""}`} role="presentation" onMouseDown={(event) => { if (!closeDisabled && event.target === event.currentTarget) onClose(); }}>
      <section ref={dialogRef} className={`modal ${variant === "drawer" ? "modal-drawer" : ""}`} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={describedBy} aria-busy={busy || undefined} tabIndex={-1}>
        <header><h2 id={titleId}>{title}</h2><button className="icon-button" disabled={closeDisabled} onClick={onClose} aria-label="關閉" title="關閉"><X size={16} /></button></header>
        <div className="modal-body">{children}</div>
      </section>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty-state">{children}</div>;
}

export function ActionNotice({ message, error = false }: { message: string; error?: boolean }) {
  if (!message) return null;
  return <div className={`action-notice ${error ? "error" : ""}`} role={error ? "alert" : "status"}>{message}</div>;
}

export function ProjectionFreshnessWarning({
  message,
  refreshing,
  onRetry,
  retryLabel,
  className = ""
}: {
  message: string;
  refreshing: boolean;
  onRetry(): void;
  retryLabel: string;
  className?: string;
}) {
  return <div className={`projection-freshness-warning ${className}`.trim()} role="alert">
    <AlertTriangle size={14} aria-hidden="true" />
    <span>{message}</span>
    <button className="icon-button" type="button" disabled={refreshing} onClick={onRetry} aria-label={retryLabel} title={retryLabel}>
      <RefreshCw size={14} className={refreshing ? "spin-icon" : undefined} />
    </button>
  </div>;
}
