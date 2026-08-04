// Entity ids key every per-entity Blob path (ddKeys.*) — they MUST be unique
// within a transaction or one entity's artifacts silently overwrite another's.
export function slugifyEntityName(name: string): string {
  return (
    name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "entitas"
  );
}

// Deterministic de-dupe: first occurrence keeps the bare slug, later
// collisions get -2, -3, ... (still within isValidEntityId's 32-char cap).
// De-dupes against every id already emitted — not just base-slug counts —
// so a suffixed id can never collide with another name's bare slug
// (e.g. "PT Alpha 2" → "pt-alpha-2" vs the second "PT Alpha" → "pt-alpha-3").
export function uniqueEntityIds(names: string[]): string[] {
  const seen = new Map<string, number>();
  const emitted = new Set<string>();
  return names.map((name) => {
    const base = slugifyEntityName(name);
    let count = (seen.get(base) ?? 0) + 1;
    let candidate = count === 1 ? base : `${base}-${count}`;
    while (emitted.has(candidate)) {
      count += 1;
      candidate = `${base}-${count}`;
    }
    seen.set(base, count);
    emitted.add(candidate);
    return candidate;
  });
}
