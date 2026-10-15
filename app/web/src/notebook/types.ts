// Notebook cells and their outputs (D44), as the engine's kernel reports them
// and the editor keeps them. Outputs are nbformat 4's, plus "status" lines of
// our own (installing packages), which are not saved.

export type MimeBundle = Record<string, unknown>;

export type Output =
  | { output_type: "stream"; name: "stdout" | "stderr"; text: string }
  | { output_type: "display_data"; data: MimeBundle; metadata: Record<string, unknown>; transient?: { display_id?: string } }
  | { output_type: "execute_result"; data: MimeBundle; metadata: Record<string, unknown>; execution_count: number | null }
  | { output_type: "error"; ename: string; evalue: string; traceback: string[] }
  | { output_type: "status"; text: string };

export type KernelState = "none" | "starting" | "idle" | "busy" | "dead";

/** What the engine tells the editor about a notebook's cells. */
export type KernelEvent =
  | { type: "queued"; cell: string }
  | { type: "start"; cell: string; count: number }
  | { type: "output"; cell: string; output: Output }
  | { type: "update"; displayId: string; data: MimeBundle; metadata: Record<string, unknown> }
  | { type: "clear"; cell: string; wait: boolean }
  | { type: "done"; cell: string; status: "ok" | "error" | "stopped" | "cancelled" }
  | { type: "kernel"; state: KernelState; python?: string };

/** A cell to run: its id in the editor and its code. */
export interface CellRequest {
  id: string;
  code: string;
}
