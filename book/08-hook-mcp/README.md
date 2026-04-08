# Hook 系统与 MCP——让 Agent 可扩展

你不可能预见所有需求。

用户 A 想每次编辑文件后自动跑 ESLint。用户 B 想把 Agent 的操作日志发到 Slack。用户 C 想让 Agent 能查公司内部的数据库。用户 D 想接入自家的代码搜索服务。

你不可能把这些都硬编码进去。今天加个 ESLint，明天加个 Prettier，后天还要加个 Slack 通知——这条路走不通，Agent 会变成一个什么都做、什么都做不好的臃肿怪物。

正确的做法是提供**扩展机制**，让用户自己接入需要的功能。这章搞两套：

- **Hook 系统**：在 Agent 的关键节点插入用户自定义的逻辑（编辑后跑 lint、结束时发通知）
- **MCP（Model Context Protocol）**：一个标准协议，让任何人都能给 Agent 写新工具（查数据库、搜文档、调内部 API）

Hook 管的是"Agent 做事的时候顺便做点别的"，MCP 管的是"给 Agent 新的能力"。一个是切面，一个是插件。

---

## 上半章：Hook 系统

### 8.1 Hook 的设计思路

Hook 的概念很简单：在 Agent 执行流程的关键点，允许用户挂载自己的处理逻辑。

Git 有 pre-commit hook，Webpack 有 plugin hook，CI/CD 有 pipeline hook——思路都一样。Agent 的 hook 也不例外：在工具调用前后、会话开始和结束时，触发用户注册的 handler。

定义 4 种事件：

| 事件 | 触发时机 | 典型用途 |
|------|---------|---------|
| `PreToolUse` | 工具执行前 | 拦截危险操作、修改参数 |
| `PostToolUse` | 工具执行后 | 自动 lint、记录日志 |
| `SessionStart` | 会话开始 | 初始化环境、加载配置 |
| `Stop` | Agent 停止响应 | 发通知、写摘要 |

其中 `PreToolUse` 最强大——它可以**拦截**工具调用（返回 `blocked: true`），也可以**修改参数**（返回 `modifiedParams`）。相当于一个请求级的中间件。

Handler 支持两种类型：

- **command**：执行 shell 命令，把 Hook 上下文以 JSON 格式写入 stdin
- **http**：POST JSON 到一个 URL

为什么只要这两种？因为这两种覆盖了绝大多数场景。command 能跑任何本地脚本，http 能对接任何远程服务。想发 Slack？curl 一个 webhook。想跑 Python 脚本？command 里写 `python3 my_hook.py`。

### 8.2 类型定义

先把类型写清楚：

```typescript
// src/hooks/types.ts

/** Hook 事件类型 */
export type HookEvent =
  | "PreToolUse"
  | "PostToolUse"
  | "SessionStart"
  | "Stop";

/** 工具调用的上下文，传给 Hook handler */
export interface ToolCallContext {
  tool: string;
  params: Record<string, unknown>;
  result?: unknown; // PostToolUse 时才有
}

/** Hook 触发时传给 handler 的完整上下文 */
export interface HookContext {
  event: HookEvent;
  sessionId: string;
  timestamp: number;
  toolCall?: ToolCallContext;
}

/** Handler 执行结果 */
export interface HookResult {
  ok: boolean;
  output?: string;
  error?: string;
  /** PreToolUse：handler 可以修改工具参数 */
  modifiedParams?: Record<string, unknown>;
  /** PreToolUse：handler 可以拦截工具执行 */
  blocked?: boolean;
  blockReason?: string;
}
```

`HookContext` 是传给 handler 的完整上下文——事件类型、会话 ID、时间戳，以及工具调用的详情（如果是 `PreToolUse` / `PostToolUse` 的话）。

`HookResult` 是 handler 执行后的返回。关键是 `modifiedParams` 和 `blocked` 两个字段，它们让 `PreToolUse` 有了拦截和修改的能力。

Handler 的类型定义：

