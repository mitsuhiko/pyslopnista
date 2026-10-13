// Shows the diagnostic under the cursor (touch has no hover) with its quick
// fixes, plus problem counts that open the full list.
import { type Diagnostic, forEachDiagnostic } from "@codemirror/lint";
import type { EditorView } from "@codemirror/view";

export interface ProblemSummary {
  errors: number;
  warnings: number;
  current: Diagnostic | null;
}

export function summarizeProblems(view: EditorView): ProblemSummary {
  let errors = 0;
  let warnings = 0;
  let current: Diagnostic | null = null;
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  forEachDiagnostic(view.state, (d, from, to) => {
    if (d.severity === "error") errors++;
    else if (d.severity === "warning") warnings++;
    const here = from <= head && head <= to;
    const sameLine = from <= line.to && to >= line.from;
    if (here || (!current && sameLine)) current = { ...d, from, to };
  });
  return { errors, warnings, current };
}

export function ProblemBar({ summary, view, onShowAll }: { summary: ProblemSummary; view: EditorView | null; onShowAll: () => void }) {
  const d = summary.current;
  if (!d) return null;
  return (
    <div className={`problem-bar ${d.severity}`}>
      <div className="problem-text">
        <span className="problem-message">{d.message}</span>
        <span className="problem-source">{d.source}</span>
      </div>
      <div className="problem-actions">
        {d.actions?.map((a) => (
          <button key={a.name} onPointerDown={(e) => { e.preventDefault(); if (view) a.apply(view, d.from, d.to); }}>
            {a.name}
          </button>
        ))}
        {summary.errors + summary.warnings > 1 && (
          <button className="secondary" onPointerDown={(e) => { e.preventDefault(); onShowAll(); }}>
            All {summary.errors + summary.warnings}
          </button>
        )}
      </div>
    </div>
  );
}
