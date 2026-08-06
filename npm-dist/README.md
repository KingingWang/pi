# npm distribution packages

Standalone npm packages for the pi CLI. The monorepo publishes the `@earendil-works/*`
packages upstream, so this fork ships its own distribution instead:

- `@kingingwang/pi` -- main package with the `pi` bin wrapper
- `@kingingwang/pi-<platform>` -- one package per platform with the standalone binary

The main package depends on the platform packages through `optionalDependencies`, so
npm only downloads the binary matching the install machine.

## Prerequisites

- An npm account that owns the scope used for publishing. The scripts default to
  `@kingingwang`; override with `PI_NPM_SCOPE` if your account has a different name.
  The scope must exist on npmjs.org before publishing (register the username or create
  an organization with that name).
- npm authentication: `npm login` locally, or a `NODE_AUTH_TOKEN` secret in CI.

## Assemble

The scripts build the publish tree from the standalone binary archives produced by
`scripts/build-binaries.sh` (see the Continuous Binaries workflow / `continuous`
GitHub release on the fork).

```sh
# From the fork's latest release assets:
node npm-dist/scripts/assemble.mjs --download continuous

# Or from a local binaries directory:
./scripts/build-binaries.sh --offline-model-data --out /tmp/pi-binaries
node npm-dist/scripts/assemble.mjs --binaries /tmp/pi-binaries

# Custom scope / repo:
PI_NPM_SCOPE=@myorg node npm-dist/scripts/assemble.mjs --download
PI_DIST_REPO=myorg/pi node npm-dist/scripts/assemble.mjs --download
```

Output goes to `npm-dist/publish/` (gitignored). Each package is validated with
`npm pack --dry-run` during assembly.

The package version follows `packages/coding-agent/package.json`, so it stays in lockstep
with the fork's code and its `continuous` binaries.

## Publish

```sh
# Check what would be published:
node npm-dist/scripts/publish.mjs --dry-run

# Publish platform packages first, then the main package:
node npm-dist/scripts/publish.mjs
```

## Install and update

```sh
# Remove the upstream CLI first if it is installed (same `pi` bin name):
npm uninstall -g @earendil-works/pi-coding-agent

npm install -g @kingingwang/pi
pi --version

# Pull a newer published version:
npm update -g @kingingwang/pi
```

## CI publishing

The Continuous Binaries workflow includes a `publish-npm-dist` job that runs
after a successful build on `main`. It downloads the binaries built by that same
run and publishes them to npm, but only when the package version differs from the
version already published (checked against the main package on the registry). A
manual `Publish npm dist package` workflow (`workflow_dispatch`) is also available
for retries or custom runs.

Configure these repository settings first:

- Secret `NPM_TOKEN`: an npm access token with publish rights for the scope.
- Variable `PI_NPM_SCOPE`: the npm scope (defaults to `@kingingwang`).
- Variable `PI_DIST_REPO`: the fork repository (defaults to `KingingWang/pi`).