```typescript
/** command handler：执行 shell 命令 */
export interface CommandHandler {
  type: "command";
  command: string;
  timeout?: number; // 毫秒，默认 10000
}

/** http handler：POST JSON 到 URL */
export interface HttpHandler {
  type: "http";
  url: string;
  headers?: Record<string, string>;
  timeout?: number; // 毫秒，默认 5000
}

export type HookHandler = CommandHandler | HttpHandler;

/** 单条 Hook 规则 */
export interface HookRule {
  event: HookEvent;
  /** 正则匹配工具名（仅对 PreToolUse / PostToolUse 有效） */
  matcher?: string;
  handler: HookHandler;
  /** 是否异步执行（不阻塞 Agent），默认 false */
  async?: boolean;
}
```

`matcher` 用正则匹配工具名。比如 `"edit_file"` 只匹配编辑文件，`".*"` 匹配所有工具。没有 `matcher` 就匹配该事件的所有触发。

`async` 字段控制是否阻塞。发 Slack 通知不需要等结果，设成 `true` 就是 fire-and-forget。但 PreToolUse 的拦截逻辑必须是同步的——你总不能"先执行了再说要不要拦截"。

### 8.3 HookEngine 实现

HookEngine 是核心——注册规则、匹配事件、执行 handler：

```typescript
// src/hooks/engine.ts

import { spawn } from "node:child_process";
import type {
  HookEvent, HookContext, HookResult,
  HookRule, HooksConfig, CommandHandler, HttpHandler,
} from "./types.js";

export class HookEngine {
  private rules: HookRule[] = [];

  load(config: HooksConfig): void {
    this.rules = config.hooks;
    console.log(`[hooks] Loaded ${this.rules.length} hook(s)`);
  }

  register(rule: HookRule): void {
    this.rules.push(rule);
  }

  async trigger(ctx: HookContext): Promise<HookResult[]> {
    const matched = this.match(ctx);
    if (matched.length === 0) return [];

    const results: HookResult[] = [];

    for (const rule of matched) {
      if (rule.async) {
        // fire-and-forget
        this.execute(rule, ctx).catch((err) =>
          console.error(`[hooks] Async handler error:`, err.message)
        );
        results.push({ ok: true, output: "(async, no wait)" });
      } else {
        const result = await this.execute(rule, ctx);
        results.push(result);
        // PreToolUse 时，如果被拦截就不再执行后续 handler
        if (ctx.event === "PreToolUse" && result.blocked) {
          break;
        }
      }
    }

    return results;
  }

  private match(ctx: HookContext): HookRule[] {
    return this.rules.filter((rule) => {
      if (rule.event !== ctx.event) return false;
      if (rule.matcher && ctx.toolCall) {
        return new RegExp(rule.matcher).test(ctx.toolCall.tool);
      }
      return true;
    });
  }

  private async execute(rule: HookRule, ctx: HookContext): Promise<HookResult> {
    try {
      switch (rule.handler.type) {
        case "command":
          return await this.executeCommand(rule.handler, ctx);
        case "http":
          return await this.executeHttp(rule.handler, ctx);
        default:
          return { ok: false, error: "Unknown handler type" };
      }
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  // ...
}
```

`trigger` 方法的逻辑：

1. 用 `match` 找到所有匹配的规则
2. 逐个执行 handler
3. 异步 handler 直接 fire-and-forget
4. 同步 handler 等结果，如果 `blocked` 就提前退出

注意 `match` 方法里的正则匹配——`rule.matcher` 是个正则字符串，用 `new RegExp` 构造后匹配工具名。

### 8.4 Command Handler

command handler 最有意思。它把 `HookContext` 以 JSON 格式写入子进程的 stdin，handler 脚本从 stdin 读取上下文，做处理，然后把结果写到 stdout：

```typescript
private executeCommand(
  handler: CommandHandler,
  ctx: HookContext
): Promise<HookResult> {
  return new Promise((resolve) => {
    const timeout = handler.timeout ?? 10_000;
    const child = spawn("sh", ["-c", handler.command], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    // 把上下文 JSON 写入 stdin
    child.stdin.write(JSON.stringify(ctx));
    child.stdin.end();

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ ok: false, error: `Timed out after ${timeout}ms` });
    }, timeout);

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        const result: HookResult = { ok: true, output: stdout.trim() };
        try {
          const parsed = JSON.parse(stdout);
          if (parsed.modifiedParams) result.modifiedParams = parsed.modifiedParams;
          if (parsed.blocked) {
            result.blocked = true;
            result.blockReason = parsed.blockReason ?? "Blocked by hook";
          }
        } catch {
          // stdout 不是 JSON，没关系
        }
        resolve(result);
      } else {
        resolve({ ok: false, error: stderr.trim() || `Exit code ${code}` });
      }
    });
  });
}
```

