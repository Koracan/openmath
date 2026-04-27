# OpenMath 数学 Agent 开发计划（对标 opencode）

## 1. 目标与范围

构建一个可在命令行连续对话的数学问题求解 Agent，具备以下核心能力：
- 自定义 LLM API（可切换 provider、base URL、model、key）
- 连接 Mathematica MCP 服务器（用于符号计算、微积分、代数变换）
- 创建与运行 Python 脚本（用于数值计算、仿真、数据处理）
- 读取与修改 .md 文件（用于题目输入、答案输出、过程笔记）

约束与建议落地：
- 优先保证 token 缓存命中
- 上下文窗口接近上限时自动压缩上下文
- 数值计算优先 Python
- 符号计算与微积分优先 Mathematica

---

## 2. 用户视角需求映射

### 2.1 命令行聊天
- 通过 CLI 启动交互：支持一次性问答与持续会话模式
- 实时打印 Agent 回复内容（流式输出）

### 2.2 会话概念
- 支持多个会话并可切换/恢复
- 每个会话保存消息历史、工具调用摘要、关键结论

### 2.3 自由提出要求
- 用户可要求将解答写入指定 .md 文件
- 用户可要求从 .md 文件读取题目
- 用户可以提出其他任何要求

---

## 3. LLM 视角能力映射

### 3.1 工具可用性
- LLM 可调用 Python 工具
- LLM 可调用 Mathematica MCP 工具
- LLM 可调用 Markdown 读写工具

### 3.2 工具使用策略（写入系统提示与工具说明）
- 数值计算：优先 Python
- 符号计算/微积分：优先 Mathematica
- 需要沉淀结构化结果时：优先输出到 .md
- 多轮问题中：优先读取已有 .md 以复用上下文

### 3.3 文档组织策略
- 按会话与主题组织 .md：
  - notes/sessions/<session-id>/qa-YYYYMMDD.md
  - notes/topics/<topic>.md
- 支持在同一文件上多次编辑（追加、替换指定段落、重写）

---

## 4. 总体架构（建议）

```text
CLI (src/index.ts)
  -> Session Manager
  -> Agent Orchestrator
      -> Model Adapter (Custom API)
      -> Tool Router
          -> Python Tool
          -> Mathematica MCP Tool
          -> Markdown Tool
      -> Context Manager (缓存命中 + 压缩)
  -> Storage (sessions/, logs/, notes/)
```

### 4.1 模块职责
- Model Adapter：统一封装不同 API 配置（兼容 OpenAI 风格接口）
- Tool Router：根据 LLM tool-call 分发执行并返回结构化结果
- Session Manager：管理会话生命周期、历史持久化、恢复
- Context Manager：裁剪、摘要、缓存键管理
- Storage：落盘聊天记录、工具调用记录、md 文件变更

---

## 5. 目录与文件规划

```text
src/
  index.ts                     # CLI 入口
  config/
    env.ts                     # 环境变量与配置校验（zod）
    models.ts                  # model/provider 配置
  agent/
    orchestrator.ts            # 对话主循环
    policies.ts                # 工具选择策略（Python/Mathematica/.md）
    prompts.ts                 # system/developer 提示词模板
  session/
    session-manager.ts         # 创建、切换、恢复、保存会话
    session-store.ts           # 文件持久化
  context/
    context-manager.ts         # 上下文预算、压缩、缓存命中策略
    summarizer.ts              # 历史摘要生成
  tools/
    registry.ts                # 工具注册与 schema
    python-tool.ts             # 生成并执行 Python 脚本
    mathematica-mcp-tool.ts    # MCP client 连接与调用
    markdown-tool.ts           # 读取/写入/追加/替换 md
  io/
    stream.ts                  # CLI 流式输出
    command-parser.ts          # /new /switch /save 等命令解析
  types/
    agent.ts
    tool.ts

data/
  sessions/
  cache/
  logs/
notes/
  sessions/
  topics/
```

---

## 6. 分阶段里程碑

## M0 - 项目骨架与配置（0.5 天）
- 建立目录结构与基础类型
- 配置 .env 与 zod 校验
- 定义统一日志格式（jsonl）

验收：
- CLI 可启动
- 配置缺失时给出明确错误

## M1 - CLI 会话系统（1 天）
- 实现命令：/new, /list, /switch <id>, /history, /exit
- 会话消息本地持久化（data/sessions）
- 启动时可恢复最近会话

验收：
- 多会话可创建、切换、恢复
- 回答可在终端流式显示

## M2 - 自定义 API 接入（1 天）
- 支持可配置 provider/baseURL/model/apiKey
- 封装聊天请求、流式响应、工具调用协议
- 增加重试、超时、限流处理

