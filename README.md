# OpenMath CLI（M1~M4）

当前版本已实现：
- M1：CLI 多会话（/new, /list, /switch, /history, /exit）
- M2：可配置 OpenAI 兼容 API（流式、重试、超时、限流）
- M3：Python + Markdown 工具（脚本执行、白名单路径写入）
- M4：Mathematica MCP 工具接入（tool discovery、健康检查、断线重连）

## 1. 环境准备

- Node.js 18+
- npm 9+
- Python 3.x（用于 run_python_script 工具）
- [mma-mcp](https://github.com/siqiliu-tsinghua/mma-mcp/tree/main)

## 2. .env 配置

### 2.1 快速创建

在项目根目录执行：

```bash
cp .env.example .env
```

Windows PowerShell 可用：

```powershell
Copy-Item .env.example .env
```

然后编辑 .env，至少填好 OPENMATH_API_KEY 和 OPENMATH_MMA_MCP_PROJECT_DIR

### 2.2 推荐配置示例

```env
OPENMATH_PROVIDER=openai-compatible
OPENMATH_BASE_URL=https://api.openai.com/v1
OPENMATH_MODEL=gpt-4.1-mini
OPENMATH_API_KEY=your_api_key_here

OPENMATH_TIMEOUT_MS=60000
OPENMATH_MAX_RETRIES=2
OPENMATH_RETRY_BASE_DELAY_MS=800
OPENMATH_RPM_LIMIT=30

OPENMATH_PYTHON_BIN=python
OPENMATH_PYTHON_TIMEOUT_SEC=30
OPENMATH_PYTHON_MAX_OUTPUT_CHARS=12000

OPENMATH_MMA_MCP_ENABLED=enabled
OPENMATH_MMA_MCP_TRANSPORT=http
OPENMATH_MMA_MCP_COMMAND=uv
OPENMATH_MMA_MCP_PROJECT_DIR=/path/to/mma-mcp
OPENMATH_MMA_MCP_EXTRA_ARGS=
OPENMATH_MMA_MCP_HTTP_HOST=127.0.0.1
OPENMATH_MMA_MCP_HTTP_PORT=18080
OPENMATH_MMA_MCP_TIMEOUT_SEC=45
OPENMATH_MMA_MCP_TOOL_CACHE_TTL_SEC=30
OPENMATH_MMA_MCP_MAX_TEXT_CHARS=12000

OPENMATH_MD_WHITELIST=notes,answers
```

### 2.3 配置项说明

- OPENMATH_PROVIDER：模型提供方标识（当前走 openai-compatible 适配器）。
- OPENMATH_BASE_URL：兼容 OpenAI Chat Completions 的服务地址。
- OPENMATH_MODEL：默认模型名。
- OPENMATH_API_KEY：API 密钥（必填）。
- OPENMATH_TIMEOUT_MS：单次请求超时（毫秒）。
- OPENMATH_MAX_RETRIES：请求失败重试次数。
- OPENMATH_RETRY_BASE_DELAY_MS：重试基础退避时长（毫秒）。
- OPENMATH_RPM_LIMIT：每分钟请求数上限。
- OPENMATH_PYTHON_BIN：Python 可执行命令（如 python 或 py）。
- OPENMATH_PYTHON_TIMEOUT_SEC：Python 工具执行超时（秒）。
- OPENMATH_PYTHON_MAX_OUTPUT_CHARS：Python 输出最大字符数。
- OPENMATH_MMA_MCP_ENABLED：是否启用 Mathematica MCP 工具（enabled/disabled）。
- OPENMATH_MMA_MCP_TRANSPORT：MCP 传输模式（stdio/http，Windows 建议 http）。
- OPENMATH_MMA_MCP_COMMAND：启动 mma-mcp 的命令（默认 uv）。
- OPENMATH_MMA_MCP_PROJECT_DIR：mma-mcp 项目目录（用于 `uv --directory`）。
- OPENMATH_MMA_MCP_EXTRA_ARGS：附加启动参数（逗号分隔）。
- OPENMATH_MMA_MCP_HTTP_HOST：HTTP 传输模式的绑定地址。
- OPENMATH_MMA_MCP_HTTP_PORT：HTTP 传输模式的端口。
- OPENMATH_MMA_MCP_TIMEOUT_SEC：MCP 请求超时（秒）。
- OPENMATH_MMA_MCP_TOOL_CACHE_TTL_SEC：远端工具列表缓存时长（秒）。
- OPENMATH_MMA_MCP_MAX_TEXT_CHARS：Mathematica 文本结果截断上限。
- OPENMATH_MD_WHITELIST：Markdown 工具可写路径白名单（逗号分隔）。
- OPENMATH_THINKING_ENABLED：启用 DeepSeek 思考模式（enabled/disabled，默认 enabled）。仅对支持此功能的 DeepSeek 模型有效。
- OPENMATH_REASONING_EFFORT：思考模式的推理强度（high/max，默认 high）。

### 2.4 DeepSeek 思考模式配置

若使用 DeepSeek 模型，可配置：

```env
OPENMATH_BASE_URL=https://api.deepseek.com
OPENMATH_MODEL=deepseek-reasoner
OPENMATH_API_KEY=your_deepseek_api_key
OPENMATH_THINKING_ENABLED=enabled
OPENMATH_REASONING_EFFORT=high
```

启用思考模式后，模型的推理过程（reasoning_content）会自动在消息历史中保留，后续工具调用可继续访问这些推理内容，实现复杂多步问题的一致性推理。

## 3. 安装与启动

```bash
npm install
npm run start
```

开发模式：

```bash
npm run dev
```

构建检查：

```bash
npm run build
```

## 4. CLI 使用方法

启动后输入自然语言可直接提问，输入斜杠命令可管理会话。

常用命令：
- /new [title]：新建并切换会话
- /list：查看会话列表
- /switch <id>：切换会话
- /history [limit]：查看最近消息
- /help：查看命令帮助
- /exit：退出

示例：

```text
/new calculus-homework
请用 Python 数值验证这个积分结果
把最终答案写入 notes/sessions/demo/result.md
```

## 5. 常见问题

### 5.1 启动时报 OPENMATH_API_KEY is required

说明 .env 未创建或未填写 OPENMATH_API_KEY。请先按第 2 节完成配置。

### 5.2 Python 工具执行失败

检查：
- OPENMATH_PYTHON_BIN 是否正确（可尝试 python 或 py）
- 本机是否能在终端直接运行对应 Python 命令

### 5.3 Markdown 写入被拒绝

目标路径必须在 OPENMATH_MD_WHITELIST 白名单中，并且必须是 .md 文件。
