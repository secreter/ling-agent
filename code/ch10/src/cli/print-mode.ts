// Print 模式——非交互执行，跑完即退

import OpenAI from "openai";
import type { CliOptions } from "./parser.js";
import { writeOutput, writeStreamEvent } from "./output.js";
import { loadSchema, extractJson, validateAgainstSchema } from "./schema-validator.js";

/** 非交互模式主函数 */
export async function runPrintMode(
  query: string,
  options: CliOptions
): Promise<void> {
  const client = new OpenAI();

  // 构建 system prompt
  let systemPrompt = "You are Ling, a coding assistant.";

  // 如果指定了 schema，注入约束
  let schemaConstraint: ReturnType<typeof loadSchema> | null = null;
  if (options.schema) {
    schemaConstraint = loadSchema(options.schema);
    systemPrompt += "\n\n" + schemaConstraint.promptInstructions;
  }

  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: query },
  ];

  // stream 模式发一个 start 事件
  if (options.format === "stream") {
    writeStreamEvent({ type: "start", model: options.model });
  }

  let turns = 0;
  let finalContent = "";

  // Agent loop——和交互模式共享同一个循环逻辑
  while (turns < options.maxTurns) {
    turns++;

    const response = await client.chat.completions.create({
      model: options.model,
      messages,
    });

    const message = response.choices[0].message;
    finalContent = message.content ?? "";

    // stream 模式实时输出
    if (options.format === "stream" && finalContent) {
      writeStreamEvent({ type: "text_delta", content: finalContent });
    }

    // 没有 tool_calls，结束循环
    if (!message.tool_calls || message.tool_calls.length === 0) {
      break;
    }

    // 有 tool_calls 就继续执行……（此处省略工具执行，和前几章一样）
    messages.push(message as OpenAI.ChatCompletionMessageParam);

    for (const toolCall of message.tool_calls) {
      if (options.format === "stream") {
        writeStreamEvent({
          type: "tool_use",
          tool: toolCall.function.name,
          args: JSON.parse(toolCall.function.arguments),
        });
      }

      // 工具执行逻辑（复用之前章节的 tool registry）
      const result = `Tool ${toolCall.function.name} executed`;

      if (options.format === "stream") {
        writeStreamEvent({ type: "tool_result", tool: toolCall.function.name, result });
      }

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: result,
      });
    }
  }

  // 如果有 schema 约束，验证输出
  let structuredOutput: unknown = undefined;
  if (schemaConstraint) {
    try {
      const parsed = extractJson(finalContent);
      const { valid, errors } = validateAgainstSchema(parsed, schemaConstraint.schema);

      if (!valid) {
        process.stderr.write(`Schema validation failed: ${errors.join(", ")}\n`);
        process.exit(1);
      }

      structuredOutput = parsed;
      // schema 模式下，输出纯 JSON
      finalContent = JSON.stringify(parsed, null, 2);
    } catch (err) {
      process.stderr.write(`Failed to parse structured output: ${(err as Error).message}\n`);
      process.exit(1);
    }
  }

  // 最终输出
  writeOutput(options.format, {
    content: finalContent,
    model: options.model,
    turns,
    structured_output: structuredOutput,
  });
}
