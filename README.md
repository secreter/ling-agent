# 《自己动手写 AI Agent》

**从 Claude Code 开源架构到你的第一个编程助手**

## 项目：Ling（灵）

一个从零构建的 AI 编程助手，全书贯穿项目。读完本书，你将拥有一个能理解项目、能改代码、能接外部工具、能跑在 CI 里的 Agent。

## 仓库结构

```
ling-agent/
├── book/                  # 书稿（Markdown）
│   ├── 00-preface/        # 前言 · 先看最终效果
│   ├── 01-first-agent/    # 第1章 · 50行代码，你的第一个Agent
│   ├── 02-multi-provider/ # 第2章 · 多模型适配
│   ├── 03-tool-system/    # 第3章 · 工具系统
│   ├── 04-context-engineering/ # 第4章 · 上下文工程
│   ├── 05-permission-security/ # 第5章 · 权限与安全
│   ├── 06-streaming/      # 第6章 · 流式交互
│   ├── 07-session-memory/ # 第7章 · 会话与记忆
│   ├── 08-hook-mcp/       # 第8章 · Hook系统与MCP
│   ├── 09-multi-agent/    # 第9章 · 多Agent协作
│   ├── 10-production/     # 第10章 · 从CLI到生产
│   ├── 11-finale/         # 终章
│   └── appendix/          # 附录
├── code/                  # 配套代码（每章一个目录，递进式）
│   ├── ch01/              # 第1章代码
│   ├── ch02/              # 第2章代码（包含ch01的+新增）
│   └── ...
└── TODO.md                # 全书任务清单
```

## 目标读者

有 1-3 年经验的普通程序员，熟悉至少一门编程语言，对 AI 应用开发感兴趣。

## 技术栈

- 语言：TypeScript (Node.js)
- LLM：火山引擎（豆包）/ Claude / OpenAI
- 协议：MCP (Model Context Protocol)

## 写作原则

1. 每一页都要有代码或者有用的信息，不灌水
2. 先动手再解释，不以理论开场
3. 每章结尾对照 Claude Code 源码，看工业级实现
4. 语言口语化、直接，去除 AI 味道
