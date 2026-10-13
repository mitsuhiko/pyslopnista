// Settings: editor font size and line wrapping (⌘,).
import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { FONT_SIZES, settings } from "./settings";

export function SettingsSheet({ onClose }: { onClose: () => void }) {
  const s = useSyncExternalStore(settings.subscribe, settings.getSnapshot);
  return createPortal(
    <div className="modal-scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-sheet settings-sheet" role="dialog" aria-label="Settings">
        <div className="modal-header">
          <div className="grabber" />
          <div className="modal-title-row">
            <span className="modal-title">Settings</span>
            <button className="text-button" onClick={onClose}>Done</button>
          </div>
        </div>
        <div className="modal-body">
          <div className="settings-section-title">Editor</div>
          <div className="grouped-list">
            <div className="settings-row">
              <span>Font Size</span>
              <div className="stepper">
                <button onClick={() => settings.update({ fontSize: s.fontSize - 1 })} disabled={s.fontSize <= FONT_SIZES.min} aria-label="Smaller">A</button>
                <span className="stepper-value">{s.fontSize} pt</span>
                <button className="larger" onClick={() => settings.update({ fontSize: s.fontSize + 1 })} disabled={s.fontSize >= FONT_SIZES.max} aria-label="Larger">A</button>
              </div>
            </div>
            <label className="settings-row">
              <span>Wrap Long Lines</span>
              <input type="checkbox" className="switch" checked={s.wrap} onChange={(e) => settings.update({ wrap: e.target.checked })} />
            </label>
          </div>
          <pre className="settings-preview" style={{ fontSize: s.fontSize, whiteSpace: s.wrap ? "pre-wrap" : "pre" }}>
            {'def greet(name: str) -> str:\n    return f"Hello {name}, nice to see you again today!"'}
          </pre>
        </div>
      </div>
    </div>,
    document.body,
  );
}
