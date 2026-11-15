import { useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronUp,
  Copy,
  Lock,
  Menu,
  Minus,
  Pencil,
  Play,
  Plus,
  Redo2,
  RefreshCw,
  Square,
  Undo2,
  UnfoldVertical,
  X,
} from "lucide-react";
import { CodeEditor, type EditorMenuInfo } from "./CodeEditor";
import { FolderPane } from "./FileBrowser";
import { checkDevicePath, dataPython, parseCsv, parseJsonTable, readSqlite, safeDataName } from "./candles";
import {
  DEFAULT_KEYS,
  FINANCE_PKGS,
  type Cell,
  type FileFormat,
  type KeyDef,
  type PersistShape,
  ensureExt,
  extOf,
  freshCell,
  fromIpynb,
  lineBounds,
  lineOf,
  loadPersist,
  savePersist,
  serializeExport,
  simpleMarkdown,
  starterCells,
  titleFromCode,
  toIpynb,
  APP_VERSION,
} from "./logic";
import { ROOT, baseName, joinPath, parentPath, readFile, writeFile, listDir } from "./files";
import { installPackage, pythonVersion, restartKernel, runPython, syncDataFiles } from "./python";
import { suggestAccept, suggestCancel, suggestMove } from "./suggest-bridge";

type Settings = {
  theme: "dark" | "light";
  codeTheme: "ide" | "monokai" | "dracula" | "github";
  fontSize: number;
  outSize: number;
  wrap: boolean;
  guides: boolean;
  twoRows: boolean;
  keys: KeyDef[];
};

type After = null | "close" | "open" | "new";
type SaveState = { name: string; format: FileFormat; after: After; bind: boolean };
type MenuState = EditorMenuInfo & { cellId: string };
type FileHandle = {
  name: string;
  getFile: () => Promise<File>;
  createWritable: () => Promise<{ write: (data: string) => Promise<void>; close: () => Promise<void> }>;
  queryPermission?: (o: { mode: string }) => Promise<PermissionState>;
  requestPermission?: (o: { mode: string }) => Promise<PermissionState>;
};

const DEFAULT_SETTINGS: Settings = {
  theme: "dark",
  codeTheme: "ide",
  fontSize: 12,
  outSize: 12,
  wrap: false,
  guides: true,
  twoRows: false,
  keys: DEFAULT_KEYS,
};

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem("jide-settings-v92");
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      ...DEFAULT_SETTINGS,
      fontSize: parsed.fontSize == null || parsed.fontSize === 15 ? 12 : parsed.fontSize,
      outSize: parsed.outSize == null || parsed.outSize === 13 ? 12 : parsed.outSize,
      keys: Array.isArray(parsed.keys) && parsed.keys.length ? parsed.keys : DEFAULT_KEYS,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

async function writeHandle(handle: FileHandle, data: string) {
  const writable = await handle.createWritable();
  await writable.write(data);
  await writable.close();
}

function download(name: string, data: string, format: FileFormat) {
  const type =
    format === "html" ? "text/html" : format === "py" ? "text/x-python" : format === "md" ? "text/markdown" : "application/x-ipynb+json";
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([data], { type }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

function pickerTypes(format: FileFormat) {
  if (format === "py") return { description: "Python", accept: { "text/x-python": [".py"] } };
  if (format === "md") return { description: "Markdown", accept: { "text/markdown": [".md"] } };
  if (format === "html") return { description: "HTML", accept: { "text/html": [".html"] } };
  return { description: "Jupyter Notebook", accept: { "application/x-ipynb+json": [".ipynb"] } };
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      return true;
    } catch {
      return false;
    }
  }
}

type AndroidFs = {
  requestAccess: () => void;
  exists: (path: string) => string;
  listDir: (path: string) => string;
  readText: (path: string) => string;
  readBase64: (path: string) => string;
  lastError: () => string;
};