关键设计决策：

- **stdin 传入上下文**：handler 脚本可以用任何语言写——Node、Python、bash 都行，只要能读 stdin 就行
- **stdout 返回结果**：如果 stdout 是合法 JSON 且包含 `modifiedParams` 或 `blocked`，就提取出来。不是 JSON 也没关系，当作普通输出
- **超时兜底**：handler 挂了不能拖死 Agent

### 8.5 HTTP Handler

HTTP handler 更简单——POST JSON 到 URL：

```typescript
private async executeHttp(
  handler: HttpHandler,
  ctx: HookContext
): Promise<HookResult> {
  const timeout = handler.timeout ?? 5_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const resp = await fetch(handler.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...handler.headers },
      body: JSON.stringify(ctx),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const body = await resp.text();
    return resp.ok
      ? { ok: true, output: body }
      : { ok: false, error: `HTTP ${resp.status}: ${body}` };
  } catch (err: any) {
    clearTimeout(timer);
    return { ok: false, error: err.message };
  }
}
```

用 `AbortController` 做超时控制。Node.js 18+ 原生支持 `fetch`，不需要额外依赖。

### 8.6 配置加载

Hook 规则写在 `.ling/hooks.json` 里：

```json
{
  "hooks": [
    {
      "event": "PostToolUse",
      "matcher": "edit_file",
      "handler": {
        "type": "command",
        "command": "npx eslint --fix $(cat | jq -r '.toolCall.params.file_path')"
      }
    },
    {
      "event": "Stop",
      "handler": {
        "type": "http",
        "url": "https://hooks.slack.com/services/xxx/yyy/zzz"
      },
      "async": true
    }
  ]
}
```

加载逻辑很直白——读文件、解析 JSON、校验结构：

```typescript
// src/hooks/config.ts

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { HooksConfig, HookRule } from "./types.js";

export async function loadHooksConfig(
  projectRoot: string
): Promise<HooksConfig> {
  const configPath = join(projectRoot, ".ling", "hooks.json");

  try {
    const raw = await readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    return validateConfig(parsed);
  } catch (err: any) {
    if (err.code === "ENOENT") {
      return { hooks: [] }; // 没有配置文件就用空配置
    }
    console.error(`[hooks] Failed to load ${configPath}:`, err.message);
    return { hooks: [] };
  }
}
```

配置文件不存在不报错，返回空配置。这是"零配置可用"的原则——不配 hook，Agent 照常工作。

### 8.7 实战案例

**案例 1：自动 lint**

每次 `edit_file` 后自动跑 `eslint --fix`。配置：

```json
{
  "hooks": [
    {
      "event": "PostToolUse",
      "matcher": "edit_file",
      "handler": {
        "type": "command",
        "command": "npx eslint --fix $(cat | jq -r '.toolCall.params.file_path')"
      }
    }
  ]
}
```

`cat | jq -r '.toolCall.params.file_path'` 从 stdin 读 JSON 上下文，提取被编辑的文件路径，传给 `eslint --fix`。Agent 每次编辑完文件，lint 自动跑一遍，格式问题当场修复。

**案例 2：Slack 通知**

Agent 完成任务后发 Slack 消息。配置：

```json
{
  "hooks": [
    {
      "event": "Stop",
      "handler": {
        "type": "http",
        "url": "https://hooks.slack.com/services/T00/B00/xxxx",
        "headers": { "Content-Type": "application/json" }
      },
      "async": true
    }
  ]
}
```

`async: true` 因为发通知不需要等结果，别拖慢 Agent 的响应。Slack Incoming Webhook 直接接受 JSON POST，会把收到的内容显示在频道里。

**案例 3：PreToolUse 拦截**

假设你想禁止 Agent 在 `node_modules` 目录下写文件。写个 shell 脚本 `block-node-modules.sh`：

```bash
#!/bin/bash
# 从 stdin 读 JSON，检查文件路径是否在 node_modules 下
INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.toolCall.params.file_path // empty')

if [[ "$FILE_PATH" == *node_modules* ]]; then
  echo '{"blocked": true, "blockReason": "Cannot write to node_modules"}'
else
  echo '{"blocked": false}'
fi
```

