#!/usr/bin/env node

// Ling Agent —— 完整版主入口（交互 + 非交互）
// 这是所有前面章节的集大成

import * as readline from "readline";
import { parseCli, readStdin, runPrintMode } from "./cli/index.js";

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

      // 简化版——实际会复用前几章的 agentLoop
      console.log(`\nLing: [response to "${input}"]\n`);
      prompt();
    });
  };
  prompt();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
