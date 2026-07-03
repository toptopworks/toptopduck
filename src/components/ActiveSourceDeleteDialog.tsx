import { useEffect, useState } from "react";
import type { DatasetDescriptor } from "../types";

// Issue #39 / ADR-0035 confirm dialog: shown when the user removes the ACTIVE
// source while OTHER sources remain. Removing the active source would silently
// move the user's focus -- instead the user explicitly picks one of the
// remaining sources to continue with, or cancels (no IPC call, no change).
//
// `candidates` is the FULL remaining source set (AC5: every source but the one
// being removed). Exactly one must be chosen before Confirm is enabled; the
// first candidate is pre-selected so a single Confirm suffices for the common
// case (the user already chose to delete; picking a continuation is the path of
// least resistance, and they can re-pick any other). A Cancel is a no-op --
// nothing crosses IPC and the working set stays put (AC3).
export function ActiveSourceDeleteDialog({
  target,
  candidates,
  onConfirm,
  onCancel,
}: {
  target: DatasetDescriptor;
  candidates: DatasetDescriptor[];
  onConfirm: (continueWith: string) => void;
  onCancel: () => void;
}) {
  const [selected, setSelected] = useState(candidates[0]?.reference_name ?? "");

  // ESC = cancel (a11y, mirrors GuidedLoadDialog).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="dialog-overlay">
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="active-delete-title"
      >
        <h2 id="active-delete-title">删除焦点源「{target.display_name}」</h2>
        <p className="muted">
          此源是当前焦点表。删除后请在剩余源中选一个继续分析（或中止，工作集保持不变）。
        </p>
        <ul className="dialog-list">
          {candidates.map((d) => (
            <li key={d.reference_name}>
              <label>
                <input
                  type="radio"
                  name="active-delete-continue-with"
                  value={d.reference_name}
                  checked={selected === d.reference_name}
                  onChange={() => setSelected(d.reference_name)}
                />
                {d.display_name}
              </label>
            </li>
          ))}
        </ul>
        <div className="dialog-actions">
          <button type="button" onClick={onCancel}>
            中止
          </button>
          <button
            type="button"
            onClick={() => {
              if (selected) onConfirm(selected);
            }}
            disabled={!selected}
          >
            继续
          </button>
        </div>
      </div>
    </div>
  );
}
