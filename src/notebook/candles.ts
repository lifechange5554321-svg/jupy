export type Table = { columns: string[]; rows: Record<string, string>[] };
export type DataBook = { tables: Record<string, Record<string, string>[]> };

export function checkDevicePath(input: string) {
  const path = input.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (!/^\/(storage|sdcard)(\/|$)/.test(path)) {
    throw new Error("Use a path like /storage/emulated/0/backups/mini_database/btc_4h.csv");
  }
  if (path.split("/").some((part) => part === "..")) throw new Error("Invalid path");
  return path;
}

export function safeDataName(name: string) {
  const base = name.split(/[/\\]/).pop()?.trim() || "data.csv";
  return base.replace(/[\\:*?"<>|]/g, "_");
}

export function sniffDelimiter(text: string) {
  const line = text.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0] || "";
  const commas = (line.match(/,/g) || []).length;
  const tabs = (line.match(/\t/g) || []).length;
  const semis = (line.match(/;/g) || []).length;
  if (tabs > commas && tabs >= semis) return "\t";
  if (semis > commas) return ";";
  return ",";
}

export function parseCsv(text: string, delimiter?: string): Table {
  const src = text.replace(/^\uFEFF/, "");
  const delim = delimiter || sniffDelimiter(src);
  const records = splitCsv(src, delim);
  if (!records.length) return { columns: [], rows: [] };
  const columns = records[0].map((c, i) => c.trim() || "c" + (i + 1));
  const rows = records
    .slice(1)
    .filter((row) => row.some((cell) => cell.trim() !== ""))
    .map((row) => {
      const out: Record<string, string> = {};
      columns.forEach((col, i) => {
        out[col] = row[i] ?? "";
      });
      return out;
    });
  return { columns, rows };
}

function splitCsv(text: string, delim: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quote = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') {
      quote = true;
      continue;
    }
    if (ch === delim) {
      row.push(cell);
      cell = "";
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += ch;
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

export function parseJsonTable(text: string): Table {
  let data = JSON.parse(text) as unknown;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>;
    for (const key of ["candles", "data", "ohlcv", "rows", "klines"]) {
      if (Array.isArray(obj[key])) {
        data = obj[key];
        break;
      }
    }
    if (!Array.isArray(data) && obj.tables && typeof obj.tables === "object") {
      const first = Object.values(obj.tables as Record<string, unknown>).find(Array.isArray);
      if (first) data = first;
    }
  }
  if (!Array.isArray(data)) throw new Error("JSON must be a list of candles");
  const rows = data.map((item) => {
    if (Array.isArray(item)) {
      const names = ["time", "open", "high", "low", "close", "volume"];
      const out: Record<string, string> = {};
      item.forEach((value, i) => {
        out[names[i] || "c" + (i + 1)] = value == null ? "" : String(value);
      });
      return out;
    }
    if (!item || typeof item !== "object") throw new Error("Each candle must be an object or a list");
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(item as Record<string, unknown>)) {
      out[key] = value == null ? "" : String(value);
    }
    return out;
  });
  const columns: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key);
  }
  return { columns, rows };
}

export function tablesToBook(tables: { name: string; columns: string[]; values: unknown[][] }[]): DataBook {
  const book: DataBook = { tables: {} };
  for (const table of tables) {
    book.tables[table.name] = table.values.map((values) => {
      const row: Record<string, string> = {};
      table.columns.forEach((col, i) => {
        const value = values[i];
        row[col] = value == null ? "" : String(value);
      });
      return row;
    });
  }
  return book;
}

export function dataPython(path: string, kind: "csv" | "json", columns: string[], count: number) {
  const cols = columns.join(", ") || "no columns";
  if (kind === "csv") {
    return `# ${path}\n# ${count} rows: ${cols}\nimport csv\nwith open(${JSON.stringify(path)}, newline="", encoding="utf-8") as f:\n    candles = list(csv.DictReader(f))\nprint(len(candles), "rows")\nprint(candles[0] if candles else "empty")\n`;
  }
  return `# ${path}\n# ${count} rows: ${cols}\nimport json\nbook = json.load(open(${JSON.stringify(path)}, encoding="utf-8"))\nif isinstance(book, dict) and "tables" in book:\n    name, candles = next(iter(book["tables"].items()))\n    print(name)\nelse:\n    candles = book.get("candles", book) if isinstance(book, dict) else book\nprint(len(candles), "rows")\nprint(candles[0] if candles else "empty")\n`;
}

export async function readSqlite(bytes: Uint8Array): Promise<DataBook> {
  const initSqlJs = (await import("sql.js")).default;
  const SQL = await initSqlJs({ locateFile: () => new URL("sql-wasm.wasm", document.baseURI).toString() });
  const db = new SQL.Database(bytes);
  try {
    const listed = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
    const names = (listed[0]?.values || []).map((row: unknown[]) => String(row[0]));
    if (!names.length) throw new Error("Database has no tables");
    const tables = names.map((name: string) => {
      const quoted = '"' + name.replace(/"/g, '""') + '"';
      const result = db.exec(`SELECT * FROM ${quoted}`);
      const hit = result[0];
      return { name, columns: hit?.columns || [], values: hit?.values || [] };
    });
    return tablesToBook(tables);
  } finally {
    db.close();
  }
}
