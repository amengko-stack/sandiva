"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { FileEntry } from "@/types";

const FILE_ICON: Record<string, string> = { docx: "📄", doc: "📄", pdf: "📋", txt: "📝" };

// Folders containing more than this many files (recursively) start collapsed.
const COLLAPSE_THRESHOLD = 10;

// ─── Tree model ─────────────────────────────────────────────────────────────

interface TreeNode {
  name: string;                  // folder segment name ("" for root)
  path: string;                  // full relative folder path ("" for root)
  folders: Map<string, TreeNode>;
  files: FileEntry[];            // files directly inside this folder
}

function buildTree(files: FileEntry[]): TreeNode {
  const root: TreeNode = { name: "", path: "", folders: new Map(), files: [] };
  for (const f of files) {
    const rel = (f.folder ?? "").trim();
    if (!rel) {
      root.files.push(f);
      continue;
    }
    const segs = rel.split("/").filter(Boolean);
    let node = root;
    let acc = "";
    for (const seg of segs) {
      acc = acc ? `${acc}/${seg}` : seg;
      let child = node.folders.get(seg);
      if (!child) {
        child = { name: seg, path: acc, folders: new Map(), files: [] };
        node.folders.set(seg, child);
      }
      node = child;
    }
    node.files.push(f);
  }
  return root;
}

function collectFileIds(node: TreeNode, acc: string[] = []): string[] {
  for (const f of node.files) acc.push(f.id);
  for (const child of Array.from(node.folders.values())) collectFileIds(child, acc);
  return acc;
}

function collectFolderPaths(node: TreeNode, acc: string[] = []): string[] {
  for (const child of Array.from(node.folders.values())) {
    acc.push(child.path);
    collectFolderPaths(child, acc);
  }
  return acc;
}

// Folders with ≤ COLLAPSE_THRESHOLD files (recursive) are expanded by default.
function defaultExpanded(root: TreeNode): Set<string> {
  const set = new Set<string>();
  const walk = (node: TreeNode) => {
    for (const child of Array.from(node.folders.values())) {
      if (collectFileIds(child).length <= COLLAPSE_THRESHOLD) set.add(child.path);
      walk(child);
    }
  };
  walk(root);
  return set;
}

const sortedFolders = (node: TreeNode) =>
  Array.from(node.folders.values()).sort((a, b) => a.name.localeCompare(b.name, "id"));
const sortedFiles = (node: TreeNode) =>
  [...node.files].sort((a, b) => a.name.localeCompare(b.name, "id"));

// ─── Tri-state checkbox ─────────────────────────────────────────────────────

type CheckState = "checked" | "unchecked" | "indeterminate";

function TriCheckbox({ state, onToggle }: { state: CheckState; onToggle: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === "indeterminate";
  }, [state]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={state === "checked"}
      onChange={onToggle}
      onClick={(e) => e.stopPropagation()}
      style={{ flexShrink: 0, cursor: "pointer" }}
    />
  );
}

// ─── Component ──────────────────────────────────────────────────────────────

interface FileTreeProps {
  files: FileEntry[];
  checkedIds: Set<string>;
  onToggleFile: (id: string) => void;
  onSetMany: (ids: string[], checked: boolean) => void;
}