配置：

```json
{
  "event": "PreToolUse",
  "matcher": "edit_file|write_file",
  "handler": {
    "type": "command",
    "command": "bash .ling/hooks/block-node-modules.sh"
  }
}
```

`matcher` 用正则 `"edit_file|write_file"` 同时匹配两个工具。脚本返回 `blocked: true` 时，`HookEngine` 会阻止工具调用并把 `blockReason` 反馈给 LLM。

---

## 下半章：MCP（Model Context Protocol）

### 8.8 MCP 是什么

Hook 解决的是"在 Agent 已有动作上加逻辑"的问题。但如果你想给 Agent **全新的能力**呢？比如查数据库、搜 Jira、调公司内部 API——这些不是 Hook 能搞定的，你需要给 Agent 加新工具。

最粗暴的做法：直接在代码里加一个工具函数。但这意味着每加一个工具都要改 Agent 代码、重新部署。用户想接自己的服务？不好意思，先提 PR。

MCP（Model Context Protocol）的思路是：**定义一个标准协议，让工具以独立进程运行，Agent 通过协议和它通信**。就像 USB——你不需要知道 U 盘的内部实现，插上就能用。

MCP 的架构很简单：

```
Agent (MCP Client) ←→ stdio/HTTP ←→ MCP Server (工具提供者)
```

Agent 是 Client，工具提供者是 Server。它们之间用 JSON-RPC 2.0 通信。最常见的传输方式是 stdio——Agent 把 MCP Server 当子进程启动，通过 stdin/stdout 交换 JSON 消息。

### 8.9 协议核心

别被"协议"这个词吓到。MCP 的核心就四步：

**第一步：握手。** Client 发 `initialize`，告诉 Server 自己支持的协议版本和能力。Server 回复自己的版本和能力。然后 Client 发一个 `notifications/initialized` 通知，握手完成。

```
Client → Server: {"method": "initialize", "params": {"protocolVersion": "2024-11-05", ...}}
Server → Client: {"result": {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}}, ...}}
Client → Server: {"method": "notifications/initialized"}
```

**第二步：发现工具。** Client 发 `tools/list`，Server 返回它提供的所有工具列表，包括名称、描述、参数 schema。

```
Client → Server: {"method": "tools/list"}
Server → Client: {"result": {"tools": [{"name": "query", "description": "...", "inputSchema": {...}}]}}
```

**第三步：调用工具。** LLM 决定要用某个工具时，Client 发 `tools/call`，Server 执行并返回结果。

```
Client → Server: {"method": "tools/call", "params": {"name": "query", "arguments": {"sql": "SELECT ..."}}}
Server → Client: {"result": {"content": [{"type": "text", "text": "[{...}]"}]}}
```

**第四步：收工。** 用完了就关掉子进程，或者保持连接等下次用。

所有消息都是 JSON-RPC 2.0 格式——有 `jsonrpc: "2.0"`、有 `id`（请求）或没有 `id`（通知）、有 `method`、有 `params`/`result`。就是普通的 RPC，没什么魔法。

### 8.10 MCP Server 的三种能力

一个 MCP Server 可以提供三种东西：

- **Tools**：可执行的操作（查数据库、发邮件、搜索）
- **Resources**：可读取的数据源（文件、API 返回的数据）
- **Prompts**：预定义的 prompt 模板

这章只实现 Tools——这是最核心、用得最多的。Resources 和 Prompts 原理类似，后面可以自己扩展。

### 8.11 MCP 消息类型

协议层的类型定义：

```typescript
// src/mcp/types.ts

/** JSON-RPC 请求 */
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

/** JSON-RPC 响应 */
export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** MCP 工具定义（从 tools/list 返回） */
export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** tools/call 的响应 */
export interface ToolCallResult {
  content: Array<{
    type: "text" | "image" | "resource";
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError?: boolean;
}

/** mcp.json 中单个 server 的配置 */
export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}
```

`McpToolDefinition` 和 OpenAI function calling 的 tool schema 很像——都是名称 + 描述 + JSON Schema 参数。这不是巧合，MCP 就是在这一层上做了标准化。

`ToolCallResult` 的 `content` 是个数组，支持多种类型。文本是最常用的，图片和资源用于更复杂的场景。

