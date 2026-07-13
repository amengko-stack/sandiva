// Entity ids key every per-entity Blob path (ddKeys.*) — they MUST be unique
// within a transaction or one entity's artifacts silently overwrite another's.
export function slugifyEntityName(name: string): string {
  return (
    name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "entitas"
  );
}

// Deterministic de-dupe: first occurrence keeps the bare slug, later
// collisions get -2, -3, ... (still within isValidEntityId's 32-char cap).
export function uniqueEntityIds(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const base = slugifyEntityName(name);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base}-${count}`;
  });
}
