#!/usr/bin/env node
/**
 * Assemble standalone npm distribution packages for the pi CLI.
 *
 * Usage:
 *   node npm-dist/scripts/assemble.mjs [options]
 *
 * Options:
 *   --binaries <dir>   Directory with pi-<platform>.tar.gz/.zip archives
 *                      (default: packages/coding-agent/binaries)
 *   --download [tag]   Download archives from the fork's GitHub release instead
 *                      (default tag: continuous)
 *   --out <dir>        Output directory (default: npm-dist/publish)
 *   --version <ver>    Version override (default: packages/coding-agent version)
 *
 * Environment:
 *   PI_NPM_SCOPE       npm scope for the published packages (default: @kingingwang)
 *   PI_DIST_REPO       fork repository for downloads and metadata (default: KingingWang/pi)
 */

import { spawnSync } from "node:child_process";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const distRoot = resolve(scriptDir, "..");
const repoRoot = resolve(distRoot, "..");
const templatesDir = join(distRoot, "templates");

const scope = process.env.PI_NPM_SCOPE || "@kingingwang";
const distRepo = process.env.PI_DIST_REPO || "KingingWang/pi";

const platforms = [
	{ name: "darwin-arm64", packageName: "pi-darwin-arm64", os: ["darwin"], cpu: ["arm64"], archive: "pi-darwin-arm64.tar.gz", binary: "pi" },
	{ name: "darwin-x64", packageName: "pi-darwin-x64", os: ["darwin"], cpu: ["x64"], archive: "pi-darwin-x64.tar.gz", binary: "pi" },
	{ name: "linux-x64", packageName: "pi-linux-x64", os: ["linux"], cpu: ["x64"], archive: "pi-linux-x64.tar.gz", binary: "pi" },
	{ name: "linux-arm64", packageName: "pi-linux-arm64", os: ["linux"], cpu: ["arm64"], archive: "pi-linux-arm64.tar.gz", binary: "pi" },
	{ name: "windows-x64", packageName: "pi-windows-x64", os: ["win32"], cpu: ["x64"], archive: "pi-windows-x64.zip", binary: "pi.exe" },
	{ name: "windows-arm64", packageName: "pi-windows-arm64", os: ["win32"], cpu: ["arm64"], archive: "pi-windows-arm64.zip", binary: "pi.exe" },
];

function parseArgs() {
	const args = {
		binariesDir: resolve(repoRoot, "packages/coding-agent/binaries"),
		outDir: resolve(distRoot, "publish"),
		downloadTag: undefined,
		version: undefined,
	};
	const argv = process.argv.slice(2);
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--binaries") {
			args.binariesDir = resolve(argv[++i]);
		} else if (arg === "--out") {
			args.outDir = resolve(argv[++i]);
		} else if (arg === "--version") {
			args.version = argv[++i];
		} else if (arg === "--download") {
			const next = argv[i + 1];
			args.downloadTag = next && !next.startsWith("--") ? next : "continuous";
			if (next && !next.startsWith("--")) {
				i++;
			}
		} else {
			console.error(`Unknown option: ${arg}`);
			process.exit(1);
		}
	}
	return args;
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function run(command, args, cwd) {
	const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: "inherit" });
	if (result.status !== 0) {
		throw new Error(`Command failed: ${command} ${args.join(" ")}`);
	}
}

async function downloadArchive(url, destination) {
	console.log(`Downloading ${url}`);
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`Download failed with HTTP ${response.status}: ${url}`);
	}
	writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
}

function replaceTemplate(templatePath, replacements) {
	let content = readFileSync(templatePath, "utf8");
	for (const [key, value] of Object.entries(replacements)) {
		content = content.split(key).join(value);
	}
	return content;
}

function writePackageJson(packageDir, content) {
	const parsed = JSON.parse(content);
	writeFileSync(join(packageDir, "package.json"), `${JSON.stringify(parsed, null, 2)}\n`);
}

function validatePackage(packageDir) {
	const result = spawnSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
		cwd: packageDir,
		encoding: "utf8",
	});
	if (result.status !== 0) {
		console.warn(`  validation skipped (npm unavailable or failed): ${(result.stderr ?? result.stdout ?? "").trim().split("\n")[0]}`);
		return;
	}
	const packed = JSON.parse(result.stdout)[0];
	console.log(`  ${packed.filename}: ${packed.files.length} files, ${packed.size} bytes`);
}

