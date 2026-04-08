#!/usr/bin/env node

// Ling Agent —— 完整版主入口（交互 + 非交互）
// 这是所有前面章节的集大成

import * as readline from "readline";
import OpenAI from "openai";
import { parseCli, readStdin, runPrintMode } from "./cli/index.js";
import { createToolRegistry } from "./tools/index.js";
import { PermissionGuard, loadPermissionConfig } from "./permissions/index.js";

const VERSION = "0.10.0";

const HELP = `
Ling - AI Coding Agent

Usage:
  ling [options]                  Start interactive REPL
  ling -p "query"                 Non-interactive mode
  cat file | ling -p "analyze"    Pipe input + query

Options:
  -p, --print <query>    Non-interactive mode, print result and exit
  -f, --format <fmt>     Output format: text (default), json, stream
      --schema <file>    Constrain output with JSON Schema
      --provider <name>  LLM provider (default: openai)
  -m, --model <name>     Model name (default: gpt-4o)
      --max-turns <n>    Max agent loop turns (default: 10)
  -c, --continue         Resume last session
  -r, --resume <id>      Resume specific session
  -n, --name <name>      Name the session
  -h, --help             Show this help
  -v, --version          Show version
`;

async function main() {
  const options = parseCli(process.argv);

  if (options.help) {
    console.log(HELP);
    process.exit(0);
  }

  if (options.version) {
    console.log(`ling v${VERSION}`);
    process.exit(0);
  }

  // ---- 非交互模式 ----
  if (options.print) {
    // 检查是否有 stdin 管道输入
    const stdinContent = await readStdin();
    let query = options.print;

    if (stdinContent) {
      // 把 stdin 内容拼进 query
      query = `${stdinContent}\n\n---\n\n${query}`;
    }

    await runPrintMode(query, options);
    process.exit(0);
  }

  // ---- 交互模式（REPL）----
  console.log(`Ling Agent v${VERSION}\n`);

  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL,
  });

  const registry = createToolRegistry();
  const permConfig = loadPermissionConfig();
  const guard = new PermissionGuard(permConfig);

  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: "You are Ling, a coding assistant." },
  ];

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = () => {
    rl.question("You: ", async (input) => {
      if (!input.trim()) return prompt();
      if (input.trim() === "/exit") {
        rl.close();
        return;
      }

      messages.push({ role: "user", content: input });

      let turns = 0;
      while (turns < options.maxTurns) {
        turns++;

        const response = await client.chat.completions.create({
          model: options.model,
          messages,
          tools: registry.toOpenAITools(),
        });

        const message = response.choices[0].message;

        if (message.content) {
          console.log(`\nLing: ${message.content}\n`);
        }

        // 没有 tool_calls，结束循环
        if (!message.tool_calls || message.tool_calls.length === 0) {
          messages.push(message as OpenAI.ChatCompletionMessageParam);
          break;
        }

        // 有 tool_calls 就执行
        messages.push(message as OpenAI.ChatCompletionMessageParam);

        for (const toolCall of message.tool_calls) {
          const toolName = toolCall.function.name;
          let args: Record<string, unknown>;
          try {
            args = JSON.parse(toolCall.function.arguments);
          } catch {
            const fixed = toolCall.function.arguments
              .replace(/float\('inf'\)/g, "null")
              .replace(/float\('nan'\)/g, "null")
              .replace(/'/g, '"');
            try {
              args = JSON.parse(fixed);
            } catch {
              const errorResult = `Error: invalid tool arguments: ${toolCall.function.arguments}`;
              messages.push({ role: "tool", tool_call_id: toolCall.id, content: errorResult });
              continue;
            }
          }

          console.log(`\n[Tool: ${toolName}] args: ${JSON.stringify(args)}`);

          let result: string;
          const allowed = await guard.check(toolName, args);
          if (!allowed) {
            result = `[Permission denied] Tool "${toolName}" was blocked by permission guard.`;
          } else {
            try {
              result = await registry.execute(toolName, args);
            } catch (err) {
              result = `Error executing ${toolName}: ${(err as Error).message}`;
            }
          }

          console.log(`[Result] ${result.length > 200 ? result.slice(0, 200) + "..." : result}`);

          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: result,
          });
        }
      }

      prompt();
    });
  };
  prompt();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
