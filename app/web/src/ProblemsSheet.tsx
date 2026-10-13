// Modal sheet listing all problems in the open file; tap one to jump there.
import { type Diagnostic, forEachDiagnostic } from "@codemirror/lint";
import { EditorView } from "@codemirror/view";
import { createPortal } from "react-dom";
import { Error as ErrorIcon, Warning } from "./Icons";

interface Item {
  d: Diagnostic;
  from: number;
  to: number;
  line: number;
}

export function ProblemsSheet({ view, onClose }: { view: EditorView; onClose: () => void }) {
  const items: Item[] = [];
  forEachDiagnostic(view.state, (d, from, to) => items.push({ d, from, to, line: view.state.doc.lineAt(from).number }));
  items.sort((a, b) => (a.d.severity === "error" ? 0 : 1) - (b.d.severity === "error" ? 0 : 1) || a.from - b.from);

  const jump = (item: Item) => {
    onClose();
    view.dispatch({ selection: { anchor: item.from, head: item.to }, effects: EditorView.scrollIntoView(item.from, { y: "center" }) });
    view.focus();
  };

  return createPortal(
    <div className="modal-scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-sheet" role="dialog" aria-label="Problems">
        <div className="modal-header">
          <div className="grabber" />
          <div className="modal-title-row">
            <span className="modal-title">Problems</span>
            <button className="text-button" onClick={onClose}>Done</button>
          </div>
        </div>
        <div className="modal-body">
          {items.length === 0 && <p className="modal-empty">No problems found.</p>}
          {items.length > 0 && (
            <div className="grouped-list">
              {items.map((item, i) => (
                <div className="problem-row" key={i}>
                  <button className="problem-row-main" onClick={() => jump(item)}>
                    {item.d.severity === "error" ? <ErrorIcon size={20} className="sev error" /> : <Warning size={20} className="sev warning" />}
                    <span className="problem-row-text">
                      <span className="problem-row-message">{item.d.message}</span>
                      <span className="problem-row-meta">Line {item.line} · {item.d.source}</span>
                    </span>
                  </button>
                  {!!item.d.actions?.length && (
                    <div className="problem-row-actions">
                      {item.d.actions.map((a) => (
                        <button key={a.name} onClick={() => { a.apply(view, item.from, item.to); onClose(); }}>{a.name}</button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
