import test from "node:test";
import assert from "node:assert/strict";

import { splitRawArgumentString } from "../plugins/dsh/scripts/lib/args.mjs";

test("text after an unquoted -- comes back verbatim and is not split", () => {
  assert.deepEqual(splitRawArgumentString(`--model pro -- it's a "quoted" C:\\path`), {
    tokens: ["--model", "pro"],
    verbatim: `it's a "quoted" C:\\path`
  });
});

test("verbatim keeps command substitutions and a second --", () => {
  const { tokens, verbatim } = splitRawArgumentString("-- run $(x) and `y` a -- b");
  assert.deepEqual(tokens, []);
  assert.equal(verbatim, "run $(x) and `y` a -- b");
});

test("only the single separating whitespace is dropped from the verbatim text", () => {
  assert.equal(splitRawArgumentString("--write --  two  spaces").verbatim, " two  spaces");
  assert.equal(splitRawArgumentString("--").verbatim, "");
});

test("a quoted -- and a -- inside a word are ordinary text", () => {
  assert.deepEqual(splitRawArgumentString(`"--" rest`), { tokens: ["--", "rest"], verbatim: null });
  assert.deepEqual(splitRawArgumentString("a--b c"), { tokens: ["a--b", "c"], verbatim: null });
  assert.deepEqual(splitRawArgumentString("x --y"), { tokens: ["x", "--y"], verbatim: null });
});

test("without -- the splitting is unchanged", () => {
  assert.deepEqual(splitRawArgumentString(`--model pro add "a flag" now`), {
    tokens: ["--model", "pro", "add", "a flag", "now"],
    verbatim: null
  });
  assert.deepEqual(splitRawArgumentString("a\\ b c\\"), { tokens: ["a b", "c\\"], verbatim: null });
});
