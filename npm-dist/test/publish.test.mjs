import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";

const testDir = dirname(fileURLToPath(import.meta.url));
const sourceScript = join(testDir, "../scripts/publish.mjs");
const packageDirs = [
	"pi-darwin-arm64",
	"pi-darwin-x64",
	"pi-linux-x64",
	"pi-linux-arm64",
	"pi-windows-x64",
	"pi-windows-arm64",
	"pi",
];
const temporaryDirectories = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function createFixture() {
	const root = mkdtempSync(join(tmpdir(), "pi-npm-publish-test-"));
	temporaryDirectories.push(root);
	const scriptsDir = join(root, "scripts");
	const publishDir = join(root, "publish");
	const binDir = join(root, "bin");
	const logPath = join(root, "publish.log");
	mkdirSync(scriptsDir);
	mkdirSync(publishDir);
	mkdirSync(binDir);
	cpSync(sourceScript, join(scriptsDir, "publish.mjs"));

	for (const packageDir of packageDirs) {
		const directory = join(publishDir, packageDir);
		mkdirSync(directory);
		writeFileSync(
			join(directory, "package.json"),
			`${JSON.stringify({ name: `@example/${packageDir}`, version: "1.2.3" })}\n`,
		);
	}

	const fakeNpmPath = join(binDir, "npm");
	writeFileSync(
		fakeNpmPath,
		`#!/usr/bin/env node
const { appendFileSync } = require("node:fs");

const [, , command, ...args] = process.argv;
if (command === "whoami") {
\tconsole.log("test-user");
\tprocess.exit(0);
}
if (command === "view") {
\tif (args[0] === "@example/pi-darwin-arm64@1.2.3") {
\t\tconsole.log(JSON.stringify("1.2.3"));
\t\tprocess.exit(0);
\t}
\tconsole.error("npm error code E404");
\tprocess.exit(1);
}
if (command === "publish") {
\tappendFileSync(process.env.FAKE_NPM_LOG, process.cwd() + "\\n");
\tprocess.exit(0);
}
console.error("Unexpected npm command: " + command);
process.exit(2);
`,
	);
	chmodSync(fakeNpmPath, 0o755);

	return { root, binDir, logPath };
}

test("skips package versions that are already published and resumes the remaining packages", () => {
	const fixture = createFixture();
	const result = spawnSync(process.execPath, [join(fixture.root, "scripts/publish.mjs")], {
		encoding: "utf8",
		env: {
			...process.env,
			FAKE_NPM_LOG: fixture.logPath,
			PATH: `${fixture.binDir}:${process.env.PATH}`,
		},
	});

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /@example\/pi-darwin-arm64@1\.2\.3 is already published; skipping\./);
	const publishedDirectories = readFileSync(fixture.logPath, "utf8").trim().split("\n");
	assert.equal(publishedDirectories.length, packageDirs.length - 1);
	assert.ok(publishedDirectories.every((directory) => !directory.endsWith("/pi-darwin-arm64")));
});
