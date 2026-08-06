# Pi Fork

这是 [earendil-works/pi](https://github.com/earendil-works/pi) 的个人 Fork。

本 README 只记录该 Fork 相对上游 `main` 的修改，以及本 Fork 发布版本的安装方式。Pi 的完整功能、配置、架构、开发和贡献文档请直接查看：

- [官方仓库：earendil-works/pi](https://github.com/earendil-works/pi)
- [官方文档：pi.dev/docs/latest](https://pi.dev/docs/latest)

## Fork 修改

### 1. 更稳健的模型自动重试

- 自动重试默认不限制总次数，也可以通过 `retry.maxRetries` 设置上限。
- 指数退避最长为 10 分钟，可通过 `retry.maxBackoffMs` 调整。
- HTTP 401 或认证失败单独限制为最多重试 5 次，可通过 `retry.maxUnauthorizedRetries` 调整。
- 除 HTTP、服务商和传输错误外，也会重试流中断、空响应，以及只有推理内容但没有文本或工具调用的响应。
- 重试等待仍可由用户中断。

### 2. 独立 npm 包与多平台二进制

本 Fork 发布独立的 npm 包 [`@kingingwang/pi`](https://www.npmjs.com/package/@kingingwang/pi)。主包提供 `pi` 命令，并通过 `optionalDependencies` 只安装当前系统对应的预编译二进制。

支持的平台：

| 系统 | 架构 | 二进制包 |
| --- | --- | --- |
| macOS | Apple Silicon | `@kingingwang/pi-darwin-arm64` |
| macOS | Intel | `@kingingwang/pi-darwin-x64` |
| Linux | x64 | `@kingingwang/pi-linux-x64` |
| Linux | ARM64 | `@kingingwang/pi-linux-arm64` |
| Windows | x64 | `@kingingwang/pi-windows-x64` |
| Windows | ARM64 | `@kingingwang/pi-windows-arm64` |

相关 CI 会：

- 在每次分支推送后构建六个平台的独立二进制。
- 在默认分支更新后发布滚动的 `continuous` GitHub Release。
- 当当前版本尚未发布时，自动将平台包和主包发布到 npm。
- 提供手动 npm 发布工作流，用于失败重试或自定义发布。

### 3. OpenAI 兼容 API 扩展

#### 非流式 Chat Completions

`openai-completions` API 支持 `nonStreaming: true`。启用后会发送单次 `stream: false` 请求，并将完整响应中的文本、推理内容、工具调用和用量信息转换为现有事件流格式；默认行为仍为流式请求。

在全局 `~/.pi/agent/settings.json` 或项目 `.pi/settings.json` 中启用后，interactive、print、JSON 和 RPC 模式都会使用该选项：

```json
{
  "nonStreaming": true
}
```

也可以只对当前 CLI 进程启用：

```bash
pi --non-streaming
```

coding-agent SDK 可通过 `createAgentSession({ nonStreaming: true })` 启用，RPC 的 `prompt` 命令可传入 `"nonStreaming": true`。直接使用 agent 或 pi-ai 时，可分别通过 `new Agent({ nonStreaming: true, ... })` 或 `streamSimple(..., { nonStreaming: true })` 启用。

#### OpenAI Responses 后台任务

OpenAI provider 支持 `streamSimple({ deferred: true })`：

- 使用 `stream: false` 和 `background: true` 提交后台响应。
- 请求未完成时返回可持久化的 deferred handle。
- 使用 `fetchDeferred` 获取任务状态或最终结果。
- 使用 `cancelDeferred` 取消仍在执行的任务。

该后台任务能力当前仅适用于 OpenAI provider。

## 安装

要求 Node.js 18 或更高版本。

如果已经全局安装官方 CLI，请先卸载，避免两个包同时提供 `pi` 命令：

```sh
npm uninstall -g @earendil-works/pi-coding-agent
```

安装本 Fork 发布的 CLI：

```sh
npm install -g @kingingwang/pi
```

验证安装：

```sh
pi --version
pi --help
```

更新到 npm 上的最新版本：

```sh
npm update -g @kingingwang/pi
```
