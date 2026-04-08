// src/agents/spawner.ts — 子 Agent 生成器：创建独立的 Agent 实例并运行

import OpenAI from "openai";
import type { SubAgentConfig, SubAgentResult, ToolRegistry } from "./types.js";

const DEFAULT_MODEL = process.env.LLM_MODEL || "gpt-4o-mini";
const DEFAULT_MAX_TURNS = 15;

export class AgentSpawner {
  private openai: OpenAI;
  private toolRegistry: ToolRegistry;

  constructor(openai: OpenAI, toolRegistry: ToolRegistry) {
    this.openai = openai;
    this.toolRegistry = toolRegistry;
  }

  /** 启动一个子 Agent，返回其最终输出 */
  async spawn(config: SubAgentConfig, task: string): Promise<SubAgentResult> {
    const startTime = Date.now();
    const model = config.model ?? DEFAULT_MODEL;
    const maxTurns = config.maxTurns ?? DEFAULT_MAX_TURNS;

    // 1. 从全局工具表中过滤出子 Agent 允许用的工具
    const allowedTools: OpenAI.ChatCompletionTool[] = [];
    const executors = new Map<string, (params: Record<string, unknown>) => Promise<string>>();

    for (const toolName of config.tools) {
      const entry = this.toolRegistry.get(toolName);
      if (entry) {
        allowedTools.push(entry.definition);
        executors.set(toolName, entry.execute);
      }
    }

    // 2. 独立的消息历史 —— 这是上下文隔离的关键
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: config.role },
      { role: "user", content: task },
    ];

    console.log(`\n[${config.name}] Started (model=${model}, tools=${config.tools.join(",")})`);

    // 3. 独立的 agent loop
    let turns = 0;
    try {
      while (turns < maxTurns) {
        turns++;

        const response = await this.openai.chat.completions.create({
          model,
          messages,
          tools: allowedTools.length > 0 ? allowedTools : undefined,
        });

        const msg = response.choices[0].message;
        messages.push(msg);

        // 没有工具调用 → 子 Agent 结束
        if (!msg.tool_calls || msg.tool_calls.length === 0) {
          console.log(`[${config.name}] Completed in ${turns} turns`);
          return {
            name: config.name,
            success: true,
            output: msg.content ?? "",
            turns,
            durationMs: Date.now() - startTime,
          };
        }

        // 执行工具调用
        for (const call of msg.tool_calls) {
          const toolName = call.function.name;
          const params = JSON.parse(call.function.arguments);

          // 安全检查：子 Agent 只能用允许的工具
          const executor = executors.get(toolName);
          if (!executor) {
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: `Error: tool "${toolName}" is not allowed for this agent.`,
            });
            continue;
          }

          console.log(`[${config.name}] ${toolName}(${call.function.arguments.slice(0, 100)})`);

          const result = await executor(params);
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: result,
          });
        }
      }

      // 超过最大轮次
      console.log(`[${config.name}] Hit max turns (${maxTurns})`);
      return {
        name: config.name,
        success: false,
        output: "Reached maximum turns without completing.",
        turns,
        durationMs: Date.now() - startTime,
        error: `Exceeded ${maxTurns} turns`,
      };
    } catch (err) {
      return {
        name: config.name,
        success: false,
        output: "",
        turns,
        durationMs: Date.now() - startTime,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