export function NotebookApp() {
  const [cells, setCells] = useState<Cell[]>(() => starterCells());
  const [closed, setClosed] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [fileName, setFileName] = useState("");
  const [filePath, setFilePath] = useState("");
  const [savedOnce, setSavedOnce] = useState(false);
  const [status, setStatus] = useState("Ready");
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [menuOpen, setMenuOpen] = useState(false);
  const [moveLock, setMoveLock] = useState(false);
  const [editLock, setEditLock] = useState(false);
  const [saveBox, setSaveBox] = useState<SaveState | null>(null);
  const [browseDir, setBrowseDir] = useState(ROOT);
  const [openBox, setOpenBox] = useState(false);
  const [phoneOpen, setPhoneOpen] = useState(false);
  const [phonePath, setPhonePath] = useState("/storage/emulated/0/backups/mini_database");
  const [phoneRows, setPhoneRows] = useState<{ name: string; kind: string }[]>([]);
  const [guard, setGuard] = useState<After>(null);
  const [closeCell, setCloseCell] = useState<{ id: string; py: boolean; nb: boolean; nosave: boolean } | null>(null);
  const [ctx, setCtx] = useState<MenuState | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pkgOpen, setPkgOpen] = useState(false);
  const [financeOpen, setFinanceOpen] = useState(false);
  const [pkgName, setPkgName] = useState("");
  const [pkgLog, setPkgLog] = useState("");
  const [loaded, setLoaded] = useState<string[]>([]);
  const [ask, setAsk] = useState<{ prompt: string; resolve: (v: string) => void } | null>(null);
  const [askValue, setAskValue] = useState("");
  const [dashH, setDashH] = useState(92);
  const [running, setRunning] = useState<string | null>(null);

  const idRef = useRef(3);
  const handleRef = useRef<FileHandle | null>(null);
  const cellsRef = useRef(cells);
  const activeTa = useRef<HTMLTextAreaElement | null>(null);
  const activeId = useRef<string | null>(null);
  const nbRef = useRef<HTMLElement | null>(null);
  const dashRef = useRef<HTMLElement | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const clipRef = useRef("");
  const ctrlRef = useRef(false);
  const shiftRef = useRef(false);
  const hist = useRef(new Map<string, { stack: string[]; i: number }>());
  const skipHist = useRef(false);
  const booted = useRef(false);
  const layoutSnap = useRef(new Map<string, Pick<Cell, "editorHeight" | "outputHeight" | "maxRatio" | "collapsed" | "outCollapsed">>());
  const kbSnap = useRef<{ id: string; eh: number; oh: number; touched: boolean } | null>(null);
  const [mods, setMods] = useState({ ctrl: false, shift: false });

  cellsRef.current = cells;
  const snap = useRef({ cells, fileName, filePath, savedOnce, dirty, closed });
  snap.current = { cells, fileName, filePath, savedOnce, dirty, closed };

  function remember(next?: Partial<Pick<PersistShape, "cells" | "fileName" | "filePath" | "savedOnce" | "dirty" | "closed">>) {
    const base = { ...snap.current, ...next };
    snap.current = base;
    savePersist({ v: 92, ...base });
  }

  useEffect(() => {
    const saved = loadPersist();
    const s = loadSettings();
    setSettings(s);
    if (saved) {
      setCells(saved.cells.length ? saved.cells : []);
      setClosed(!!saved.closed || saved.cells.length === 0);
      setDirty(!!saved.dirty);
      setFileName(saved.fileName || "");
      setFilePath(saved.filePath || "");
      setSavedOnce(!!saved.savedOnce);
      const max = saved.cells.reduce((m, c) => {
        const n = parseInt(c.id.replace(/\D/g, ""), 10);
        return Number.isFinite(n) ? Math.max(m, n) : m;
      }, 2);
      idRef.current = max + 1;
      saved.cells.forEach((c) => hist.current.set(c.id, { stack: [c.content], i: 0 }));
    }
    booted.current = true;
  }, []);

  useEffect(() => {
    if (!booted.current) return;
    const t = window.setTimeout(() => remember(), 200);
    return () => window.clearTimeout(t);
  }, [cells, fileName, filePath, savedOnce, dirty, closed]);

  useEffect(() => {
    localStorage.setItem("jide-settings-v92", JSON.stringify(settings));
    document.documentElement.style.setProperty("--code-size", settings.fontSize + "px");
    document.documentElement.style.setProperty("--out-size", settings.outSize + "px");
  }, [settings]);

  useEffect(() => {
    const el = dashRef.current;
    if (!el) return;
    const apply = () => {
      const h = el.offsetHeight;
      setDashH(h);
      document.documentElement.style.setProperty("--dash-h", h + "px");
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, [closed, status, fileName]);

  useEffect(() => {
    window.jideAsk = (prompt: string) =>
      new Promise((resolve) => {
        setAskValue("");
        setAsk({ prompt, resolve });
      });
    return () => {
      delete window.jideAsk;
    };
  }, []);

  function stickCell(id: string) {
    const nb = nbRef.current;
    const el = document.getElementById("cell-" + id);
    if (!nb || !el || el.classList.contains("is-max")) return;
    const delta = el.getBoundingClientRect().top - nb.getBoundingClientRect().top;
    if (Math.abs(delta) > 2) nb.scrollTop += delta;
  }

  function placeCaret(id: string) {
    stickCell(id);
    const ta = activeTa.current;
    const dash = dashRef.current;
    if (!ta || !dash || activeId.current !== id) return;
    const cs = getComputedStyle(ta);
    const lh = parseFloat(cs.lineHeight) || 19;
    const pad = parseFloat(cs.paddingTop) || 8;
    const caret = ta.selectionStart ?? 0;
    const line = ta.value.slice(0, caret).split("\n").length - 1;
    const desired = dash.getBoundingClientRect().bottom + 3 * lh;
    const lineTop = ta.getBoundingClientRect().top + pad + line * lh - ta.scrollTop;
    ta.scrollTop += lineTop - desired;
  }

  useEffect(() => {
    const vv = window.visualViewport;
    let timer = 0;
    const apply = () => {
      const shell = shellRef.current;
      if (!shell || !vv) return;
      shell.style.height = vv.height + "px";
      const open = window.innerHeight - vv.height > 80;
      const id = activeId.current;
      const cell = id ? cellsRef.current.find((c) => c.id === id) : undefined;
      if (open && cell && cell.type === "code" && !cell.maximized) {
        if (!kbSnap.current || kbSnap.current.id !== cell.id) {
          kbSnap.current = { id: cell.id, eh: cell.editorHeight, oh: cell.outputHeight, touched: false };
          const avail = Math.max(160, vv.height - (dashRef.current?.offsetHeight || 92) - 52);
          patch(cell.id, {
            editorHeight: Math.round((avail * 2) / 3),
            outputHeight: Math.max(48, Math.round(avail / 3)),
            collapsed: false,
            outCollapsed: false,
          }, false);
        }
        window.clearTimeout(timer);
        timer = window.setTimeout(() => placeCaret(cell.id), 60);
      } else if (!open && kbSnap.current) {
        const snap = kbSnap.current;
        kbSnap.current = null;
        if (!snap.touched) patch(snap.id, { editorHeight: snap.eh, outputHeight: snap.oh }, false);
      }
    };
    vv?.addEventListener("resize", apply);
    vv?.addEventListener("scroll", apply);
    window.addEventListener("resize", apply);
    apply();
    return () => {
      vv?.removeEventListener("resize", apply);
      vv?.removeEventListener("scroll", apply);
      window.removeEventListener("resize", apply);
      window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void onSave();
      }
      if (e.key === "Escape") {
        setCtx(null);
        setMenuOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function nextId() {
    idRef.current += 1;
    return "c" + idRef.current;
  }

  function patch(id: string, partial: Partial<Cell>, mark = true) {
    setCells((prev) => prev.map((c) => (c.id === id ? { ...c, ...partial } : c)));
    if (mark) setDirty(true);
  }

  function pushHist(id: string, value: string) {
    if (skipHist.current) return;
    let h = hist.current.get(id);
    if (!h) {
      hist.current.set(id, { stack: [value], i: 0 });
      return;
    }
    if (h.stack[h.i] === value) return;
    h.stack = h.stack.slice(0, h.i + 1);
    h.stack.push(value);
    if (h.stack.length > 80) {
      h.stack.shift();
      h.i = h.stack.length - 1;
    }
    h.i = h.stack.length - 1;
  }

  function onEdit(cell: Cell, value: string) {
    pushHist(cell.id, value);
    const partial: Partial<Cell> = { content: value };
    if (cell.type === "code" && !cell.titleLocked) {
      const auto = titleFromCode(value);
      if (auto) partial.title = auto;
    }
    patch(cell.id, partial, true);
  }

  function undo(id: string) {
    const h = hist.current.get(id);
    if (!h || h.i <= 0) return;
    h.i -= 1;
    skipHist.current = true;
    patch(id, { content: h.stack[h.i] || "" });
    skipHist.current = false;
  }

  function redo(id: string) {
    const h = hist.current.get(id);
    if (!h || h.i >= h.stack.length - 1) return;
    h.i += 1;
    skipHist.current = true;
    patch(id, { content: h.stack[h.i] || "" });
    skipHist.current = false;
  }

  function addCell(type: Cell["type"], content = "", title = "") {
    const id = nextId();
    const cell = freshCell(id, type, content, title);
    hist.current.set(id, { stack: [cell.content], i: 0 });
    setCells((prev) => [...prev, cell]);
    setClosed(false);
    setDirty(true);
    setStatus(type === "code" ? "Code cell added" : "Markdown cell added");
    window.setTimeout(() => stickCell(id), 30);
  }

  function move(id: string, dir: -1 | 1) {
    if (moveLock) {
      setStatus("Move lock is on");
      return;
    }
    setCells((prev) => {
      const i = prev.findIndex((c) => c.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const next = prev.slice();
      const a = next[i];
      const b = next[j];
      if (!a || !b) return prev;
      next[i] = b;
      next[j] = a;
      return next;
    });
    setDirty(true);
  }

  function importData() {
    setMenuOpen(false);
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".csv,.tsv,.txt,.json,.db,.sqlite,.sqlite3";
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) void ingestData(file);
    };
    input.click();
  }

  async function ingestPayload(name: string, text: string, bytes?: Uint8Array) {
    const safe = safeDataName(name);
    const lower = safe.toLowerCase();
    let stored = safe;
    let body = text;
    let kind: "csv" | "json" = "csv";
    let columns: string[] = [];
    let count = 0;
    if (bytes && /\.(db|sqlite|sqlite3)$/.test(lower)) {
      const book = await readSqlite(bytes);
      const names = Object.keys(book.tables);
      const rows = book.tables[names[0]] || [];
      body = JSON.stringify(book);
      stored = safe.replace(/\.(db|sqlite|sqlite3)$/i, "") + ".json";
      columns = rows[0] ? Object.keys(rows[0]) : [];
      count = names.reduce((n, key) => n + book.tables[key].length, 0);
      kind = "json";
    } else if (lower.endsWith(".json")) {
      const table = parseJsonTable(text);
      columns = table.columns;
      count = table.rows.length;
      kind = "json";
    } else {
      const table = parseCsv(text);
      columns = table.columns;
      count = table.rows.length;
    }
    if (!count) {
      setStatus("No rows in " + safe);
      return;
    }
    const path = joinPath(joinPath(ROOT, "data"), stored);
    await writeFile(path, body);
    addCell("code", dataPython(path, kind, columns, count), stored);
    setStatus("Imported " + count + " rows · " + path);
  }

  async function ingestData(file: File) {
    const name = safeDataName(file.name);
    setStatus("Reading " + name);
    try {
      if (/\.(db|sqlite|sqlite3)$/i.test(name)) await ingestPayload(name, "", new Uint8Array(await file.arrayBuffer()));
      else await ingestPayload(name, await file.text());
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Import failed");
    }
  }

  function androidFs() {
    return (window as unknown as { AndroidFs?: AndroidFs }).AndroidFs || null;
  }

  async function openPhonePath(raw: string) {
    let path = raw;
    try {
      path = checkDevicePath(raw);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Invalid path");
      return;
    }
    const fs = androidFs();
    if (!fs) {
      setStatus("This path opens in the Android app. Allow all-files access there.");
      return;
    }
    fs.requestAccess();
    const kind = fs.exists(path);
    const err = fs.lastError();
    if (err) {
      setStatus(err);
      return;
    }
    if (kind === "dir") {
      const rows = JSON.parse(fs.listDir(path) || "[]") as { name: string; kind: string }[];
      const again = fs.lastError();
      if (again) {
        setStatus(again);
        return;
      }
      setPhonePath(path);
      setPhoneRows(rows.filter((row) => row.kind === "dir" || /\.(csv|tsv|txt|json|db|sqlite|sqlite3)$/i.test(row.name)));
      return;
    }
    if (kind !== "file") {
      setStatus("Not found: " + path);
      return;
    }
    const fileName = path.split("/").pop() || "data.csv";
    try {
      if (/\.(db|sqlite|sqlite3)$/i.test(fileName)) {
        const bin = Uint8Array.from(atob(fs.readBase64(path)), (ch) => ch.charCodeAt(0));
        if (fs.lastError()) throw new Error(fs.lastError());
        await ingestPayload(fileName, "", bin);
      } else {
        const text = fs.readText(path);
        if (fs.lastError()) throw new Error(fs.lastError());
        await ingestPayload(fileName, text);
      }
      setPhoneOpen(false);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Import failed");
    }
  }

  function removeCell(id: string) {
    setCells((prev) => prev.filter((c) => c.id !== id));
    setDirty(true);
    setStatus("Cell closed");
  }

  async function mountData() {
    const dir = joinPath(ROOT, "data");
    const rows = await listDir(dir);
    const files: { path: string; text: string }[] = [];
    for (const row of rows) {
      if (row.kind !== "file") continue;
      files.push({ path: row.path, text: await readFile(row.path) });
    }
    if (files.length) await syncDataFiles(files);
  }

  async function runCell(cell: Cell) {
    if (cell.type !== "code") return;
    setRunning(cell.id);
    setStatus("Running Python…");
    try {
      await mountData();
      const result = await runPython(cell.content);
      const err = result.error_type ? `${result.error_type}: ${result.error_msg || ""}` : null;
      patch(
        cell.id,
        { stdout: result.stdout, stderr: result.stderr, images: result.images, error: err, outCollapsed: false },
        false,
      );
      const ver = await pythonVersion().catch(() => "");
      setStatus(err ? "Cell error" : "Ran" + (ver ? " · Python " + ver : ""));
    } catch (e) {
      patch(cell.id, { error: e instanceof Error ? e.message : String(e), stdout: "", stderr: "" }, false);
      setStatus("Python failed");
    } finally {
      setRunning(null);
    }
  }

  async function runAll() {
    setMenuOpen(false);
    for (const c of cellsRef.current) {
      if (c.type === "code") await runCell(c);
    }
    setStatus("Finished running all");
  }

  function notebookData() {
    return toIpynb(cellsRef.current);
  }

  async function silentSave() {
    if (!filePath || !filePath.endsWith(".ipynb")) return false;
    try {
      await writeFile(filePath, notebookData());
      setDirty(false);
      setSavedOnce(true);
      remember({ dirty: false, savedOnce: true });
      setStatus("Saved: " + filePath);
      return true;
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Save failed");
      return false;
    }
  }

  function openSave(partial: Partial<SaveState>) {
    const current = fileName || "notebook.ipynb";
    setBrowseDir(filePath ? parentPath(filePath) : ROOT);
    setSaveBox({
      name: partial.name || current,
      format: partial.format || "ipynb",
      after: partial.after ?? null,
      bind: partial.bind !== false,
    });
  }

  async function onSave() {
    setMenuOpen(false);
    if (closed) {
      setStatus("No notebook open");
      return;
    }
    if (savedOnce && filePath.endsWith(".ipynb")) {
      const ok = await silentSave();
      if (ok) {
        if (guard) finishAfter(guard);
        return;
      }
    }
    openSave({ name: fileName || "notebook.ipynb", format: "ipynb", after: guard, bind: true });
  }

  function finishAfter(action: After) {
    setGuard(null);
    if (action === "close") finishClose();
    if (action === "open") {
      // Jupyter Open = system file picker (not empty virtual folder only)
      pickDeviceFile();
    }
    if (action === "new") finishNew();
  }

  function finishClose() {
    setCells([]);
    setClosed(true);
    setDirty(false);
    setSavedOnce(false);
    setFileName("");
    setFilePath("");
    handleRef.current = null;
    setStatus("Notebook closed");
  }

  function finishNew() {
    const id = "c" + (idRef.current + 1);
    idRef.current += 1;
    const cell = freshCell(id, "code", "# New notebook\nprint('ready')\n");
    hist.current = new Map([[id, { stack: [cell.content], i: 0 }]]);
    setCells([cell]);
    setClosed(false);
    setDirty(false);
    setSavedOnce(false);
    setFileName("");
    setFilePath("");
    handleRef.current = null;
    setStatus("New notebook");
  }

  function request(action: After) {
    setMenuOpen(false);
    if (closed || !dirty) {
      finishAfter(action);
      return;
    }
    setGuard(action);
  }

  async function confirmSave() {
    if (!saveBox) return;
    const name = ensureExt(saveBox.name, saveBox.format);
    const path = joinPath(browseDir, name);
    const data =
      saveBox.bind === false && saveBox.format === "py" && activeId.current
        ? cellsRef.current.find((c) => c.id === activeId.current)?.content || ""
        : serializeExport(cellsRef.current, saveBox.format, name.replace(/\.[^.]+$/, ""));
    try {
      await writeFile(path, data);
      if (saveBox.bind && saveBox.format === "ipynb") {
        setFilePath(path);
        setFileName(baseName(path));
        setSavedOnce(true);
        setDirty(false);
        remember({ filePath: path, fileName: baseName(path), savedOnce: true, dirty: false, closed: false });
        setStatus("Saved: " + path);
      } else {
        remember();
        setStatus("Saved: " + path);
      }
      const after = saveBox.after;
      setSaveBox(null);
      if (after) finishAfter(after);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Save failed");
    }
  }

  async function openStored(path: string) {
    const text = await readFile(path);
    const name = baseName(path);
    if (name.endsWith(".ipynb")) {
      applyTextFile(name, text, null);
      setFilePath(path);
      setFileName(name);
      setSavedOnce(true);
      setDirty(false);
      remember({ filePath: path, fileName: name, savedOnce: true, dirty: false, closed: false });
      setOpenBox(false);
      return;
    }
    applyTextFile(name, text, null);
    setOpenBox(false);
  }

  function pickDeviceFile() {
    let input = document.getElementById("jide-device-open") as HTMLInputElement | null;
    if (!input) {
      input = document.createElement("input");
      input.type = "file";
      input.id = "jide-device-open";
      input.accept = ".ipynb,.py,.md,.txt,.csv,.json,.html";
      input.style.position = "fixed";
      input.style.left = "-9999px";
      document.body.appendChild(input);
    }
    input.value = "";
    input.onchange = async () => {
      const file = input!.files?.[0];
      if (!file) return;
      const text = await file.text();
      applyTextFile(file.name, text, null);
      setFilePath("");
      setSavedOnce(false);
      setFileName(file.name);
      setOpenBox(false);
      setStatus("Opened: " + file.name);
    };
    // Must stay in user gesture stack (WebView / mobile)
    input.click();
  }

  function applyTextFile(name: string, text: string, handle: FileHandle | null) {
    if (name.endsWith(".ipynb") || text.trim().startsWith("{")) {
      try {
        const rows = fromIpynb(text);
        const next = rows.map((r) => {
          const id = nextId();
          const cell = freshCell(id, r.type, r.content, r.title);
          if (r.title) cell.titleLocked = true;
          hist.current.set(id, { stack: [cell.content], i: 0 });
          return cell;
        });
        hist.current = new Map(next.map((c) => [c.id, { stack: [c.content], i: 0 }]));
        setCells(next.length ? next : [freshCell(nextId(), "code", "")]);
        setClosed(false);
        setDirty(false);
        setSavedOnce(true);
        setFileName(name);
        handleRef.current = handle;
        setStatus("Opened: " + name);
        return;
      } catch {
        if (name.endsWith(".ipynb")) {
          setStatus("Notebook file is broken");
          return;
        }
      }
    }
    if (name.endsWith(".py") || name.endsWith(".txt") || name.endsWith(".md")) {
      addCell(name.endsWith(".md") ? "markdown" : "code", text, name);
      setStatus("Imported: " + name);
      return;
    }
    const preview = text.length > 4000 ? text.slice(0, 4000) : text;
    addCell("code", `# Loaded: ${name}\ndata = ${JSON.stringify(preview)}\nprint("\\n".join(data.splitlines()[:12]))\n`, name);
    setStatus("Imported: " + name);
  }

  async function saveActiveCell() {
    setMenuOpen(false);
    const id = activeId.current;
    const cell = cellsRef.current.find((c) => c.id === id);
    if (!cell) {
      setStatus("No active cell");
      return;
    }
    openSave({
      name: ensureExt(cell.title || "cell.py", "py"),
      format: "py",
      after: null,
      bind: false,
    });
  }

  async function confirmCloseCell() {
    if (!closeCell) return;
    const cell = cellsRef.current.find((c) => c.id === closeCell.id);
    if (!cell) {
      setCloseCell(null);
      return;
    }
    if (!closeCell.nosave && closeCell.py) {
      const name = ensureExt(cell.title || "cell.py", "py");
      download(name, cell.content, "py");
      setStatus("Cell saved: " + name);
    }
    if (!closeCell.nosave && closeCell.nb) {
      if (!(await silentSave()) && !savedOnce) {
        setCloseCell(null);
        openSave({ name: fileName || "notebook.ipynb", format: "ipynb", after: null, bind: true });
        setStatus("Save the notebook first");
        return;
      }
    }
    removeCell(cell.id);
    setCloseCell(null);
  }

  function cellIsLocked(cell: Cell) {
    if (cell.forceEdit) return false;
    return editLock || cell.editLocked;
  }

  function toggleGlobalEdit() {
    setEditLock((v) => {
      const next = !v;
      if (!next) setCells((prev) => prev.map((c) => ({ ...c, editLocked: false, forceEdit: false })));
      setStatus(next ? "All editing locked" : "All editing unlocked");
      return next;
    });
  }

  function rereadTitle(cell: Cell) {
    const auto = titleFromCode(cell.content);
    if (!auto) {
      setStatus("No name in the top comments");
      return;
    }
    patch(cell.id, { title: auto, titleLocked: false });
    setStatus("Name from code: " + auto);
  }

  function activeLocked() {
    const id = activeId.current;
    const cell = cellsRef.current.find((c) => c.id === id);
    return !cell || cellIsLocked(cell);
  }

  function insertIntoActive(text: string) {
    const ta = activeTa.current;
    if (!ta || !activeId.current) {
      setStatus("Tap inside the code first");
      return;
    }
    if (activeLocked()) {
      setStatus("Editing is locked");
      return;
    }
    ta.focus();
    const ok = document.execCommand("insertText", false, text);
    if (!ok) {
      const a = ta.selectionStart ?? 0;
      const b = ta.selectionEnd ?? 0;
      const next = ta.value.slice(0, a) + text + ta.value.slice(b);
      const id = activeId.current;
      const cell = cellsRef.current.find((c) => c.id === id);
      if (cell) onEdit(cell, next);
      window.setTimeout(() => {
        ta.focus();
        ta.selectionStart = ta.selectionEnd = a + text.length;
      }, 0);
    }
  }

  function fireKey(key: string) {
    const ta = activeTa.current;
    if (key === "ctrl") {
      ctrlRef.current = !ctrlRef.current;
      setMods({ ctrl: ctrlRef.current, shift: shiftRef.current });
      return;
    }
    if (key === "shift") {
      shiftRef.current = !shiftRef.current;
      setMods({ ctrl: ctrlRef.current, shift: shiftRef.current });
      return;
    }
    if (!ta || !activeId.current) {
      setStatus("Tap inside the code first");
      return;
    }
    ta.focus();
    const ctrl = ctrlRef.current;
    if (key === "select-all" || (ctrl && key.toLowerCase() === "a")) {
      ta.selectionStart = 0;
      ta.selectionEnd = ta.value.length;
      setStatus("Whole cell selected");
      return;
    }
    if (key === "copy" || (ctrl && key.toLowerCase() === "c")) {
      const text = ta.value.slice(ta.selectionStart ?? 0, ta.selectionEnd ?? 0);
      if (!text) setStatus("Nothing selected");
      else {
        clipRef.current = text;
        void copyText(text);
        setStatus("Copied");
      }
      return;
    }
    if (key === "cut" || (ctrl && key.toLowerCase() === "x")) {
      const a = ta.selectionStart ?? 0;
      const b = ta.selectionEnd ?? 0;
      const text = ta.value.slice(a, b);
      if (!text) setStatus("Nothing selected");
      else if (!activeLocked()) {
        clipRef.current = text;
        void copyText(text);
        const id = activeId.current;
        const cell = cellsRef.current.find((c) => c.id === id);
        if (cell) onEdit(cell, ta.value.slice(0, a) + ta.value.slice(b));
        setStatus("Cut");
      }
      return;
    }
    if (key === "paste" || (ctrl && key.toLowerCase() === "v")) {
      void (async () => {
        let text = clipRef.current;
        try {
          const sys = await navigator.clipboard.readText();
          if (sys) text = sys;
        } catch {
          /* keep internal */
        }
        if (!text) {
          setStatus("Clipboard is empty");
          return;
        }
        insertIntoActive(text);
        setStatus("Pasted");
      })();
      return;
    }
    if (key === "Escape") {
      if (suggestCancel()) return;
      ta.blur();
      return;
    }
    if (key === "Tab") {
      if (suggestAccept()) return;
      insertIntoActive("    ");
      return;
    }
    if (key.startsWith("Arrow") || key === "Home" || key === "End") {
      if ((key === "ArrowUp" || key === "ArrowDown") && suggestMove(key === "ArrowDown" ? 1 : -1)) return;
      const len = ta.value.length;
      let pos = ta.selectionStart ?? 0;
      if (key === "ArrowLeft") pos = Math.max(0, pos - 1);
      if (key === "ArrowRight") pos = Math.min(len, pos + 1);
      if (key === "Home") pos = ta.value.lastIndexOf("\n", Math.max(0, pos - 1)) + 1;
      if (key === "End") {
        const nl = ta.value.indexOf("\n", pos);
        pos = nl === -1 ? len : nl;
      }
      if (key === "ArrowUp" || key === "ArrowDown") {
        const lines = ta.value.split("\n");
        let remain = pos;
        let line = 0;
        for (; line < lines.length; line++) {
          const size = (lines[line]?.length ?? 0) + 1;
          if (remain < size) break;
          remain -= size;
        }
        const nextLine = line + (key === "ArrowUp" ? -1 : 1);
        if (nextLine < 0 || nextLine >= lines.length) return;
        let base = 0;
        for (let i = 0; i < nextLine; i++) base += (lines[i]?.length ?? 0) + 1;
        pos = base + Math.min(remain, lines[nextLine]?.length ?? 0);
      }
      ta.selectionStart = ta.selectionEnd = pos;
      return;
    }
    if (key.length === 1) insertIntoActive(shiftRef.current ? key.toUpperCase() : key);
  }

  async function doInstall(name: string) {
    const n = name.trim();
    if (!n) return;
    setPkgLog((l) => l + "\nInstalling " + n + " …");
    setStatus("Installing " + n);
    try {
      await installPackage(n);
      setLoaded((prev) => (prev.includes(n) ? prev : [...prev, n]));
      setPkgLog((l) => l + "\nReady: " + n);
      setStatus("Installed: " + n);
    } catch (e) {
      setPkgLog((l) => l + "\nError: " + (e instanceof Error ? e.message : String(e)));
      setStatus("Install failed: " + n);
    }
  }

  function applyCtxCopy(text: string, label: string) {
    if (!text) {
      setStatus("Nothing selected");
      setCtx(null);
      return;
    }
    clipRef.current = text;
    void copyText(text);
    setStatus(label);
    setCtx(null);
  }

  function ctxCopy() {
    if (!ctx) return;
    const a = Math.min(ctx.start, ctx.end);
    const b = Math.max(ctx.start, ctx.end);
    applyCtxCopy(ctx.value.slice(a, b), "Selection copied");
  }

  function ctxLine() {
    if (!ctx) return;
    applyCtxCopy(lineOf(ctx.value, Math.min(ctx.start, ctx.end)), "Line copied");
  }

  function ctxCut() {
    if (!ctx) return;
    const cell = cellsRef.current.find((c) => c.id === ctx.cellId);
    if (!cell || cellIsLocked(cell)) {
      setStatus("Editing is locked");
      setCtx(null);
      return;
    }
    const a = Math.min(ctx.start, ctx.end);
    const b = Math.max(ctx.start, ctx.end);
    const text = ctx.value.slice(a, b);
    if (!text) {
      setStatus("Nothing selected");
      setCtx(null);
      return;
    }
    clipRef.current = text;
    void copyText(text);
    onEdit(cell, ctx.value.slice(0, a) + ctx.value.slice(b));
    setStatus("Cut");
    setCtx(null);
  }

  async function ctxPaste() {
    if (!ctx) return;
    const cell = cellsRef.current.find((c) => c.id === ctx.cellId);
    if (!cell || cellIsLocked(cell)) {
      setStatus("Editing is locked");
      setCtx(null);
      return;
    }
    let text = clipRef.current;
    try {
      const sys = await navigator.clipboard.readText();
      if (sys) text = sys;
    } catch {
      /* internal clip */
    }
    if (!text) {
      setStatus("Clipboard is empty");
      setCtx(null);
      return;
    }
    const a = Math.min(ctx.start, ctx.end);
    const b = Math.max(ctx.start, ctx.end);
    onEdit(cell, ctx.value.slice(0, a) + text + ctx.value.slice(b));
    setStatus("Pasted");
    setCtx(null);
  }

  function ctxAll() {
    if (!ctx) return;
    const ta = activeTa.current;
    if (ta) {
      ta.focus();
      ta.selectionStart = 0;
      ta.selectionEnd = ta.value.length;
    }
    setStatus("Whole cell selected");
    setCtx(null);
  }

  function ctxCutLine() {
    if (!ctx) return;
    const cell = cellsRef.current.find((c) => c.id === ctx.cellId);
    if (!cell || cellIsLocked(cell)) {
      setStatus("Editing is locked");
      setCtx(null);
      return;
    }
    const bounds = lineBounds(ctx.value, Math.min(ctx.start, ctx.end));
    const text = ctx.value.slice(bounds.start, bounds.end);
    clipRef.current = text;
    void copyText(text);
    onEdit(cell, ctx.value.slice(0, bounds.start) + ctx.value.slice(bounds.end));
    setStatus("Line cut");
    setCtx(null);
  }

  function moveKey(index: number, dir: -1 | 1) {
    setSettings((s) => {
      const keys = s.keys.slice();
      const j = index + dir;
      if (j < 0 || j >= keys.length) return s;
      const a = keys[index];
      const b = keys[j];
      if (!a || !b) return s;
      keys[index] = b;
      keys[j] = a;
      return { ...s, keys };
    });
  }

  const maximized = cells.some((c) => c.maximized);
  const ctxStyle = ctx
    ? {
        left: Math.max(8, Math.min(ctx.x - 12, (typeof window !== "undefined" ? window.innerWidth : 360) - 280)),
        top: Math.max(dashH + 6, ctx.y - 36),
      }
    : undefined;
  const ctxNoSel = !ctx || ctx.start === ctx.end;

  return (
    <div
      ref={shellRef}
      className={
        "shell theme-" +
        settings.theme +
        " code-" +
        settings.codeTheme +
        (maximized ? " is-max" : "") +
        (settings.twoRows ? " keys-two" : "")
      }
      onPointerDown={() => setCtx(null)}
    >
      <header className="dash" ref={dashRef}>
        <div className="dash-top">
          <div className="brand">
            <span className="logo" aria-hidden="true">
              <svg viewBox="0 0 32 32" width="22" height="22">
                <rect width="32" height="32" rx="8" fill="#0d1117" />
                <rect x="4" y="5" width="24" height="22" rx="3" fill="#161b22" stroke="#30363d" />
                <rect x="4" y="5" width="3" height="22" fill="#58a6ff" />
                <rect x="10" y="10" width="14" height="2" rx="1" fill="#3fb950" />
                <rect x="10" y="15" width="10" height="2" rx="1" fill="#569cd6" />
                <rect x="10" y="20" width="12" height="2" rx="1" fill="#ce9178" />
              </svg>
            </span>
            <div>
              <div className="brand-name">
                Jupyter IDE <span className="ver">{APP_VERSION}</span>
              </div>
              <div className="brand-file">
                {closed ? "No notebook" : filePath || fileName || "Untitled"}
                {dirty && !closed ? " •" : ""}
              </div>
            </div>
          </div>
          <div className="dash-actions">
            <LongPress
              className={"icon-btn" + (moveLock ? " is-on" : "")}
              title="Long-press: lock moving all cells"
              onLong={() => {
                setMoveLock((v) => !v);
                setStatus(!moveLock ? "Moving locked" : "Moving unlocked");
              }}
              onShort={() => setStatus("Hold to lock moving")}
            >
              <Lock size={15} />
              <ArrowUp size={11} />
            </LongPress>
            <LongPress
              className={"icon-btn" + (editLock ? " is-on" : "")}
              title="Long-press: lock editing all cells"
              onLong={toggleGlobalEdit}
              onShort={() => setStatus("Hold to lock editing")}
            >
              <Lock size={15} />
              <Pencil size={11} />
            </LongPress>
            <button
              type="button"
              className="icon-btn"
              title="Minimize all"
              onClick={() => {
                setCells((prev) => prev.map((c) => ({ ...c, collapsed: true, outCollapsed: true, maximized: false })));
                setStatus("All minimized");
              }}
            >
              <Minus size={16} />
            </button>
            <a className="text-btn" href="/download/JupyterIDE-9.3.apk" download="JupyterIDE-9.3.apk">
              APK
            </a>
            <button type="button" className="text-btn" onClick={() => addCell("code")}>
              <Plus size={14} /> Code
            </button>
            <button type="button" className="text-btn" onClick={() => addCell("markdown")}>
              <Plus size={14} /> MD
            </button>
            <button type="button" className="text-btn primary" onClick={() => void runAll()} title="Run all">
              <Play size={14} />
            </button>
            <button
              type="button"
              className="icon-btn menu-btn"
              title="Menu"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => setMenuOpen((v) => !v)}
            >
              <Menu size={18} />
            </button>
          </div>
        </div>
        <div className={"status-line" + (dirty ? " dirty" : "")}>{status}</div>
        {menuOpen && (
          <div className="app-menu" onPointerDown={(e) => e.stopPropagation()}>
            <button type="button" onClick={() => request("new")}>
              New notebook
            </button>
            <button type="button" onClick={() => request("open")}>
              Open…
            </button>
            <button type="button" onClick={() => void onSave()}>
              Save
            </button>
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false);
                if (closed) return setStatus("No notebook open");
                openSave({
                  name: fileName ? fileName.replace(/\.[^.]+$/, "") + "-copy.ipynb" : "notebook.ipynb",
                  format: "ipynb",
                  after: null,
                  bind: true,
                });
              }}
            >
              Save As…
            </button>
            <button type="button" onClick={() => request("close")}>
              Close
            </button>
            <button type="button" onClick={() => void saveActiveCell()}>
              Save active cell
            </button>
            <hr />
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false);
                setPkgOpen(true);
              }}
            >
              Packages
            </button>
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false);
                setFinanceOpen(true);
              }}
            >
              Finance checklist
            </button>
            <button type="button" onClick={importData}>
              Import data…
            </button>
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false);
                setPhoneRows([]);
                setPhoneOpen(true);
                androidFs()?.requestAccess();
              }}
            >
              Phone path…
            </button>
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false);
                void restartKernel()
                  .then(() => setStatus("Kernel restarted"))
                  .catch(() => setStatus("Kernel is not up yet"));
              }}
            >
              Restart kernel
            </button>
            <a className="menu-download" href="/jupyter-ide.zip" download="jupyter-ide.zip">
              Download code
            </a>
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false);
                setSettingsOpen(true);
              }}
            >
              Settings
            </button>
          </div>
        )}
      </header>

      <main className="notebook" ref={nbRef}>
        {closed && (
          <div className="empty-floor">
            <h2>No notebook open</h2>
            <p>The notebook floor is empty. Create a notebook or open one from the menu.</p>
            <button type="button" className="text-btn primary" onClick={() => finishNew()}>
              New notebook
            </button>
          </div>
        )}
        {!closed &&
          cells.map((cell) => {
            const locked = cellIsLocked(cell);
            return (
              <article
                key={cell.id}
                id={"cell-" + cell.id}
                className={"cell" + (cell.type === "markdown" ? " md" : "") + (cell.maximized ? " is-max" : "") + (locked ? " is-locked" : "")}
                style={
                  cell.maximized
                    ? { top: dashH, ["--ratio" as string]: String(cell.maxRatio) }
                    : undefined
                }
              >
                <div className="cell-chrome">
                  <div className="cell-titlebar">
                    <span className={"badge" + (cell.type === "markdown" ? " md" : "")}>{cell.type === "code" ? "CODE" : "MD"}</span>
                    {renaming === cell.id ? (
                      <input
                        className="title-input"
                        autoFocus
                        defaultValue={cell.title}
                        onBlur={(e) => {
                          const t = e.target.value.trim();
                          if (t && t !== cell.title) patch(cell.id, { title: t, titleLocked: true });
                          setRenaming(null);
                          setStatus(t ? "Name set by you" : "Name unchanged");
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") e.currentTarget.blur();
                        }}
                      />
                    ) : (
                      <LongPress
                        className="cell-title"
                        title="Hold to rename"
                        ms={450}
                        onLong={() => setRenaming(cell.id)}
                        onShort={() => undefined}
                      >
                        <span>{cell.title}</span>
                      </LongPress>
                    )}
                    {cell.editLocked && <Lock size={12} />}
                    {cell.type === "code" && (
                      <button type="button" className="tiny" title="Read the name from the code again" onClick={() => rereadTitle(cell)}>
                        <RefreshCw size={12} />
                      </button>
                    )}
                  </div>
                  <div className="cell-tools">
                    <button type="button" className="icon-btn" title="Undo" onClick={() => undo(cell.id)}>
                      <Undo2 size={15} />
                    </button>
                    <button type="button" className="icon-btn" title="Redo" onClick={() => redo(cell.id)}>
                      <Redo2 size={15} />
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      title="Minimize"
                      onClick={() => {
                        const min = cell.collapsed && cell.outCollapsed;
                        const key = cell.id + ":min";
                        if (!min) {
                          layoutSnap.current.set(key, {
                            editorHeight: cell.editorHeight,
                            outputHeight: cell.outputHeight,
                            maxRatio: cell.maxRatio,
                            collapsed: cell.collapsed,
                            outCollapsed: cell.outCollapsed,
                          });
                          patch(cell.id, { collapsed: true, outCollapsed: true, maximized: false });
                        } else {
                          const snap = layoutSnap.current.get(key);
                          patch(
                            cell.id,
                            snap
                              ? { ...snap, maximized: false }
                              : { collapsed: false, outCollapsed: false, maximized: false },
                          );
                        }
                      }}
                    >
                      {cell.collapsed && cell.outCollapsed ? <Square size={14} /> : <Minus size={15} />}
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      title="Maximize, then drag the handle"
                      onClick={() => {
                        if (!cell.maximized) {
                          layoutSnap.current.set(cell.id, {
                            editorHeight: cell.editorHeight,
                            outputHeight: cell.outputHeight,
                            maxRatio: cell.maxRatio,
                            collapsed: cell.collapsed,
                            outCollapsed: cell.outCollapsed,
                          });
                          setCells((prev) => prev.map((c) => ({ ...c, maximized: c.id === cell.id })));
                          setStatus("Maximized — drag the handle");
                        } else {
                          const snap = layoutSnap.current.get(cell.id);
                          setCells((prev) =>
                            prev.map((c) => (c.id === cell.id ? { ...c, maximized: false, ...(snap ?? {}) } : { ...c, maximized: false })),
                          );
                          setStatus("Back to the previous size");
                        }
                      }}
                    >
                      <UnfoldVertical size={15} />
                    </button>
                    <LongPress
                      className={"icon-btn" + (locked ? " is-on" : "")}
                      title="Long-press: lock or unlock this cell"
                      onLong={() => {
                        if (locked) {
                          patch(cell.id, { forceEdit: true, editLocked: false });
                          setStatus("This cell is unlocked");
                        } else {
                          patch(cell.id, { forceEdit: false, editLocked: true });
                          setStatus("This cell is locked");
                        }
                      }}
                      onShort={() => setStatus("Hold to lock this cell")}
                    >
                      <Pencil size={14} />
                    </LongPress>
                    <button type="button" className="icon-btn" title="Up" onClick={() => move(cell.id, -1)}>
                      <ChevronUp size={16} />
                    </button>
                    <button type="button" className="icon-btn" title="Down" onClick={() => move(cell.id, 1)}>
                      <ChevronDown size={16} />
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      title="Close cell"
                      onClick={() => setCloseCell({ id: cell.id, py: cell.type === "code", nb: false, nosave: false })}
                    >
                      <X size={16} />
                    </button>
                    <span className="grow" />
                    {cell.type === "code" ? (
                      <button type="button" className="text-btn primary" disabled={running === cell.id} onClick={() => void runCell(cell)}>
                        <Play size={14} /> {running === cell.id ? "…" : "Run"}
                      </button>
                    ) : null}
                  </div>
                </div>
                <div
                  className={"editor-wrap" + (cell.collapsed ? " collapsed" : "")}
                  style={cell.maximized ? undefined : { height: cell.editorHeight }}
                >
                  <CodeEditor
                    value={cell.content}
                    readOnly={locked}
                    fontSize={settings.fontSize}
                    wrap={settings.wrap}
                    indentGuides={settings.guides}
                    plain={cell.type === "markdown"}
                    onChange={(v) => onEdit(cell, v)}
                    onFocus={(el) => {
                      activeTa.current = el;
                      activeId.current = cell.id;
                      if (!cell.maximized) stickCell(cell.id);
                    }}
                    onBlur={() => {
                      if (cell.type === "code" && !cell.titleLocked) {
                        const auto = titleFromCode(cell.content);
                        if (auto && auto !== cell.title) patch(cell.id, { title: auto });
                      }
                    }}
                    onMenu={(info) => {
                      activeId.current = cell.id;
                      setCtx({ ...info, cellId: cell.id });
                    }}
                  />
                </div>
                <div
                  className="resize"
                  onPointerDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const startY = e.clientY;
                    const startH = cell.editorHeight;
                    const startR = cell.maxRatio;
                    const moveEv = (ev: PointerEvent) => {
                      const dy = ev.clientY - startY;
                      if (cell.maximized) {
                        const usable = Math.max(180, window.innerHeight - dashH - 96);
                        const ratio = Math.min(0.85, Math.max(0.25, startR + dy / usable));
                        patch(cell.id, { maxRatio: ratio }, false);
                      } else {
                        patch(cell.id, { editorHeight: Math.max(72, Math.min(920, startH + dy)) }, false);
                      }
                    };
                    const up = () => {
                      window.removeEventListener("pointermove", moveEv);
                      window.removeEventListener("pointerup", up);
                    };
                    window.addEventListener("pointermove", moveEv);
                    window.addEventListener("pointerup", up);
                  }}
                >
                  <span />
                </div>
                {cell.type === "markdown" && !cell.collapsed && (
                  <div className="md-preview" style={{ fontSize: settings.outSize }} dangerouslySetInnerHTML={{ __html: simpleMarkdown(cell.content) }} />
                )}
                {cell.type === "code" && (
                  <section className={"output" + (cell.outCollapsed ? " collapsed" : "")} style={cell.maximized ? undefined : { height: cell.outputHeight }}>
                    <div className="output-bar">
                      <span>OUTPUT</span>
                      <button
                        type="button"
                        className="tiny"
                        onClick={() => {
                          const text = [cell.stdout, cell.stderr, cell.error].filter(Boolean).join("\n");
                          clipRef.current = text;
                          void copyText(text);
                          setStatus(text ? "Output copied" : "Output is empty");
                        }}
                      >
                        <Copy size={12} />
                      </button>
                    </div>
                    {!cell.outCollapsed && (
                      <div className="output-body" style={{ fontSize: settings.outSize }}>
                        {cell.error && <pre className="err">{cell.error}</pre>}
                        {cell.stderr && <pre className="warn">{cell.stderr}</pre>}
                        {cell.stdout && <pre>{cell.stdout}</pre>}
                        {cell.images.map((img, i) => (
                          <img key={i} alt="" src={"data:image/png;base64," + img} />
                        ))}
                        {!cell.stdout && !cell.stderr && !cell.error && cell.images.length === 0 && <p className="muted">No output yet</p>}
                      </div>
                    )}
                  </section>
                )}
                {cell.type === "code" && (
                  <div
                    className="resize out"
                    onPointerDown={(e) => {
                      if (cell.maximized) return;
                      e.preventDefault();
                      const startY = e.clientY;
                      const startH = cell.outputHeight;
                      const moveEv = (ev: PointerEvent) => {
                        patch(cell.id, { outputHeight: Math.max(48, Math.min(720, startH + (ev.clientY - startY))) }, false);
                      };
                      const up = () => {
                        window.removeEventListener("pointermove", moveEv);
                        window.removeEventListener("pointerup", up);
                      };
                      window.addEventListener("pointermove", moveEv);
                      window.addEventListener("pointerup", up);
                    }}
                  >
                    <span />
                  </div>
                )}
              </article>
            );
          })}
        {!closed && <div className="floor"></div>}
      </main>

      <div className={"keybar" + (settings.twoRows ? " two" : "")} onPointerDown={(e) => e.stopPropagation()}>
        {settings.keys.map((k) => (
          <button
            key={k.id}
            type="button"
            className={
              "key" +
              (k.key === "ctrl" && mods.ctrl ? " on" : "") +
              (k.key === "shift" && mods.shift ? " on" : "")
            }
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => fireKey(k.key)}
          >
            {k.label}
          </button>
        ))}
      </div>

      {ctx && (
        <div className="ctx" style={ctxStyle} onPointerDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
          <button type="button" onClick={ctxCopy} disabled={ctxNoSel}>
            Copy
          </button>
          <button type="button" onClick={ctxLine}>
            Copy line
          </button>
          <button type="button" onClick={ctxCut} disabled={ctxNoSel}>
            Cut
          </button>
          <button type="button" onClick={ctxCutLine}>
            Cut line
          </button>
          <button type="button" onClick={() => void ctxPaste()}>
            Paste
          </button>
          <button type="button" onClick={ctxAll}>
            Select all
          </button>
        </div>
      )}

      {saveBox && (
        <Modal title={saveBox.bind ? (filePath ? "Save As" : "Save") : "Save cell"} onClose={() => setSaveBox(null)}>
          <FolderPane dir={browseDir} onDir={setBrowseDir} />
          <label>
            File name
            <input
              aria-label="File name"
              value={saveBox.name}
              onChange={(e) => setSaveBox({ ...saveBox, name: e.target.value })}
              autoFocus
            />
          </label>
          <label>
            Format
            <select
              aria-label="Format"
              value={saveBox.format}
              onChange={(e) => {
                const format = e.target.value as FileFormat;
                setSaveBox({ ...saveBox, format, name: ensureExt(saveBox.name, format) });
              }}
            >
              <option value="ipynb">Notebook (.ipynb)</option>
              <option value="py">Python (.py)</option>
              <option value="md">Markdown (.md)</option>
              <option value="html">HTML (.html)</option>
            </select>
          </label>
          <p className="hint">The file is saved at the path above. Cancel leaves the notebook open.</p>
          <div className="row-actions">
            <button type="button" className="text-btn" onClick={() => setSaveBox(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="text-btn"
              onClick={() => download(ensureExt(saveBox.name, saveBox.format), serializeExport(cellsRef.current, saveBox.format, saveBox.name), saveBox.format)}
            >
              Download copy
            </button>
            <button type="button" className="text-btn primary" onClick={() => void confirmSave()}>
              Save
            </button>
          </div>
        </Modal>
      )}

      {phoneOpen && (
        <Modal title="Phone file" onClose={() => setPhoneOpen(false)}>
          <p className="hint">Example: /storage/emulated/0/backups/mini_database/btc_4h.csv. Allow all-files access when Android asks.</p>
          <label>
            Path
            <input aria-label="Phone path" value={phonePath} onChange={(e) => setPhonePath(e.target.value)} />
          </label>
          <div className="file-list">
            {phoneRows.map((row) => (
              <button
                key={row.name}
                type="button"
                onClick={() => void openPhonePath(phonePath.replace(/\/$/, "") + "/" + row.name)}
              >
                {row.kind === "dir" ? "Folder  " : "File  "}
                {row.name}
              </button>
            ))}
          </div>
          <div className="row-actions">
            <button type="button" className="text-btn" onClick={() => setPhoneOpen(false)}>
              Cancel
            </button>
            <button type="button" className="text-btn primary" onClick={() => void openPhonePath(phonePath)}>
              Open
            </button>
          </div>
        </Modal>
      )}

      {openBox && (
        <Modal title="Open" onClose={() => setOpenBox(false)}>
          <FolderPane
            dir={browseDir}
            onDir={setBrowseDir}
            onOpenFile={(path) => {
              void openStored(path).catch((e) => setStatus(e instanceof Error ? e.message : "Open failed"));
            }}
          />
          <p className="hint">Choose a file in this folder, or open one from the device.</p>
          <div className="row-actions">
            <button type="button" className="text-btn" onClick={() => setOpenBox(false)}>
              Cancel
            </button>
            <button type="button" className="text-btn primary" onClick={pickDeviceFile}>
              From device
            </button>
          </div>
        </Modal>
      )}

      {guard && (
        <Modal title="Unsaved changes" onClose={() => setGuard(null)}>
          <p className="hint">This notebook has changes that are not saved.</p>
          <div className="row-actions">
            <button type="button" className="text-btn" onClick={() => setGuard(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="text-btn"
              onClick={() => {
                const action = guard;
                setGuard(null);
                setDirty(false);
                finishAfter(action);
              }}
            >
              Don't save
            </button>
            <button type="button" className="text-btn primary" onClick={() => void onSave()}>
              Save
            </button>
          </div>
        </Modal>
      )}

      {closeCell && (
        <Modal title="Close cell" onClose={() => setCloseCell(null)}>
          <p className="hint">Save before closing?</p>
          <label className="check">
            <input
              type="checkbox"
              checked={closeCell.py}
              onChange={(e) => setCloseCell({ ...closeCell, py: e.target.checked, nosave: e.target.checked ? false : closeCell.nosave })}
            />
            Save cell as .py
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={closeCell.nb}
              onChange={(e) => setCloseCell({ ...closeCell, nb: e.target.checked, nosave: e.target.checked ? false : closeCell.nosave })}
            />
            Save notebook .ipynb
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={closeCell.nosave}
              onChange={(e) =>
                setCloseCell({
                  ...closeCell,
                  nosave: e.target.checked,
                  py: e.target.checked ? false : closeCell.py,
                  nb: e.target.checked ? false : closeCell.nb,
                })
              }
            />
            Close without saving
          </label>
          <div className="row-actions">
            <button type="button" className="text-btn" onClick={() => setCloseCell(null)}>
              Cancel
            </button>
            <button type="button" className="text-btn primary" onClick={() => void confirmCloseCell()}>
              OK
            </button>
          </div>
        </Modal>
      )}

      {ask && (
        <Modal
          title="Python input"
          onClose={() => {
            ask.resolve("");
            setAsk(null);
          }}
        >
          <p className="hint">{ask.prompt || "input()"}</p>
          <input
            autoFocus
            value={askValue}
            onChange={(e) => setAskValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                ask.resolve(askValue);
                setAsk(null);
              }
            }}
          />
          <div className="row-actions">
            <button
              type="button"
              className="text-btn"
              onClick={() => {
                ask.resolve("");
                setAsk(null);
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="text-btn primary"
              onClick={() => {
                ask.resolve(askValue);
                setAsk(null);
              }}
            >
              OK
            </button>
          </div>
        </Modal>
      )}

      {pkgOpen && (
        <Modal title="Packages" onClose={() => setPkgOpen(false)}>
          <p className="hint">Stdlib only at first. Install the rest when you need them.</p>
          <input value={pkgName} placeholder="e.g. yfinance" onChange={(e) => setPkgName(e.target.value)} />
          <div className="row-actions">
            <button type="button" className="text-btn" onClick={() => setPkgOpen(false)}>
              Close
            </button>
            <button type="button" className="text-btn primary" onClick={() => void doInstall(pkgName)}>
              Install
            </button>
          </div>
          <pre className="log">{pkgLog || (loaded.length ? loaded.join("\n") : "Nothing installed yet")}</pre>
        </Modal>
      )}

      {financeOpen && (
        <Modal title="Finance" onClose={() => setFinanceOpen(false)}>
          <ul className="finance">
            {FINANCE_PKGS.map((p) => (
              <li key={p.name}>
                <span>
                  <b>{p.name}</b>
                  <small>{p.desc}</small>
                </span>
                <button type="button" className="text-btn" onClick={() => void doInstall(p.name)}>
                  {loaded.includes(p.name) ? "Reload" : "Install"}
                </button>
              </li>
            ))}
          </ul>
          <div className="row-actions">
            <button type="button" className="text-btn primary" onClick={() => setFinanceOpen(false)}>
              Close
            </button>
          </div>
        </Modal>
      )}

      {settingsOpen && (
        <Modal title="Settings" onClose={() => setSettingsOpen(false)}>
          <label>
            Theme
            <select
              value={settings.theme}
              onChange={(e) => setSettings({ ...settings, theme: e.target.value as Settings["theme"] })}
            >
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </label>
          <label>
            Code colors
            <select
              value={settings.codeTheme}
              onChange={(e) => setSettings({ ...settings, codeTheme: e.target.value as Settings["codeTheme"] })}
            >
              <option value="ide">Jupyter IDE</option>
              <option value="monokai">Monokai</option>
              <option value="dracula">Dracula</option>
              <option value="github">GitHub</option>
            </select>
          </label>
          <label>
            Code size {settings.fontSize}
            <input
              type="range"
              min={12}
              max={20}
              value={settings.fontSize}
              onChange={(e) => setSettings({ ...settings, fontSize: Number(e.target.value) })}
            />
          </label>
          <label>
            Output size {settings.outSize}
            <input
              type="range"
              min={11}
              max={18}
              value={settings.outSize}
              onChange={(e) => setSettings({ ...settings, outSize: Number(e.target.value) })}
            />
          </label>
          <label className="check">
            <input type="checkbox" checked={settings.wrap} onChange={(e) => setSettings({ ...settings, wrap: e.target.checked })} />
            Wrap lines
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={settings.guides}
              onChange={(e) => setSettings({ ...settings, guides: e.target.checked })}
            />
            Indent guides
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={settings.twoRows}
              onChange={(e) => setSettings({ ...settings, twoRows: e.target.checked })}
            />
            Wider bar, two rows
          </label>
          <p className="hint">Reorder the programming keys</p>
          <ul className="key-edit">
            {settings.keys.map((k, i) => (
              <li key={k.id}>
                <span>{k.label}</span>
                <button type="button" className="tiny" onClick={() => moveKey(i, -1)} aria-label="Up">
                  <ChevronUp size={14} />
                </button>
                <button type="button" className="tiny" onClick={() => moveKey(i, 1)} aria-label="Down">
                  <ChevronDown size={14} />
                </button>
              </li>
            ))}
          </ul>
          <div className="row-actions">
            <button type="button" className="text-btn" onClick={() => setSettings({ ...settings, keys: DEFAULT_KEYS, twoRows: false })}>
              Reset keys
            </button>
            <button type="button" className="text-btn primary" onClick={() => setSettingsOpen(false)}>
              Done
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      className="modal-back"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="modal-card" role="dialog" aria-label={title}>
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}

function LongPress({
  children,
  className,
  title,
  onLong,
  onShort,
  ms = 1800,
}: {
  children: React.ReactNode;
  className?: string;
  title?: string;
  onLong: () => void;
  onShort: () => void;
  ms?: number;
}) {
  const timer = useRef<number | null>(null);
  const fired = useRef(false);
  const clear = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
  };
  const start = () => {
    clear();
    fired.current = false;
    timer.current = window.setTimeout(() => {
      fired.current = true;
      timer.current = null;
      onLong();
    }, ms);
  };
  return (
    <button
      type="button"
      className={className}
      title={title}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onTouchStart={start}
      onTouchEnd={clear}
      onTouchMove={clear}
      onTouchCancel={clear}
      onMouseDown={start}
      onMouseUp={clear}
      onMouseLeave={clear}
      onClick={() => {
        if (fired.current) {
          fired.current = false;
          return;
        }
        onShort();
      }}
    >
      {children}
    </button>
  );
}