### 8.12 实现 MCP Client

MCP Client 的职责：启动子进程、完成握手、发现工具、调用工具。

```typescript
// src/mcp/client.ts

import { spawn, type ChildProcess } from "node:child_process";
import type {
  JsonRpcRequest, JsonRpcResponse, InitializeResult,
  McpToolDefinition, ToolsListResult, ToolCallResult, McpServerConfig,
} from "./types.js";

export class McpClient {
  private process: ChildProcess | null = null;
  private requestId = 0;
  private pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void }
  >();
  private buffer = "";
  private serverName: string;
  private config: McpServerConfig;
  private _tools: McpToolDefinition[] = [];

  constructor(serverName: string, config: McpServerConfig) {
    this.serverName = serverName;
    this.config = config;
  }

  get tools(): McpToolDefinition[] {
    return this._tools;
  }
```

构造函数接收 server 名称和配置。`pending` 是一个 Map，用 request ID 追踪正在等待响应的请求——经典的异步 RPC 模式。

**启动和握手：**

```typescript
async connect(): Promise<InitializeResult> {
  this.process = spawn(this.config.command, this.config.args ?? [], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...this.config.env },
  });

  // 监听 stdout，按行解析 JSON-RPC 响应
  this.process.stdout!.on("data", (chunk: Buffer) => {
    this.buffer += chunk.toString();
    this.processBuffer();
  });

  this.process.on("exit", (code) => {
    // 拒绝所有等待中的请求
    for (const [, { reject }] of this.pending) {
      reject(new Error(`MCP server exited with code ${code}`));
    }
    this.pending.clear();
  });

  // 握手
  const initResult = await this.request<InitializeResult>("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "ling", version: "0.8.0" },
  });

  this.notify("notifications/initialized", {});

  // 发现工具
  const toolsResult = await this.request<ToolsListResult>("tools/list", {});
  this._tools = toolsResult.tools;

  console.log(
    `[mcp:${this.serverName}] Connected, ${this._tools.length} tool(s)`
  );
  return initResult;
}
```

`spawn` 启动子进程，`stdio: ["pipe", "pipe", "pipe"]` 使得 Client 能读写它的 stdin/stdout/stderr。`connect` 做三件事：启动进程、完成握手、发现工具。

**发送和接收消息：**

```typescript
private request<T>(method: string, params: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = ++this.requestId;
    this.pending.set(id, { resolve, reject });

    this.send({ jsonrpc: "2.0", id, method, params });

    setTimeout(() => {
      if (this.pending.has(id)) {
        this.pending.delete(id);
        reject(new Error(`Request ${method} timed out`));
      }
    }, 30_000);
  });
}

private send(msg: object): void {
  const json = JSON.stringify(msg);
  this.process!.stdin!.write(json + "\n");
}

private processBuffer(): void {
  const lines = this.buffer.split("\n");
  this.buffer = lines.pop() ?? ""; // 最后一个可能不完整

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const msg = JSON.parse(trimmed) as JsonRpcResponse;
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        msg.error
          ? reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`))
          : resolve(msg.result);
      }
    } catch { /* 非 JSON 行，忽略 */ }
  }
}
```

通信协议是"一行一个 JSON"——发送时追加 `\n`，接收时按 `\n` 分割。`processBuffer` 处理 TCP 粘包问题（stdout 可能一次吐出多行，也可能半行）。

`request` 方法返回 Promise，把 resolve/reject 存到 `pending` Map 里。当 `processBuffer` 解析到对应 ID 的响应时，resolve 或 reject 这个 Promise。30 秒超时兜底。

**调用工具：**

```typescript
async callTool(
  toolName: string,
  args: Record<string, unknown>
): Promise<ToolCallResult> {
  return this.request<ToolCallResult>("tools/call", {
    name: toolName,
    arguments: args,
  });
}
```

调用工具就是发个 `tools/call` 请求，没什么花头。

### 8.13 从配置加载 MCP Server

MCP Server 配置写在 `.ling/mcp.json` 里：

```json
{
  "mcpServers": {
    "sqlite": {
      "command": "npx",
      "args": ["tsx", "src/mcp-servers/sqlite-server.ts", "./data/mydb.sqlite"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_TOKEN": "ghp_xxxx"
      }
    }
  }
}
```

每个 server 有个名字（`sqlite`、`github`），配置里指定启动命令和参数。loader 遍历配置，逐个启动 server：

```typescript
// src/mcp/loader.ts

