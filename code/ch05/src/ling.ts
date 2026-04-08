import OpenAI from "openai";
import * as readline from "readline";
import { createToolRegistry } from "./tools/index.js";
import { PermissionGuard, loadPermissionConfig } from "./permissions/index.js";

const client = new OpenAI();
const registry = createToolRegistry();
const config = loadPermissionConfig();
const guard = new PermissionGuard(config);

const model = "gpt-4o";
type Message = OpenAI.ChatCompletionMessageParam;

const systemPrompt = `You are Ling, a coding assistant. You have access to tools to read, write, edit files, search code, and run commands. Use tools to accomplish tasks step by step.`;

async function agentLoop(userMessage: string, history: Message[]): Promise<string> {
  history.push({ role: "user", content: userMessage });

  while (true) {
    const response = await client.chat.completions.create({
      model,
      messages: [{ role: "system", content: systemPrompt }, ...history],
      tools: registry.toOpenAITools(),
    });

    const message = response.choices[0].message;
    history.push(message as Message);

    if (!message.tool_calls || message.tool_calls.length === 0) {
      return message.content ?? "(no response)";
    }

    for (const toolCall of message.tool_calls) {
      const name = toolCall.function.name;
      const params = JSON.parse(toolCall.function.arguments);

      // ---- 权限检查：在执行前拦截 ----
      const allowed = await guard.check(name, params);

      if (!allowed) {
        // 被拒绝：告诉 LLM 这个操作不允许
        history.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: `Permission denied: this operation was blocked by the permission system. Try a different approach.`,
        });
        continue;
      }

      console.log(`  [tool] ${name}(${JSON.stringify(params).slice(0, 80)}...)`);

      let result: string;
      try {
        result = await registry.execute(name, params);
      } catch (err) {
        result = `Error: ${(err as Error).message}`;
      }

      history.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: result,
      });
    }
  }
}

async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const history: Message[] = [];
  console.log("Ling Agent (ch05) — permission system enabled");
  console.log(`Project root: ${config.projectRoot}`);
  console.log(`Rules loaded: ${config.rules.length}\n`);

  const prompt = () => {
    rl.question("You: ", async (input) => {
      if (!input.trim()) return prompt();
      try {
        const reply = await agentLoop(input, history);
        console.log(`\nLing: ${reply}\n`);
      } catch (err) {
        console.error(`Error: ${(err as Error).message}\n`);
      }
      prompt();
    });
  };
  prompt();
}

main();
