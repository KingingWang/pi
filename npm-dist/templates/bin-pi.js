#!/usr/bin/env node
"use strict";

const { spawn } = require("node:child_process");
const { createRequire } = require("node:module");
const path = require("node:path");

const MAIN_PACKAGE = "__MAIN_PACKAGE__";
const PLATFORM_PACKAGES = __PLATFORM_MAP__;

const requireFrom = createRequire(__filename);

function resolveBinaryPath() {
	const entry = PLATFORM_PACKAGES[process.platform]?.[process.arch];
	if (!entry) {
		console.error(`pi: unsupported platform "${process.platform}-${process.arch}".`);
		process.exit(1);
	}

	let packageJsonPath;
	try {
		packageJsonPath = requireFrom.resolve(`${entry}/package.json`);
	} catch {
		console.error(`pi: binary package "${entry}" is not installed. Reinstall with: npm install -g ${MAIN_PACKAGE}`);
		process.exit(1);
	}

	const binaryName = process.platform === "win32" ? "pi.exe" : "pi";
	return path.join(path.dirname(packageJsonPath), "bin", binaryName);
}

const binaryPath = resolveBinaryPath();
const child = spawn(binaryPath, process.argv.slice(2), { stdio: "inherit", windowsHide: true });

child.on("error", (error) => {
	console.error(`pi: failed to launch ${binaryPath}: ${error.message}`);
	process.exit(1);
});

child.on("exit", (code, signal) => {
	if (signal) {
		process.kill(process.pid, signal);
		return;
	}
	process.exit(code ?? 1);
});