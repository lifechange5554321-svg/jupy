export const ROOT = "Notebooks";

export type FsKind = "dir" | "file";
export type FsNode = { path: string; kind: FsKind; name: string };

export function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const bit of path.split(/[/\\]+/)) {
    if (!bit || bit === ".") continue;
    if (bit === "..") {
      parts.pop();
      continue;
    }
    parts.push(bit.replace(/[\\:*?"<>|]/g, "_").trim());
  }
  const clean = parts.filter(Boolean);
  if (!clean.length || clean[0] !== ROOT) clean.unshift(ROOT);
  return clean.join("/");
}

export function parentPath(path: string): string {
  const n = normalizePath(path);
  const i = n.lastIndexOf("/");
  return i === -1 ? ROOT : n.slice(0, i);
}

export function baseName(path: string): string {
  const n = normalizePath(path);
  const i = n.lastIndexOf("/");
  return i === -1 ? n : n.slice(i + 1);
}

export function joinPath(dir: string, name: string): string {
  return normalizePath(`${dir}/${name}`);
}

type Rec = { path: string; kind: FsKind; text?: string };

const DB = "jide-fs-v1";
const STORE = "nodes";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "path" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function put(rec: Rec) {
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).put(rec);
  await txDone(tx);
  db.close();
}

async function get(path: string): Promise<Rec | undefined> {
  const db = await openDb();
  const tx = db.transaction(STORE, "readonly");
  const req = tx.objectStore(STORE).get(normalizePath(path));
  const rec = await new Promise<Rec | undefined>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result as Rec | undefined);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return rec;
}

async function all(): Promise<Rec[]> {
  const db = await openDb();
  const tx = db.transaction(STORE, "readonly");
  const req = tx.objectStore(STORE).getAll();
  const rows = await new Promise<Rec[]>((resolve, reject) => {
    req.onsuccess = () => resolve((req.result as Rec[]) || []);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return rows;
}

export async function ensureRoot() {
  const rec = await get(ROOT);
  if (!rec) await put({ path: ROOT, kind: "dir" });
}

export async function mkdir(path: string) {
  const n = normalizePath(path);
  const bits = n.split("/");
  let acc = "";
  for (const bit of bits) {
    acc = acc ? `${acc}/${bit}` : bit;
    const cur = await get(acc);
    if (!cur) await put({ path: acc, kind: "dir" });
    else if (cur.kind !== "dir") throw new Error("Not a folder: " + acc);
  }
}

export async function writeFile(path: string, text: string) {
  const n = normalizePath(path);
  await mkdir(parentPath(n));
  await put({ path: n, kind: "file", text });
}

export async function readFile(path: string): Promise<string> {
  const rec = await get(path);
  if (!rec || rec.kind !== "file") throw new Error("File not found: " + normalizePath(path));
  return rec.text || "";
}

export async function listDir(path: string): Promise<FsNode[]> {
  await ensureRoot();
  const dir = normalizePath(path);
  const rows = await all();
  return rows
    .filter((r) => r.path !== dir && parentPath(r.path) === dir)
    .map((r) => ({ path: r.path, kind: r.kind, name: baseName(r.path) }))
    .sort((a, b) => Number(b.kind === "dir") - Number(a.kind === "dir") || a.name.localeCompare(b.name));
}
