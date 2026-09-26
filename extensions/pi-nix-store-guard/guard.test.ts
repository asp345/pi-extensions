import assert from "node:assert/strict";
import { test } from "node:test";
import { allowedStorePath, storeBlockReason, storePathBlockReason } from "./guard.ts";

const pkg = "/home/user/pi-config";
process.env.PI_PACKAGE_DIR = pkg;

test("blocks /nix/store searches except allowed docs", () => {
	assert.equal(storePathBlockReason("/nix/store/abc123-foo") !== null, true);
	assert.equal(storePathBlockReason(`${pkg}/docs/guide.md`), null);
	assert.ok(storePathBlockReason(`${pkg}/docs`) === null);
	assert.ok(storePathBlockReason(`${pkg}/examples/demo`) === null);
	assert.equal(storePathBlockReason(`${pkg}/README.md`), null);
	assert.equal(storeBlockReason("grep -r foo /nix/store") !== null, true);
	assert.equal(storeBlockReason(`cat ${pkg}/docs/readme.md`), null);
});

test("allowedStorePath restricts to packageDir subtree", () => {
	assert.equal(allowedStorePath(`${pkg}/docs`), true);
	assert.equal(allowedStorePath(`${pkg}/other`), false);
});