验收：
- 切换模型无需改业务代码
- 错误提示可定位到网络/鉴权/配额问题

## M3 - 工具系统（Python + Markdown）（1.5 天）
- Python 工具：
  - 在 data/tmp/scripts 生成脚本
  - 执行并捕获 stdout/stderr
  - 返回结构化执行结果
- Markdown 工具：
  - read_file, write_file, append, replace_section
  - 限制工作区白名单路径，防止误改

验收：
- 可从 .md 读题并写回答案
- 可多次编辑同一 .md
- Python 计算结果可回传给模型

## M4 - Mathematica MCP 接入（1.5 天）
- 实现 MCP 客户端（stdio 或 sse）
- 完成工具发现与调用适配
- 加入工具健康检查与断线重连

验收：
- 可成功调用 Mathematica 符号运算工具
- 失败时给出可读错误

## M5 - 上下文与缓存优化（1.5 天）
- Token 预算器：以模型返回 `usage.total_tokens` 作为已用上下文长度（不做本地 token 估算）
- 增加环境变量：`OPENMATH_MAX_CONTEXT_LENGTH`（用户自定义最大上下文）
- 缓存命中策略：
  - 固定 system 提示词与工具定义顺序
  - 对历史消息做块级哈希缓存
  - 将稳定上下文放在前缀以提高命中
- 上下文压缩：
  - 已用上下文超过最大上下文的 75% 时触发摘要压缩
  - 保留最近 N 轮原文 + 历史摘要
- CLI 可观测性：
  - 进入会话时提示 `context: <usage>/<max_length>, xx%`
  - 触发压缩时提示压缩前与压缩后上下文用量

验收：
- 长对话中 token 超限率显著下降
- 同类重复提问时响应成本降低

## M6 - 策略与体验完善（1 天）
- 强化工具选择策略（Python vs Mathematica）
- 增加“写入 md”默认模板与可配置风格
- 增加可观测性：每轮显示工具调用摘要与 token 统计

验收：
- 用户可自然要求“读/写 md”“继续改同一 md”
- 模型在数值/符号场景工具选择更稳定

---

## 7. 关键实现细节

### 7.1 Token 缓存命中优先
- 保持以下内容稳定且顺序固定：
  - system prompt
  - tool schema
  - 会话元信息模板
- 将高波动内容（最新用户消息、最新工具结果）放在后部
- 对历史消息做“分段摘要 + 锚点保留”而非整段重写

### 7.2 上下文压缩策略
- 压缩触发条件：
  - `usage.total_tokens / OPENMATH_MAX_CONTEXT_LENGTH > 75%`
- 压缩方法：
  - 提炼为 问题-方法-结果-待办 四段摘要
  - 保留最近 3~5 轮原消息
  - 将工具输出压缩为“结论 + 必要数据”

### 7.3 Python 工具策略
- 仅在受控目录写脚本与运行
- 设置执行超时与输出长度上限
- 对常见科学计算库缺失给出明确引导

### 7.4 Mathematica MCP 策略
- 启动时做握手与 capability 探测
- 当 Mathematica 不可用时：给出可读错误

### 7.5 Markdown 编辑策略
- 支持原子写入（先写临时文件再替换）
- 支持按标题段落替换，避免整文件覆盖
- 所有写操作记录变更日志（时间、会话、文件、摘要）

---

## 8. 测试计划

### 8.1 单元测试
- session-manager：会话创建/切换/恢复
- context-manager：压缩触发与摘要拼接
- markdown-tool：追加、段落替换、并发写入保护

### 8.2 集成测试
- CLI -> LLM -> Python tool 完整链路
- CLI -> LLM -> Mathematica MCP tool 完整链路
- “从 md 读题并将答案写回 md”端到端流程

### 8.3 回归场景
- 长对话（>50 轮）
- 多次编辑同一 md 文件

---

## 9. 验收清单（面向你当前目标）

- 可在命令行多轮聊天并看到流式回答
- 支持会话创建、切换、恢复
- 可配置并切换自定义 API
- 可调用 Mathematica MCP 完成符号/微积分任务
- 可创建并运行 Python 脚本完成数值计算
- 可按用户要求读取与多次修改 .md
- 具备 token 缓存命中优化与上下文压缩机制

---

## 10. 建议的首周执行顺序

- Day 1: M0 + M1
- Day 2: M2
- Day 3: M3
- Day 4: M4
- Day 5: M5 + M6（基础版）

完成首周后再做：
- 提示词与工具路由策略微调
- 真实数学题集压测
- 成本与时延对比评估
