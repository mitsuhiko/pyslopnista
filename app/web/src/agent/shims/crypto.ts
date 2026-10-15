// `node:crypto` for pi-ai's ChatGPT sign-in, which only needs randomBytes(n).toString(encoding).
export function randomBytes(n: number) {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return {
    toString(encoding = "hex") {
      if (encoding === "hex") return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
      const b64 = btoa(String.fromCharCode(...bytes));
      return encoding === "base64url" ? b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : b64;
    },
  };
}

export default { randomBytes };
