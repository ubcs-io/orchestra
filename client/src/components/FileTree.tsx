import { Fragment, useState } from "react";
import type { DiffFile } from "../api";
import { STATUS_PILL, STATUS_LABEL } from "./DiffPanel";

export interface FileTreeNode {
  name: string;
  path: string;
  children: Map<string, FileTreeNode>;
  file?: DiffFile;
}

/** Builds a directory tree client-side from the flat file list a diff
 *  endpoint returns — there's no server-side tree endpoint, this is purely
 *  a presentation grouping over the same DiffFile[] DiffPanel already uses. */
export function buildFileTree(files: DiffFile[]): FileTreeNode {
  const root: FileTreeNode = { name: "", path: "", children: new Map() };
  for (const file of files) {
    const parts = file.path.split("/");
    let node = root;
    let pathSoFar = "";
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      pathSoFar = pathSoFar ? `${pathSoFar}/${part}` : part;
      let child = node.children.get(part);
      if (!child) {
        child = { name: part, path: pathSoFar, children: new Map() };
        node.children.set(part, child);
      }
      node = child;
      if (i === parts.length - 1) node.file = file;
    }
  }
  return root;
}

function sortedChildren(node: FileTreeNode): FileTreeNode[] {
  return Array.from(node.children.values()).sort((a, b) => {
    const aDir = a.children.size > 0;
    const bDir = b.children.size > 0;
    if (aDir !== bDir) return aDir ? -1 : 1; // dirs before files
    return a.name.localeCompare(b.name);
  });
}

function TreeNode({
  node,
  depth,
  selectedPath,
  onSelect,
}: {
  node: FileTreeNode;
  depth: number;
  selectedPath?: string;
  onSelect: (file: DiffFile) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const isDir = node.children.size > 0;
  const indent = 10 + depth * 14;

  if (!isDir && node.file) {
    const file = node.file;
    const selected = selectedPath === file.path;
    return (
      <button
        type="button"
        className={`file-tree-leaf${selected ? " selected" : ""}`}
        style={{ paddingLeft: indent }}
        onClick={() => onSelect(file)}
      >
        <span className={`pill ${STATUS_PILL[file.status]}`}>{STATUS_LABEL[file.status]}</span>
        <span className="file-tree-name">{node.name}</span>
      </button>
    );
  }

  return (
    <Fragment>
      <button
        type="button"
        className="file-tree-dir"
        style={{ paddingLeft: indent }}
        onClick={() => setCollapsed((c) => !c)}
      >
        <span className="file-tree-caret">{collapsed ? "▸" : "▾"}</span>
        <span className="file-tree-name">{node.name}</span>
      </button>
      {!collapsed &&
        sortedChildren(node).map((child) => (
          <TreeNode key={child.path} node={child} depth={depth + 1} selectedPath={selectedPath} onSelect={onSelect} />
        ))}
    </Fragment>
  );
}

export function FileTree({
  tree,
  selectedPath,
  onSelect,
}: {
  tree: FileTreeNode;
  selectedPath?: string;
  onSelect: (file: DiffFile) => void;
}) {
  if (tree.children.size === 0) {
    return <p className="muted" style={{ padding: "6px 10px" }}>No changed files.</p>;
  }
  return (
    <div className="file-tree">
      {sortedChildren(tree).map((child) => (
        <TreeNode key={child.path} node={child} depth={0} selectedPath={selectedPath} onSelect={onSelect} />
      ))}
    </div>
  );
}
