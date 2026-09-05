import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

/**
 * Slide-over panel holding the simulation controls and settings.
 *
 * ## Why these moved off the page
 *
 * Controls and settings occupied a full row directly above the live view. That row is prime space, and after
 * the first ten seconds of a demo nobody touches it — you press RUN DEMO, then you watch. Keeping it inline
 * pushed the partition grid, the conflict feed and the activity stream a screen further down.
 *
 * A drawer is the right shape for controls that are essential but intermittent: one click away, zero cost
 * when closed. It is not a modal in the blocking sense — the run keeps going behind it and the pinned status
 * strip stays visible, so you can pause or crash the job without losing sight of what it was doing.
 */

export interface ControlsDrawerProps {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}

export function ControlsDrawer({ open, onClose, children }: ControlsDrawerProps) {
  const closeRef = useRef<HTMLButtonElement>(null);

  /**
   * Escape closes it, and focus moves inside on open.
   *
   * Same reasoning as the patient drawer: a panel a keyboard user can open but not dismiss, or one that leaves
   * focus stranded behind it, is worse than no panel (R24.6).
   */
  useEffect(() => {
    if (!open) return;

    closeRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-slate-900/30" onClick={onClose} aria-hidden="true" />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="controls-drawer-heading"
        className="relative flex h-full w-full max-w-2xl flex-col overflow-y-auto bg-slate-50 shadow-xl"
      >
        <header className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-slate-200 bg-white px-5 py-3.5">
          <div>
            <h2 id="controls-drawer-heading" className="text-base font-semibold text-slate-900">
              Controls and settings
            </h2>
            <p className="mt-0.5 text-xs text-slate-600">
              The run continues while this is open. Unavailable controls explain why.
            </p>
          </div>

          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-800"
            aria-label="Close controls"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>

        <div className="space-y-4 p-5">{children}</div>
      </div>
    </div>
  );
}
