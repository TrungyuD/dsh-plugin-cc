import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { SUPPORTED_RANGE } from "../plugins/dsh/scripts/lib/dsh.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), "utf8"));
}

function readText(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

const packageVersion = readJson("package.json").version;

test("every manifest carries the package version", () => {
  const marketplace = readJson(".claude-plugin/marketplace.json");
  assert.equal(readJson("plugins/dsh/.claude-plugin/plugin.json").version, packageVersion);
  assert.equal(marketplace.metadata.version, packageVersion);
  assert.equal(marketplace.plugins.find((plugin) => plugin.name === "dsh").version, packageVersion);
});

test("the changelog has a section for the current version", () => {
  const headings = readText("plugins/dsh/CHANGELOG.md").match(/^## .+$/gm) ?? [];
  assert.equal(headings[0], `## ${packageVersion}`);
});

test("the compatibility doc states the supported dsh range", () => {
  assert.ok(readText("docs/dsh-compat.md").includes(`\`${SUPPORTED_RANGE}\``));
});
