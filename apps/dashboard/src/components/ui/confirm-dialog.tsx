"use client";

import { useEffect } from "react";
import { Button } from "./button";

/**
 * Replacement for window.confirm on destructive actions.
 *
 * Pattern:
 *   const [pendingDelete, setPendingDelete] = useState(false);
 *   ...
 *   <ConfirmDialog
 *     open={pendingDelete}
 *     title="Delete this proxy?"
 *     body="Request history is cascaded. This can't be undone."
 *     confirmLabel="Delete"
 *     variant="destructive"
 *     onConfirm={() => { setPendingDelete(false); remove.mutate(); }}
 *     onCancel={() => setPendingDelete(false)}
 *   />
 *
 * Escape closes (treated as cancel). Backdrop click closes. No focus
 * trap — the confirm button autofocuses, which is the common case;
 * we keep it light rather than reaching for a focus-trap library.
 */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  variant = "default",
  disabled = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "default" | "destructive";
  disabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): React.JSX.Element | null {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="w-full max-w-sm overflow-hidden rounded-xl border border-border bg-card shadow-xl">
        <div className="p-5">
          <h2 id="confirm-title" className="text-base font-semibold">
            {title}
          </h2>
          <div className="mt-2 text-sm text-muted-foreground">{body}</div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border bg-secondary/30 px-5 py-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onCancel}
            disabled={disabled}
          >
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant={variant === "destructive" ? "destructive" : "accent"}
            size="sm"
            onClick={onConfirm}
            disabled={disabled}
            autoFocus
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
