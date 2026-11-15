import assert from "node:assert/strict";
import test from "node:test";
import { checkDevicePath, dataPython, parseCsv, parseJsonTable, tablesToBook } from "./candles.ts";

test("csv candles keep quoted commas", () => {
  const table = parseCsv('time,open,high,low,close,volume\n2024-01-01,1.0,2.0,0.5,1.5,10\n"2024-01-02","1,1",2,1,1.2,3\n');
  assert.deepEqual(table.columns, ["time", "open", "high", "low", "close", "volume"]);
  assert.equal(table.rows.length, 2);
  assert.equal(table.rows[1].open, "1,1");
});

test("tab and json candle files", () => {
  const csv = parseCsv("time\topen\thigh\n2024-01-01\t1\t2\n");
  assert.equal(csv.rows[0].high, "2");
  const json = parseJsonTable('{"candles":[{"time":"2024-01-01","close":1.2}]}');
  assert.equal(json.rows[0].close, "1.2");
  const list = parseJsonTable('[[1700000000,1,2,0.5,1.5,9]]');
  assert.equal(list.rows[0].close, "1.5");
});

test("phone candle paths stay under storage", () => {
  assert.equal(checkDevicePath("/storage/emulated/0/backups/mini_database/btc_4h.csv"), "/storage/emulated/0/backups/mini_database/btc_4h.csv");
  assert.throws(() => checkDevicePath("/etc/passwd"));
  assert.throws(() => checkDevicePath("/storage/emulated/0/../secret"));
});

test("sqlite tables become a book the python cell can open", () => {
  const book = tablesToBook([{ name: "candles", columns: ["close"], values: [[1.5], [null]] }]);
  assert.equal(book.tables.candles[1].close, "");
  const code = dataPython("Notebooks/data/eurusd.json", "json", ["close"], 2);
  assert.match(code, /Notebooks\/data\/eurusd\.json/);
  assert.match(code, /candles/);
});
