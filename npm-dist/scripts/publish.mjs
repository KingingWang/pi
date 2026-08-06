#!/usr/bin/env node
/**
 * Publish the assembled npm distribution packages.
 *
 * Usage:
 *   node npm-dist/scripts/publish.mjs [--dry-run]
 *
 * Publishes the platform packages first, then the main package, so the main
 * package's optionalDependencies always resolve on the registry.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const publishDir = resolve(scriptDir, "../publish");

const packageOrder = [
	"pi-darwin-arm64",
	"pi-darwin-x64",
	"pi-linux-x64",
	"pi-linux-arm64",
	"pi-windows-x64",
	"pi-windows-arm64",
	"pi",
];

const dryRun = process.argv.includes("--dry-run");

if (!existsSync(publishDir)) {
	console.error(`No assembled packages found at ${publishDir}. Run assemble.mjs first.`);
	process.exit(1);
}

if (!dryRun) {
	const whoami = spawnSync("npm", ["whoami"], { encoding: "utf8" });
	if (whoami.status !== 0) {
		console.error("Not authenticated with npm. Run `npm login` or set NODE_AUTH_TOKEN.");
		process.exit(1);
	}
	console.log(`Publishing as ${whoami.stdout.trim()}`);
}

for (const packageName of packageOrder) {
	const packageDir = join(publishDir, packageName);
	const { name, version } = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
	console.log(`${dryRun ? "[dry-run] " : ""}Publishing ${name}@${version}...`);
	const args = ["publish", "--access", "public", "--ignore-scripts"];
	if (dryRun) args.push("--dry-run");
	const result = spawnSync("npm", args, { cwd: packageDir, stdio: "inherit", encoding: "utf8" });
	if (result.status !== 0) {
		process.exit(result.status ?? 1);
	}
}

console.log(dryRun ? "Dry run complete." : "Publish complete.");