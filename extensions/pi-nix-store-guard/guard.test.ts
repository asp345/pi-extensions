import assert from "node:assert/strict";
import { test } from "node:test";
import { allowedStorePath, storeBlockReason, storePathBlockReason } from "./guard.ts";

const pkg = "/home/user/pi-config";

test("blocks /nix/store searches except allowed docs", () => {
	assert.equal(storePathBlockReason("/nix/store/abc123-foo", pkg) !== null, true);
	assert.equal(storePathBlockReason(`${pkg}/docs/guide.md`, pkg), null);
	assert.ok(storePathBlockReason(`${pkg}/docs`, pkg) === null);
	assert.ok(storePathBlockReason(`${pkg}/examples/demo`, pkg) === null);
	assert.equal(storePathBlockReason(`${pkg}/README.md`, pkg), null);
	assert.equal(storeBlockReason("grep -r foo /nix/store", pkg) !== null, true);
	assert.equal(storeBlockReason(`cat ${pkg}/docs/readme.md`, pkg), null);
});

test("allowedStorePath restricts to packageDir subtree", () => {
	assert.equal(allowedStorePath(`${pkg}/docs`, pkg), true);
	assert.equal(allowedStorePath(`${pkg}/other`, pkg), false);
	assert.equal(allowedStorePath("/nix/store", undefined), false);
});
