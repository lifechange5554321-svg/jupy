import { useEffect, useState } from "react";
import { ROOT, type FsNode, joinPath, listDir, mkdir, parentPath } from "./files";

export function FolderPane({
  dir,
  onDir,
  onOpenFile,
}: {
  dir: string;
  onDir: (dir: string) => void;
  onOpenFile?: (path: string) => void;
}) {
  const [rows, setRows] = useState<FsNode[]>([]);
  const [folder, setFolder] = useState("");
  const [err, setErr] = useState("");

  async function reload(next = dir) {
    try {
      setRows(await listDir(next));
      setErr("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    void reload(dir);
  }, [dir]);

  return (
    <div className="files">
      <div className="crumbs" title={dir}>
        {dir.split("/").map((part, i, all) => {
          const path = all.slice(0, i + 1).join("/");
          return (
            <button key={path} type="button" className="crumb" onClick={() => onDir(path)}>
              {part}
              {i < all.length - 1 ? " / " : ""}
            </button>
          );
        })}
      </div>
      <div className="file-list" role="listbox" aria-label="Folder">
        {dir !== ROOT && (
          <button type="button" onClick={() => onDir(parentPath(dir))}>
            .. Up
          </button>
        )}
        {rows.map((row) => (
          <button
            key={row.path}
            type="button"
            onClick={() => {
              if (row.kind === "dir") onDir(row.path);
              else onOpenFile?.(row.path);
            }}
          >
            {row.kind === "dir" ? "Folder  " : "File  "}
            {row.name}
          </button>
        ))}
        {rows.length === 0 && <p className="hint">Empty folder</p>}
      </div>
      {err && <p className="hint">{err}</p>}
      <div className="row-actions">
        <input
          aria-label="New folder name"
          placeholder="New folder"
          value={folder}
          onChange={(e) => setFolder(e.target.value)}
        />
        <button
          type="button"
          className="text-btn"
          onClick={() => {
            const name = folder.trim();
            if (!name) return;
            void mkdir(joinPath(dir, name)).then(() => {
              setFolder("");
              onDir(joinPath(dir, name));
            });
          }}
        >
          Create
        </button>
      </div>
    </div>
  );
}
