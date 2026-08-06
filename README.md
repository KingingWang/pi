<p align="center">
  <a href="https://pi.dev">
    <img alt="pi logo" src="https://pi.dev/logo-auto.svg" width="128">
  </a>
</p>
<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
</p>

# Pi Agent Harness (Fork)

This is a fork of [earendil-works/pi](https://github.com/earendil-works/pi) with standalone npm distribution packages, non-streaming chat completions, background responses, and resilient retry improvements.

## What's different from upstream

This fork adds the following changes on top of [earendil-works/pi](https://github.com/earendil-works/pi):

### Standalone npm distribution packages

The upstream project publishes monorepo packages (`@earendil-works/pi-*`). This fork ships standalone npm packages that bundle per-platform prebuilt binaries, making installation as simple as `npm install -g @kingingwang/pi` without requiring a local build.

- **`@kingingwang/pi`** — main package with the `pi` bin wrapper
- **`@kingingwang/pi-darwin-arm64`** — macOS Apple Silicon binary
- **`@kingingwang/pi-darwin-x64`** — macOS Intel binary
- **`@kingingwang/pi-linux-x64`** — Linux x64 binary
- **`@kingingwang/pi-linux-arm64`** — Linux ARM64 binary
- **`@kingingwang/pi-windows-x64`** — Windows x64 binary
- **`@kingingwang/pi-windows-arm64`** — Windows ARM64 binary

The main package uses `optionalDependencies` to pull in only the binary for the current platform.

### Non-streaming chat completions

Added a `nonStreaming` option to the OpenAI Completions API (`OpenAICompletionsOptions` and `SimpleStreamOptions`). When set to `true`, the API issues a single non-streaming request and internally converts the result back to a chunk stream. This is useful for providers or scenarios where streaming is unavailable or undesired.

### Background / deferred responses (OpenAI Responses API)

Added support for the OpenAI Responses API `background` mode. When `background: true` is passed in the stream options, the API issues a non-streaming request and returns a deferred handle. The response can be polled or awaited later. This works with the `deferred` option on `SimpleStreamOptions`.

### Resilient model retries

Improved the retry logic in `AgentSession`:

- Renamed `isRetryableAssistantError` to `isRetryableAssistantResponse` for broader coverage
- Added `isUnauthorizedAssistantError` helper to distinguish auth failures from recoverable errors
- Added `getAssistantRetryErrorMessage` for consistent error messages
- Made `maxAttempts` nullable in retry events, enabling unbounded retries when configured
- Added `_unauthorizedRetryAttempt` tracking and `_hasRetryBudget` checks
- Reset retry state via `_resetRetryState()` instead of directly zeroing the counter

### Removed `qwen-token-plan-individual` provider

The `qwen-token-plan-individual` provider was removed from this fork. The `qwen-token-plan` and `qwen-token-plan-cn` providers remain available.

### Harness and agent fixes

- Simplified blocked tool result handling in `agent-loop.ts`
- Removed the active-run guard on `Agent.reset()` in `agent.ts`
- Expanded `ExecutionContext` and `ExecutionSpan` interfaces in `agent-harness.ts`
- Fixed unused import and path handling in `nodejs.ts` environment

### CI/CD

- **Continuous Binaries** workflow: builds standalone binaries on every push to any branch, publishes a rolling `continuous` GitHub release on the default branch
- **Publish npm dist** workflow: auto-publishes the npm packages after a successful continuous build, with a manual `workflow_dispatch` trigger for retries

---

## Install

```sh
# Install the standalone CLI
npm install -g @kingingwang/pi

# Verify
pi --version
pi --help
```

If you previously installed the upstream CLI, uninstall it first to avoid conflicts:

```sh
npm uninstall -g @earendil-works/pi-coding-agent
```

## Update

```sh
npm update -g @kingingwang/pi
```

## Usage

```sh
pi --help
pi --version
pi -p "your prompt"
```

---

## Upstream project

For the full project documentation, feature list, architecture details, and contribution guidelines, please refer to the original repository:

- **Repository**: [earendil-works/pi](https://github.com/earendil-works/pi)
- **Website**: [pi.dev](https://pi.dev)
- **Documentation**: [pi.dev/docs](https://pi.dev/docs/latest)

Upstream packages and detailed documentation are maintained at the original repository. This fork only adds the standalone npm distribution and the modifications listed above.

## License

MIT
