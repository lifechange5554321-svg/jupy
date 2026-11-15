import assert from "node:assert/strict";
import test from "node:test";
import { ROOT, baseName, joinPath, normalizePath, parentPath } from "./files.ts";

test("paths stay inside Notebooks", () => {
  assert.equal(normalizePath(""), ROOT);
  assert.equal(normalizePath("../secret"), "Notebooks/secret");
  assert.equal(normalizePath("Notebooks/../../etc"), "Notebooks/etc");
  assert.equal(normalizePath("Notebooks/../Notebooks/work"), "Notebooks/work");
  assert.equal(normalizePath("a/b"), "Notebooks/a/b");
});

test("join and parent keep the folder", () => {
  assert.equal(joinPath("Notebooks/work", "note.ipynb"), "Notebooks/work/note.ipynb");
  assert.equal(joinPath("Notebooks", ".."), ROOT);
  assert.equal(parentPath("Notebooks/work/note.ipynb"), "Notebooks/work");
  assert.equal(parentPath(ROOT), ROOT);
  assert.equal(baseName("Notebooks/work/note.ipynb"), "note.ipynb");
});

test("illegal characters are stripped from a name", () => {
  assert.equal(joinPath(ROOT, 'bad:name?.ipynb'), "Notebooks/bad_name_.ipynb");
});
