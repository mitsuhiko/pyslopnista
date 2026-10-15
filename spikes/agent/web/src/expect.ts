// Just enough of Vitest's expect for pi-durable's conformance suites
// (createExpectAssertions uses toBe, toEqual, toMatchObject, toBeTruthy,
// toBeGreaterThan and rejects.toThrow).

function fmt(value: unknown): string {
  try {
    return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? `${v}n` : v instanceof Uint8Array ? `<${v.length} bytes>` : v))?.slice(0, 300) ?? String(value);
  } catch {
    return String(value);
  }
}

function equal(a: unknown, b: unknown, partial: boolean): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    return a instanceof Uint8Array && b instanceof Uint8Array && a.length === b.length && a.every((x, i) => x === b[i]);
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => equal(x, b[i], partial));
  }
  if (a instanceof Map || b instanceof Map) {
    if (!(a instanceof Map && b instanceof Map) || a.size !== b.size) return false;
    for (const [k, v] of b) if (!a.has(k) || !equal(a.get(k), v, partial)) return false;
    return true;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  // toEqual ignores properties whose value is undefined; toMatchObject only checks expected keys.
  const keys = (o: Record<string, unknown>) => Object.keys(o).filter((k) => o[k] !== undefined);
  const bk = keys(bo);
  if (!partial && keys(ao).length !== bk.length) return false;
  return bk.every((k) => equal(ao[k], bo[k], partial));
}

class AssertionError extends Error {}

export function expect(actual: unknown, message?: string) {
  const fail = (what: string) => {
    throw new AssertionError(`${message ? message + ": " : ""}${what}`);
  };
  return {
    toBe(expected: unknown) {
      if (!Object.is(actual, expected)) fail(`expected ${fmt(actual)} to be ${fmt(expected)}`);
    },
    toEqual(expected: unknown) {
      if (!equal(actual, expected, false)) fail(`expected ${fmt(actual)} to equal ${fmt(expected)}`);
    },
    toMatchObject(expected: unknown) {
      if (!equal(actual, expected, true)) fail(`expected ${fmt(actual)} to match ${fmt(expected)}`);
    },
    toBeTruthy() {
      if (!actual) fail(`expected ${fmt(actual)} to be truthy`);
    },
    toBeGreaterThan(expected: number) {
      if (!((actual as number) > expected)) fail(`expected ${fmt(actual)} > ${expected}`);
    },
    rejects: {
      async toThrow(expected?: string | RegExp) {
        try {
          await (typeof actual === "function" ? (actual as () => Promise<unknown>)() : (actual as Promise<unknown>));
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          if (expected === undefined) return;
          if (typeof expected === "string" ? text.includes(expected) : expected.test(text)) return;
          fail(`expected rejection matching ${expected}, got ${fmt(text)}`);
        }
        fail("expected a rejection");
      },
    },
  };
}
