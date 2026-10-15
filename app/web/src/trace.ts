// Tracebacks as data (D45), from _pyslop_traceback.py: the console (native)
// and notebook outputs (editor/trace.ts) draw them instead of the text.

export interface TraceFrame {
  /** "omitted": frames left out of a very long stack (`count` of them). */
  kind: "app" | "library" | "omitted";
  file?: string; // relative to the program's folder for project files, "json/decoder.py" for the library, "<cell 3>"
  name?: string | null; // qualified function name; null for a SyntaxError's place
  line?: number;
  endLine?: number; // the span ends on a later line
  col?: number; // span start on `line` (characters, 0-based, in the dedented context lines)
  endCol?: number; // span end on `endLine ?? line` (exclusive)
  context?: { start: number; lines: string[] }; // source lines from `start` on, dedented
  repeat?: number; // the same frame again this many times (recursion)
  count?: number; // "omitted" frames
  debug?: number; // the frame's index in the debugger's post-mortem stack (the run's uncaught exception)
}

export interface TraceException {
  type: string;
  message: string;
  notes?: string[];
  /** How the exception before this one led to it. */
  chain?: "cause" | "context";
  frames: TraceFrame[]; // most recent call last
  syntax?: TraceFrame; // a SyntaxError's place
  group?: TraceException[][]; // an ExceptionGroup's members, each a chain
  groupMore?: number;
}

export interface Trace {
  /** The classic traceback (copy, the agent, the self-test). */
  text: string;
  exceptions: TraceException[]; // oldest first, as Python prints them
}

export function parseTrace(json: string | undefined | null): Trace | undefined {
  if (!json) return undefined;
  try {
    const trace = JSON.parse(json) as Trace;
    return Array.isArray(trace?.exceptions) && trace.exceptions.length ? trace : undefined;
  } catch {
    return undefined;
  }
}

export const CHAIN_TEXT = {
  cause: "The above exception was the direct cause of the following exception:",
  context: "During handling of the above exception, another exception occurred:",
};
