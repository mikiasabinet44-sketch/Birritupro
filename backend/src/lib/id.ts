// Tiny dependency-free id generator (swap-in for nanoid) using the
// platform's built-in crypto.randomUUID, available in Node 18+.
export function nanoid(): string {
  return crypto.randomUUID();
}
