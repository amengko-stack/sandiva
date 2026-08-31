import type { DDTransaction } from "@/types/dd";

/**
 * Which SharePoint folders a matter may touch.
 *
 * The app registration holds Sites.ReadWrite.All — tenant-wide — and several
 * routes passed a client-supplied folder path straight to Graph. parseInput()
 * takes the hostname and site name from that string, so a request naming another
 * matter's site listed and then extracted that matter's documents. For a firm
 * that keeps an ethical wall in SharePoint, that defeated it.
 *
 * The rule: a request may only reach folders already recorded on the matter. A
 * folder is recorded when the lawyer names it in the UI — every entity's data
 * room at Stage 1 — and nothing else is reachable afterwards.
 *
 * What this does and does not buy, stated plainly because the difference matters:
 *
 *  - It stops one matter's session reaching another matter's data room, which is
 *    the ethical-wall problem.
 *  - It does NOT stop a determined authenticated user, who can still start a new
 *    session and register any folder they like. Everyone shares one password, so
 *    the app cannot tell two people apart. That gap closes with per-user identity,
 *    deliberately sequenced after testing.
 *
 * Comparison is textual on a normalised string rather than resolved through Graph:
 * resolving a sharing link costs a round trip and would have to happen on every
 * request. Two different textual spellings of the same folder therefore do not
 * match — that fails closed, which is the safe direction, and the UI sends back
 * the same string it recorded.
 */

/** Canonical form for comparison. Conservative: it never widens what matches. */
export function normalizeFolderRef(raw: string): string {
  let s = (raw ?? "").trim();
  if (s === "") return "";
  // Outlook and Teams wrap pasted links in angle brackets.
  s = s.replace(/^<+/, "").replace(/>+$/, "");
  try {
    s = decodeURI(s);
  } catch {
    // A malformed escape sequence is left as-is; it simply will not match a root.
  }
  return s.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * True when `requested` is one of `allowedRoots` or sits beneath one.
 *
 * The "/" in the prefix test is load-bearing: without it, a root of
 * ".../matters/alpha" would also admit ".../matters/alpha-holdings", a different
 * matter whose name merely starts the same way.
 */
export function isWithinMatter(requested: string, allowedRoots: string[]): boolean {
  const req = normalizeFolderRef(requested);
  if (req === "") return false;
  // A traversal segment can only be an attempt to leave the root it matched.
  if (req.split("/").some((seg) => seg === "..")) return false;

  return allowedRoots.some((root) => {
    const r = normalizeFolderRef(root);
    if (r === "") return false;
    return req === r || req.startsWith(`${r}/`);
  });
}

/** The folders a matter registered: every entity's data room, named at Stage 1. */
export function matterRoots(txn: DDTransaction): string[] {
  return txn.entities.map((e) => e.dataRoomPath).filter((p) => (p ?? "").trim() !== "");
}

/**
 * Guard for a route: returns null when allowed, or the message to refuse with.
 *
 * Returning the message rather than throwing keeps the refusal in the route's own
 * error shape, and keeps the reason in Indonesian for the lawyer reading it.
 */
export function refuseIfOutsideMatter(
  requested: string,
  txn: DDTransaction
): string | null {
  const roots = matterRoots(txn);
  if (roots.length === 0) {
    return "Matter ini belum memiliki folder data room yang tercatat. Tetapkan folder pada Tahap 1 terlebih dahulu.";
  }
  if (!isWithinMatter(requested, roots)) {
    return (
      "Folder yang diminta bukan bagian dari matter ini. " +
      "Hanya folder data room yang dicatat pada Tahap 1 yang dapat diakses."
    );
  }
  return null;
}