import { McpClient } from "./client.js";
import type { McpToolDefinition } from "./types.js";

export interface McpRegisteredTool {
  /** 格式：mcp__<server>__<tool> */
  name: string;
  description: string;
  inputSchema: McpToolDefinition["inputSchema"];
  client: McpClient;
  remoteName: string;
}

export async function loadMcpServers(projectRoot: string): Promise<{
  clients: McpClient[];
  tools: McpRegisteredTool[];
}> {
  const configPath = join(projectRoot, ".ling", "mcp.json");
  let config: McpConfig;

  try {
    const raw = await readFile(configPath, "utf-8");
    config = JSON.parse(raw);
  } catch (err: any) {
    if (err.code === "ENOENT") return { clients: [], tools: [] };
    console.error(`[mcp] Failed to load config:`, err.message);
    return { clients: [], tools: [] };
  }

  const clients: McpClient[] = [];
  const tools: McpRegisteredTool[] = [];

  for (const [serverName, serverConfig] of Object.entries(config.mcpServers)) {
    const client = new McpClient(serverName, serverConfig);
    try {
      await client.connect();
      clients.push(client);

      for (const tool of client.tools) {
        tools.push({
          name: `mcp__${serverName}__${tool.name}`,
          description: `[MCP:${serverName}] ${tool.description}`,
          inputSchema: tool.inputSchema,
          client,
          remoteName: tool.name,
        });
      }
    } catch (err: any) {
      console.error(`[mcp] Failed to connect ${serverName}:`, err.message);
    }
  }

  return { clients, tools };
}
```

**命名规则 `mcp__<server>__<tool>`** 很重要。两个 MCP Server 可能都暴露了叫 `query` 的工具，加上 server 名前缀就不会冲突。LLM 看到 `mcp__sqlite__query`，也能理解这是 SQLite server 的查询工具。

注意错误处理——某个 server 连接失败不影响其他 server。这是可选扩展，不能因为一个插件挂了就整个 Agent 起不来。

### 8.14 实战：写一个 SQLite MCP Server

现在来写个真的 MCP Server——让 Ling 能查 SQLite 数据库。

一个 MCP Server 就是一个普通的 Node.js 脚本，从 stdin 读 JSON-RPC 请求，往 stdout 写响应：

```typescript
// src/mcp-servers/sqlite-server.ts

import Database from "better-sqlite3";
import { createInterface } from "node:readline";

let db: Database.Database;