async function main() {
	const args = parseArgs();
	const repoMetadata = {
		homepage: `https://github.com/${distRepo}`,
		repository: JSON.stringify({ type: "git", url: `git+https://github.com/${distRepo}.git` }),
	};
	const version = args.version ?? readJson(join(repoRoot, "packages/coding-agent/package.json")).version;
	const mainPackage = `${scope}/pi`;

	let binariesDir = args.binariesDir;
	let downloadDir;
	if (args.downloadTag !== undefined) {
		downloadDir = mkdtempSync(join(tmpdir(), "pi-dist-download-"));
		binariesDir = downloadDir;
		for (const platform of platforms) {
			const url = `https://github.com/${distRepo}/releases/download/${args.downloadTag}/${platform.archive}`;
			await downloadArchive(url, join(downloadDir, platform.archive));
		}
	}

	for (const platform of platforms) {
		const archivePath = join(binariesDir, platform.archive);
		if (!existsSync(archivePath)) {
			throw new Error(`Missing archive: ${archivePath}. Build binaries first or use --download.`);
		}
	}

	const extractRoot = mkdtempSync(join(tmpdir(), "pi-dist-extract-"));
	try {
		rmSync(args.outDir, { recursive: true, force: true });
		mkdirSync(args.outDir, { recursive: true });

		const platformMap = {};
		const optionalDependencies = {};
		for (const platform of platforms) {
			const packageName = `${scope}/${platform.packageName}`;
			platformMap[platform.os[0]] ??= {};
			platformMap[platform.os[0]][platform.cpu[0]] = packageName;
			optionalDependencies[packageName] = version;

			const extractDir = join(extractRoot, platform.name);
			mkdirSync(extractDir, { recursive: true });
			if (platform.archive.endsWith(".zip")) {
				run("unzip", ["-q", "-o", join(binariesDir, platform.archive), "-d", extractDir]);
			} else {
				run("tar", ["-xf", join(binariesDir, platform.archive), "-C", extractDir]);
			}

			const packageDir = join(args.outDir, platform.packageName);
			const binDir = join(packageDir, "bin");
			mkdirSync(binDir, { recursive: true });

			const root = platform.archive.endsWith(".zip") ? extractDir : join(extractDir, "pi");
			const binarySource = join(root, platform.binary);
			if (!existsSync(binarySource)) {
				throw new Error(`Binary not found in ${platform.archive}: ${binarySource}`);
			}
			// The standalone binary resolves package.json, theme/, export-html/,
			// native/ and docs relative to the executable directory, so ship the
			// whole archive contents next to it.
			run("cp", ["-a", `${root}/.`, `${binDir}/`]);
			chmodSync(join(binDir, platform.binary), 0o755);

			const content = replaceTemplate(join(templatesDir, "platform-package.json"), {
				"__PACKAGE__": packageName,
				"__VERSION__": version,
				"__PLATFORM__": platform.name,
				"__OS__": JSON.stringify(platform.os),
				"__CPU__": JSON.stringify(platform.cpu),
				"__HOMEPAGE__": repoMetadata.homepage,
				"__REPOSITORY__": repoMetadata.repository,
			});
			writePackageJson(packageDir, content);
			cpSync(join(repoRoot, "LICENSE"), join(packageDir, "LICENSE"));
		}

		const mainDir = join(args.outDir, "pi");
		const mainBinDir = join(mainDir, "bin");
		mkdirSync(mainBinDir, { recursive: true });

		const wrapper = replaceTemplate(join(templatesDir, "bin-pi.js"), {
			"__MAIN_PACKAGE__": mainPackage,
			"__PLATFORM_MAP__": JSON.stringify(platformMap, null, "\t"),
		});
		writeFileSync(join(mainBinDir, "pi.js"), wrapper);
		chmodSync(join(mainBinDir, "pi.js"), 0o755);

		writePackageJson(
			mainDir,
			replaceTemplate(join(templatesDir, "main-package.json"), {
				"__MAIN_PACKAGE__": mainPackage,
				"__VERSION__": version,
				"__OPTIONAL_DEPENDENCIES__": JSON.stringify(optionalDependencies, null, 2),
				"__HOMEPAGE__": repoMetadata.homepage,
				"__REPOSITORY__": repoMetadata.repository,
			}),
		);

		const readme = replaceTemplate(join(templatesDir, "README.md"), {
			"__PACKAGE__": mainPackage,
			"__REPO__": distRepo,
		});
		writeFileSync(join(mainDir, "README.md"), readme);
		cpSync(join(repoRoot, "LICENSE"), join(mainDir, "LICENSE"));

		for (const platform of platforms) {
			const packageDir = join(args.outDir, platform.packageName);
			console.log(`Validating ${scope}/${platform.packageName}@${version}`);
			validatePackage(packageDir);
		}
		console.log(`Validating ${mainPackage}@${version}`);
		validatePackage(mainDir);
	} finally {
		rmSync(extractRoot, { recursive: true, force: true });
		if (downloadDir) {
			rmSync(downloadDir, { recursive: true, force: true });
		}
	}

	console.log(`\nAssembled ${mainPackage}@${version} in ${args.outDir}`);
}

main().catch((error) => {
	console.error(error.message);
	process.exit(1);
});