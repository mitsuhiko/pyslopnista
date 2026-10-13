// Jumping to a place in a file from anywhere (console tracebacks, the
// debugger, go to definition). The App registers the handler.
type Handler = (path: string, line: number, column?: number) => void;

let handler: Handler | null = null;

export const navigation = {
  open(path: string, line: number, column?: number) {
    handler?.(path, line, column);
  },
  setHandler(next: Handler | null) {
    handler = next;
  },
};