const TOOLS = [
  {
    name: "list_tables",
    description: "List all tables in the SQLite database",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "query",
    description: "Execute a read-only SQL query",
    inputSchema: {
      type: "object" as const,
      properties: {
        sql: { type: "string", description: "SQL query (SELECT only)" },
      },
      required: ["sql"],
    },
  },
];
```

两个工具：`list_tables` 列出所有表，`query` 执行只读查询。

**请求分发：**

```typescript
function handleRequest(msg: { id?: number; method: string; params?: any }): object | null {
  if (msg.id == null) return null; // 通知不需要响应

  switch (msg.method) {
    case "initialize":
      return {
        jsonrpc: "2.0", id: msg.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "sqlite-server", version: "0.1.0" },
        },
      };
    case "tools/list":
      return { jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } };
    case "tools/call":
      return handleToolCall(msg.id, msg.params);
    default:
      return {
        jsonrpc: "2.0", id: msg.id,
        error: { code: -32601, message: `Unknown method: ${msg.method}` },
      };
  }
}
```

就是个 switch-case。`initialize` 返回握手信息，`tools/list` 返回工具列表，`tools/call` 分发到具体工具。

**工具实现：**

```typescript
function handleToolCall(
  id: number,
  params: { name: string; arguments: Record<string, unknown> }
): object {
  const { name, arguments: args } = params;

  try {
    switch (name) {
      case "list_tables": {
        const rows = db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
          .all() as { name: string }[];
        return {
          jsonrpc: "2.0", id,
          result: {
            content: [{ type: "text", text: JSON.stringify(rows.map(r => r.name), null, 2) }],
          },
        };
      }
      case "query": {
        const sql = args.sql as string;
        if (!/^\s*SELECT\b/i.test(sql)) {
          return {
            jsonrpc: "2.0", id,
            result: {
              content: [{ type: "text", text: "Error: Only SELECT queries allowed" }],
              isError: true,
            },
          };
        }
        const rows = db.prepare(sql).all();
        return {
          jsonrpc: "2.0", id,
          result: {
            content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
          },
        };
      }
      default:
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown tool: ${name}` } };
    }
  } catch (err: any) {
    return {
      jsonrpc: "2.0", id,
      result: { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true },
    };
  }
}
```

`query` 工具有个安全检查——正则匹配 `SELECT`，拒绝其他语句。这是最基本的防护，生产环境应该用数据库的只读模式（`better-sqlite3` 支持 `readonly: true`）。

**启动主循环：**

```typescript
const dbPath = process.argv[2];
if (!dbPath) {
  console.error("Usage: sqlite-server <database-path>");
  process.exit(1);
}

db = new Database(dbPath, { readonly: true });

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  try {
    const msg = JSON.parse(line.trim());
    const response = handleRequest(msg);
    if (response) {
      process.stdout.write(JSON.stringify(response) + "\n");
    }
  } catch { /* 忽略 */ }
});
```

就这么多。一个完整的 MCP Server 不到 100 行。数据库路径从命令行参数传入，用 `readline` 逐行读 stdin，解析 JSON-RPC，处理请求，写回 stdout。

配置 `.ling/mcp.json`：

```json
{
  "mcpServers": {
    "sqlite": {
      "command": "npx",
      "args": ["tsx", "src/mcp-servers/sqlite-server.ts", "./data/mydb.sqlite"]
    }
  }
}
```

Ling 启动后会自动连接这个 server，发现 `list_tables` 和 `query` 两个工具，注册为 `mcp__sqlite__list_tables` 和 `mcp__sqlite__query`。现在你跟 Ling 说"列出数据库里所有表"，它会自动调用 MCP 工具。

### 8.15 集成到 Agent Loop

最后把 Hook 和 MCP 都集成到主循环里：

```typescript
// src/ling.ts

async function main() {
  const projectRoot = process.cwd();
  const sessionId = randomUUID();

  // 1. 加载 Hook
  const hookEngine = new HookEngine();
  const hooksConfig = await loadHooksConfig(projectRoot);
  hookEngine.load(hooksConfig);

  // 2. 加载 MCP
  const { clients: mcpClients, tools: mcpTools } = await loadMcpServers(projectRoot);

  // 合并内置工具和 MCP 工具
  const mcpToolMap = new Map(mcpTools.map((t) => [t.name, t]));
  const allTools = [...BUILTIN_TOOLS, ...mcpTools.map(mcpToolToOpenAI)];

  // 3. 触发 SessionStart hook
  await hookEngine.trigger({
    event: "SessionStart", sessionId, timestamp: Date.now(),
  });

  // ... Agent loop ...

  // 处理每个工具调用
  for (const call of msg.tool_calls) {
    const toolName = call.function.name;
    let toolParams = JSON.parse(call.function.arguments);

    // ---- PreToolUse Hook ----
    const preResults = await hookEngine.trigger({
      event: "PreToolUse", sessionId, timestamp: Date.now(),
      toolCall: { tool: toolName, params: toolParams },
    });

    const blocked = preResults.find((r) => r.blocked);
    if (blocked) {
      messages.push({
        role: "tool", tool_call_id: call.id,
        content: `Tool call blocked: ${blocked.blockReason}`,
      });
      continue; // 跳过执行
    }

    // 参数可能被 Hook 修改
    const modified = preResults.find((r) => r.modifiedParams);
    if (modified?.modifiedParams) {
      toolParams = { ...toolParams, ...modified.modifiedParams };
    }

    // ---- 执行工具 ----
    let result: string;
    const mcpTool = mcpToolMap.get(toolName);
    if (mcpTool) {
      result = await executeMcpTool(mcpTool, toolParams);
    } else {
      result = await executeBuiltinTool(toolName, toolParams);
    }

    // ---- PostToolUse Hook ----
    await hookEngine.trigger({
      event: "PostToolUse", sessionId, timestamp: Date.now(),
      toolCall: { tool: toolName, params: toolParams, result },
    });

    messages.push({ role: "tool", tool_call_id: call.id, content: result });
  }

  // 关闭 MCP 连接
  await shutdownMcpServers(mcpClients);
}
```

工具调用的完整流程：

1. LLM 决定调用工具
2. **PreToolUse Hook** → 可以拦截或修改参数
3. 判断是 MCP 工具还是内置工具，分别执行
4. **PostToolUse Hook** → 可以触发后续动作（lint、日志等）
5. 结果返回给 LLM

MCP 工具的执行委托给 `McpClient.callTool()`，从 LLM 的视角看，它和内置工具没有区别——都是有名称、有描述、有参数的 function。

### 8.16 对照 Claude Code

我们实现了一个最小但可用的 Hook + MCP 系统。来看看 Claude Code 做到了什么程度：

**MCP 方面：**

- **三种传输**：我们只实现了 stdio，Claude Code 还支持 HTTP 和 SSE（Server-Sent Events）。HTTP 适合远程 server，SSE 适合需要长连接的场景
- **动态工具发现**：Claude Code 有 `ToolSearch`——不是启动时一次性加载所有工具，而是按需搜索。如果有 200 个 MCP 工具，不会全塞进 system prompt（那太浪费 token），而是 LLM 需要时用 `ToolSearch` 查找
- **运行时重配置**：`setMcpServers()` 可以在不重启 Agent 的情况下添加、删除、重新连接 MCP Server
- **连接状态**：`mcpServerStatus()` 查看哪些 server 在线、哪些挂了

**Hook 方面：**

- **24 种事件类型**：我们只有 4 种，Claude Code 有 PreToolUse、PostToolUse、Notification、Stop 等等，粒度更细
- **4 种 handler 类型**：除了 command 和 http，还有 prompt（修改 system prompt）和 agent（启动子 Agent 来处理）
- **优先级系统**：managed settings > local > shared > plugin，不同来源的 Hook 有不同优先级。公司统一配置的 Hook 优先于个人配置，防止个人绕过安全规则

这些都是我们这个版本可以逐步演进的方向。先把核心跑通，再加功能。

### 8.17 Hook vs MCP：什么时候用哪个

| | Hook | MCP |
|---|---|---|
| **是什么** | 事件回调 | 工具插件 |
| **解决什么问题** | 在已有流程中插入自定义逻辑 | 给 Agent 添加全新能力 |
| **谁触发** | Agent 在特定节点自动触发 | LLM 主动决定调用 |
| **执行方式** | 同步阻塞或异步 fire-and-forget | 同步（等结果返回给 LLM） |
| **能否影响流程** | 能（拦截、修改参数） | 不能（只提供结果） |
| **典型场景** | 自动 lint、发通知、安全拦截 | 查数据库、调 API、搜文档 |
| **配置文件** | .ling/hooks.json | .ling/mcp.json |
| **协议** | 无（直接执行命令或 HTTP） | JSON-RPC 2.0 |

一句话总结：**Hook 是 AOP（面向切面），MCP 是 Plugin（插件系统）**。Hook 关注的是"Agent 做某件事的前后"，MCP 关注的是"Agent 能做什么事"。

实际项目中两者经常配合：MCP 提供数据库查询能力，Hook 在每次查询后记录审计日志。MCP 给了 Agent 能力，Hook 对这些能力做监控和管控。

### 8.18 小结

这章做了两件事：

**Hook 系统** 让用户在 Agent 的执行流程中插入自定义逻辑。4 种事件（PreToolUse、PostToolUse、SessionStart、Stop），2 种 handler（command、http），通过 `.ling/hooks.json` 配置。PreToolUse 最强大——能拦截和修改工具调用。

**MCP** 让任何人都能给 Agent 写工具，无需修改 Agent 代码。标准的 JSON-RPC 协议，stdio 传输，启动即用。一个 SQLite MCP Server 不到 100 行代码。

两者的定位不同：Hook 是切面（在已有动作上加逻辑），MCP 是插件（加新能力）。但它们共享同一个设计原则——**Agent 核心保持简单，扩展能力外置**。

到这里，Ling 已经有了工具系统、权限控制、上下文管理、流式输出、会话记忆、Hook 和 MCP。作为单 Agent 架构，它已经相当完整了。

下一章打破"单 Agent"的限制——让多个 Agent 协作。
