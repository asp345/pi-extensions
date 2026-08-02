import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { homedir } from "node:os";
import { test } from "node:test";
import type { GuardConfig } from "./config.ts";

registerHooks({
	resolve(specifier, context, nextResolve) {
		if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js")) {
			try {
				return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
			} catch {
				return nextResolve(specifier, context);
			}
		}
		return nextResolve(specifier, context);
	},
});

const { expandShellWord, inspectShell } = await import("./index.ts");

const config: GuardConfig = {
	enabled: true,
	protectedPaths: [],
	allowedPaths: [".env.example", "*.pub"],
	readRedaction: { enabled: false, includeShellOutput: false, scope: "protectedOnly", maxBytes: 262_144 },
	contentScanning: { enabled: true, blockSeverity: "high" },
	gitProtection: { enabled: true, blockCommit: true, blockPush: true },
};

const inspect = (command: string) => inspectShell(command, process.cwd(), config);

test("expands home and environment variables", () => {
	assert.equal(expandShellWord("~/.npmrc"), `${homedir()}/.npmrc`);
	assert.equal(expandShellWord("$HOME/.npmrc"), `${homedir()}/.npmrc`);
	assert.equal(expandShellWord("${HOME}/.npmrc"), `${homedir()}/.npmrc`);
	assert.equal(expandShellWord("${HOME:-/tmp}/.npmrc"), null);
	assert.equal(expandShellWord("$(printf ~/.npmrc)"), null);
});

test("detects expanded protected reads and redirects", () => {
	assert.equal(inspect('cat "$HOME/.npmrc"').protectedRead, true);
	assert.equal(inspect("cat ~/.npmrc").protectedRead, true);
	assert.equal(inspect('echo value > "$HOME/.npmrc"').blocked, true);
	assert.equal(inspect("cat ${HOME:-/tmp}/.npmrc").protectedRead, true);
});

test("blocks unlisted interpreters that reference protected paths", () => {
	assert.equal(inspect(`python -c 'open("${homedir()}/.npmrc").read()'`).blocked, true);
	assert.equal(inspect(`node -e 'writeFileSync("${homedir()}/.npmrc", "x")'`).blocked, true);
	assert.equal(inspect("node -e 'open(\"${HOME:-/tmp}/.npmrc\")'").blocked, true);
	assert.equal(inspect(`python -c 'open("."+"env","w").write("x")'`).blocked, true);
	assert.equal(inspect(`node -e 'writeFileSync(".".concat("npmrc"), "x")'`).blocked, true);
	assert.equal(inspect(`python -c 'open("/tmp/ordinary","w").write("x")'`).blocked, false);
});

test("protects git reads and writes that name sensitive paths", () => {
	assert.equal(inspect("git show HEAD:.env").protectedRead, true);
	assert.equal(inspect("git cat-file blob HEAD:.npmrc").protectedRead, true);
	assert.equal(inspect("git checkout -- .env").blocked, true);
	assert.equal(inspect("git restore .env").blocked, true);
	assert.equal(inspect("git clean -fdx").blocked, true);
});

test("allows unrelated shell commands", () => {
	assert.deepEqual(inspect("npm run build"), { blocked: false, protectedRead: false });
	assert.deepEqual(inspect("node -e 'console.log(42)'"), { blocked: false, protectedRead: false });
	assert.deepEqual(inspect("curl https://example.com/auth"), { blocked: false, protectedRead: false });
});