export default function FileTree({ files, checkedIds, onToggleFile, onSetMany }: FileTreeProps) {
  const tree = useMemo(() => buildTree(files), [files]);
  // Signature of the folder set so default-expansion re-runs when the file list changes.
  const folderSig = useMemo(() => collectFolderPaths(tree).sort().join("|"), [tree]);
  const [expanded, setExpanded] = useState<Set<string>>(() => defaultExpanded(tree));

  useEffect(() => {
    setExpanded(defaultExpanded(tree));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderSig]);

  const allFolderPaths = useMemo(() => collectFolderPaths(tree), [tree]);
  const hasFolders = allFolderPaths.length > 0;

  function toggleExpand(path: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });
  }

  function folderState(node: TreeNode): CheckState {
    const ids = collectFileIds(node);
    if (ids.length === 0) return "unchecked";
    let checked = 0;
    for (const id of ids) if (checkedIds.has(id)) checked++;
    if (checked === 0) return "unchecked";
    if (checked === ids.length) return "checked";
    return "indeterminate";
  }

  function toggleFolder(node: TreeNode) {
    const ids = collectFileIds(node);
    // If everything is already selected, clear; otherwise select all under it.
    const allChecked = ids.every((id) => checkedIds.has(id));
    onSetMany(ids, !allChecked);
  }

  function renderFolder(node: TreeNode, depth: number): React.ReactNode {
    const isOpen = expanded.has(node.path);
    const count = collectFileIds(node).length;
    const indent = 12 + depth * 18;
    return (
      <div key={`fold:${node.path}`}>
        <div
          onClick={() => toggleExpand(node.path)}
          style={{
            display: "flex", alignItems: "center", gap: 8,
            padding: "8px 12px", paddingLeft: indent,
            borderBottom: "1px solid var(--border-color)",
            background: "var(--bg-surface)", cursor: "pointer", userSelect: "none",
          }}
        >
          <span style={{ fontSize: 11, width: 12, color: "var(--text-muted)", flexShrink: 0 }}>
            {isOpen ? "▾" : "▸"}
          </span>
          <TriCheckbox state={folderState(node)} onToggle={() => toggleFolder(node)} />
          <span style={{ fontSize: 14, flexShrink: 0 }}>{isOpen ? "📂" : "📁"}</span>
          <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {node.name}
          </span>
          <span style={{ fontSize: 11, color: "var(--text-muted)", flexShrink: 0 }}>{count} file</span>
        </div>
        {isOpen && renderChildren(node, depth + 1)}
      </div>
    );
  }

  function renderFile(f: FileEntry, depth: number): React.ReactNode {
    const checked = checkedIds.has(f.id);
    const indent = 12 + depth * 18 + 20; // align with folder content (past chevron)
    return (
      <div
        key={`file:${f.id}`}
        onClick={() => onToggleFile(f.id)}
        style={{
          display: "flex", gap: 10, alignItems: "center",
          padding: "8px 12px", paddingLeft: indent,
          borderBottom: "1px solid var(--border-color)",
          cursor: "pointer", userSelect: "none",
          background: checked ? "rgba(91,155,213,0.05)" : "transparent",
          opacity: checked ? 1 : 0.45,
        }}
      >
        <input type="checkbox" checked={checked} onChange={() => {}} style={{ flexShrink: 0, pointerEvents: "none" }} />
        <span style={{ fontSize: 14, flexShrink: 0 }}>{FILE_ICON[f.type] || "📎"}</span>
        <span style={{
          flex: 1, fontSize: 13,
          color: checked ? "var(--text-primary)" : "var(--text-muted)",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          textDecoration: checked ? "none" : "line-through",
        }}>
          {f.name}
        </span>
        <span style={{ fontSize: 11, color: "var(--text-muted)", flexShrink: 0 }}>{f.size}</span>
        <span style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", flexShrink: 0 }}>{f.type}</span>
      </div>
    );
  }

  // Folders first (sorted), then loose files at this level (sorted).
  function renderChildren(node: TreeNode, depth: number): React.ReactNode {
    return (
      <>
        {sortedFolders(node).map((child) => renderFolder(child, depth))}
        {sortedFiles(node).map((f) => renderFile(f, depth))}
      </>
    );
  }

  return (
    <>
      {hasFolders && (
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginBottom: 6 }}>
          <button
            onClick={() => setExpanded(new Set(allFolderPaths))}
            style={{ fontSize: 12, color: "var(--accent-blue)", background: "none", border: "none", cursor: "pointer" }}
          >
            Perluas Semua
          </button>
          <button
            onClick={() => setExpanded(new Set())}
            style={{ fontSize: 12, color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer" }}
          >
            Tutup Semua
          </button>
        </div>
      )}
      <div style={{ border: "1px solid var(--border-color)", borderRadius: 4, maxHeight: 360, overflowY: "auto", marginBottom: 12 }}>
        {renderChildren(tree, 0)}
      </div>
    </>
  );
}
