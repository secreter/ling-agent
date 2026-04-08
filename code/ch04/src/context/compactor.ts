// 上下文压缩器：长对话时自动摘要旧消息

import OpenAI from "openai";

type Message = OpenAI.Chat.ChatCompletionMessageParam;

export interface CompactOptions {
  keepRecentTurns: number;  // 保留最近 N 轮对话
  maxHistoryTokens: number; // 历史消息超过这个 token 数就触发压缩
}

const DEFAULT_OPTIONS: CompactOptions = {
  keepRecentTurns: 4,
  maxHistoryTokens: 50000,
};

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function messagesToTokens(messages: Message[]): number {
  return messages.reduce((sum, m) => {
    const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    return sum + estimateTokens(content || "");
  }, 0);
}

// 找到一轮对话的边界：user → assistant (+ tool calls + tool results) 算一轮
function splitIntoTurns(messages: Message[]): Message[][] {
  const turns: Message[][] = [];
  let current: Message[] = [];

  for (const msg of messages) {
    if (msg.role === "user" && current.length > 0) {
      turns.push(current);
      current = [];
    }
    current.push(msg);
  }
  if (current.length > 0) turns.push(current);
  return turns;
}

export class Compactor {
  private options: CompactOptions;
  private client: OpenAI;
  private model: string;

  constructor(client: OpenAI, model: string, options?: Partial<CompactOptions>) {
    this.client = client;
    this.model = model;
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  // 判断是否需要压缩
  shouldCompact(messages: Message[]): boolean {
    // 跳过 system message
    const history = messages.filter((m) => m.role !== "system");
    return messagesToTokens(history) > this.options.maxHistoryTokens;
  }

  // 执行压缩：把旧消息摘要成一条 system message
  async compact(messages: Message[]): Promise<Message[]> {
    if (messages.length === 0) return messages;

    // 提取 system prompt（永远保留）
    const systemMsg = messages.find((m) => m.role === "system");
    const history = messages.filter((m) => m.role !== "system");

    // 按轮次拆分
    const turns = splitIntoTurns(history);
    const keepCount = this.options.keepRecentTurns;

    if (turns.length <= keepCount) return messages; // 不够压缩的

    // 要压缩的旧轮次 vs 保留的新轮次
    const oldTurns = turns.slice(0, turns.length - keepCount);
    const recentTurns = turns.slice(turns.length - keepCount);

    // 让 LLM 做摘要
    const oldMessages = oldTurns.flat();
    const summary = await this.summarize(oldMessages);

    // 重新组装
    const result: Message[] = [];
    if (systemMsg) result.push(systemMsg);
    result.push({ role: "user", content: `[Previous conversation summary]\n${summary}` });
    result.push({ role: "assistant", content: "Understood. I have the context from our previous conversation." });
    result.push(...recentTurns.flat());

    const before = messagesToTokens(messages);
    const after = messagesToTokens(result);
    console.log(`[compact] ${before} → ${after} tokens (saved ${before - after})`);

    return result;
  }

  private async summarize(messages: Message[]): Promise<string> {
    const formatted = messages
      .map((m) => {
        const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        return `[${m.role}] ${(content || "").slice(0, 500)}`;
      })
      .join("\n");

    const res = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        {
          role: "system",
          content: "Summarize this conversation concisely. Focus on: what the user asked, what tools were used, what was accomplished, and any important decisions. Keep it under 300 words.",
        },
        { role: "user", content: formatted },
      ],
    });

    return res.choices[0].message.content || "(summary failed)";
  }
}
