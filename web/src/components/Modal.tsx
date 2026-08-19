import { useEffect } from "react";
import { createPortal } from "react-dom";

type Props = {
  title: string;
  sub?: string;
  onClose: () => void;
  children: React.ReactNode;
  /** extra classes for the card, e.g. "mixer-card" */
  className?: string;
  /** extra classes for the overlay, e.g. "sync-overlay" */
  overlayClassName?: string;
};

/** Shared modal shell — closes when the overlay outside the card is clicked. */
export function Modal({
  title,
  sub,
  onClose,
  children,
  className,
  overlayClassName,
}: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div
      className={`modal-overlay${overlayClassName ? ` ${overlayClassName}` : ""}`}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`modal-card${className ? ` ${className}` : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-head">
          <p className="modal-title">
            {title}
            {sub && <span className="modal-sub"> · {sub}</span>}
          </p>
          <button
            type="button"
            className="modal-close"
            aria-label="Close"
            onClick={onClose}
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}
