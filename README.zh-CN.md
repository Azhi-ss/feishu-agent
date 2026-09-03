# Feishu Agent（飞书助手）

一个构建在 Pi SDK 与 `lark-cli` 之上的飞书（Feishu/Lark）自动化命令行智能体与 TUI 薄壳——提供长期记忆、技能编排与高风险审批守卫，用于飞书交付和工作流。

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/Azhi-ss/feishu-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/Azhi-ss/feishu-agent/actions/workflows/ci.yml)
[![Node ≥ 22.19](https://img.shields.io/badge/node-%E2%89%A5%2022.19-339933?logo=node.js&logoColor=white)](https://nodejs.org)

[English](README.md) | **简体中文**

Feishu Agent 是构建在 Pi 公共 SDK 与 TUI 之上的可执行薄壳，用于飞书交付和 `lark-cli` 工作流。它不是 Pi 的 fork，也不是通用编码 agent。资源隔离不是操作系统级沙箱。

## 能做什么

Feishu Agent 通过自然语言驱动飞书/Lark 工作，底层是 28 个官方 `lark-cli` 技能（消息、文档、日历、多维表格、审批等）。可以用来：

- **收发与管理消息**——发群聊、回帖子、传文件、处理交互卡片，作为飞书机器人运行（`lark-im`）；无需手写集成代码即可搭一个飞书/Lark 聊天机器人。
- **自动化文档与文件**——创建和编辑飞书文档 Docx、电子表格、幻灯片和云盘文件（`lark-doc`、`lark-sheets`、`lark-slides`、`lark-drive`）。
- **跑工作流自动化**——总结会议与妙记、起草站会日报、脚本化多步飞书流程（`lark-workflow-*`、`lark-meeting`、`lark-minutes`）。
- **管理日历与审批**——查日程、订会议室、处理审批待办（`lark-calendar`、`lark-approval`）。
- **操作多维表格 Base**——在飞书多维表格里建表、字段、记录、视图和仪表盘（`lark-base`）。
- **跨会话记忆**——基于 Mem0 的项目级长期记忆；密钥与原始工具输出不进入捕获。
- **编写自己的技能**——把可复用的飞书流程沉淀为私有技能（`feishu-skill-maker`）。
- **用包扩展能力**——通过 Pi 兼容扩展接入 MCP 服务、联网检索和子代理。

高风险操作（删除、撤回、`/share`）需要显式一次性审批；模糊或链式的破坏性命令会被拦截。

## 安装

Feishu Agent 以源码方式运行 CLI，**未发布到 npm**。

### 前置依赖

- **Node.js ≥ 22.19**
- **[`lark-cli`](https://github.com/larksuite/cli)**——飞书/Lark 官方 CLI，npm 包名 **`@larksuite/cli`**。用 `npm i -g @larksuite/cli` 安装，再执行 `lark-cli auth` 登录，确保 `lark-cli doctor` 通过。
  > 安装的是 `@larksuite/cli`，**不是** npm 上那个字面同名、无关的占位包 `lark-cli`。
- **[Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 编码助手**——`npm i -g @earendil-works/pi-coding-agent`。Feishu 复用 `~/.pi/agent/` 下 Pi 的模型凭证，且禁用了自身的 `/login`，因此需先用普通 `pi` 完成模型认证（`pi auth` 可检查就绪状态）。
- **`MEM0_API_KEY`**（来自 [mem0.ai](https://mem0.ai)）——`feishu init` 初始化长期记忆时必需；只从环境变量读取、绝不落盘；运行时若 Mem0 不可用会优雅降级。

### 构建并链接

```bash
git clone https://github.com/Azhi-ss/feishu-agent.git
cd feishu-agent
npm install
npm run build
npm link          # 得到 `feishu` 命令（或直接用 node dist/src/cli.js 运行）
```

## 初始化

```bash
MEM0_API_KEY=... feishu init --identity stable-name --model provider/model --thinking medium
```

初始化会在 `~/.feishu-agent/` 下创建私有状态；首次初始化需要显式选择一个已认证的飞书模型；保存一个仅 Feishu 使用的思考等级偏好；验证 Mem0 连通性但不打印密钥；安装未加修改的 Mem0 包；同步官方 `lark-cli` Skills；并在所选 profile 下运行 `lark-cli doctor`。重复运行只补齐缺失状态，不会覆盖身份、模型或自定义 `SYSTEM.md`。需要显式替换时使用 `--reset-identity`、`--reset-model`、`--reset-system`。

## 运行

```bash
feishu                    # 交互式 Feishu Runtime
feishu -p "任务"          # 单次 Print 模式
feishu -c                 # 继续当前 Feishu Project 的最近会话
feishu -r                 # 在当前 Feishu Project 中选择会话
feishu --session <id>     # 精确恢复当前 Feishu Project 中的某个会话
feishu --lark-profile finance -p "任务"
```

交互式正常退出时，会把 Pi 的通用恢复提示改写为 `To resume this Feishu session: feishu --session <id>`；复制该命令即可精确恢复对应会话。最新会话用 `feishu -c`，手动选择用 `feishu -r`。如果 `feishu` 不在 PATH 中，可用 `FEISHU_RESUME_COMMAND` 指定完整可执行路径。不要用普通 `pi --session-dir ... --session ...` 恢复 Feishu 会话——那会绕过 Feishu Runtime 边界。

Feishu Runtime 会关闭 Pi 内置的启动期网络检查，因此你永远不会看到 Pi 的 `pi update` 版本提示或 `pi update --extensions` 包更新提示：升级 Pi 或扩展是独立、有意的外部操作。

只支持交互式和文本 Print 模式。刻意不提供 JSON 和 RPC 模式。

## 包与 Skills

### 默认（开箱即得）

`feishu init` 搭建的是最小运行时。预装内容只有：

| 能力 | 来源 | 说明 |
|---|---|---|
| 长期记忆 | `@mem0/pi-agent-plugin`（钉版本，由 `feishu init` 自动安装） | 按 Project 语义化捕获用户/助手文本；`MEM0_API_KEY` 只走环境变量 |
| 核心策略守卫 | 内置（隐藏的 `feishu-core-policy` 扩展） | 高危 `lark-cli --yes` 审批守卫；拦截 `/share` `/import` `/login` `/logout` |
| Skill 编写引导 | 内置 `feishu-skill-maker` skill | 创建新 Feishu Skill 的规范指引 |
| 官方飞书 Skills | 本地 `lark-cli` 的只读缓存（28 个：lark-im、lark-doc、lark-calendar……） | 按 CLI 版本作 key，惰性同步；用 `feishu skills sync` 刷新 |
| 核心工具 | `read` `edit` `write` `bash` `grep` `find` `ls` | 第三方包无法替换这些名字 |

主题和 prompt 模板不打包；需要时通过包加载。

### 可选推荐包

兼容 Pi 的扩展包用 `feishu install npm:<包名>` 安装。Feishu **不会**自动安装任何一个——按机器/项目自行开启。下表全部是真实的、兼容 `pi-coding-agent` 的 npm 包；钉版本前用 `npm view <包名>` 确认当前版本。

| 包 | 增加的能力 | 什么时候装 |
|---|---|---|
| `pi-web-access` | 网页搜索、URL 抓取、GitHub 仓库克隆、PDF 提取、YouTube/视频理解；可接多种后端（Tavily、Firecrawl、Jina、Exa、Gemini、Kimi、SearXNG……） | **最推荐**——当 Feishu 需要读在线文档、查飞书 API 参考、或抓取链接时 |
| `pi-mcp-adapter` | 把 MCP（Model Context Protocol）server 作为工具使用 | 你已经有 MCP server（或需要某厂商的 MCP 集成） |
| `pi-subagents` | 单代理委派与脚本化多代理工作流 | 长且可并行的飞书任务 |
| `pi-background-tasks` | 持久后台 shell 任务、只读委派代理、本地 attested Pi 运行 | 让长时间运行的 lark-cli 任务在会话结束后继续 |
| `pi-hermes-memory` | 持久记忆 + 会话搜索 + 密钥扫描，token 感知的策略式捕获 | 备选/补充记忆引擎；注意 Feishu 已自带 Mem0 |

```bash
feishu install npm:pi-web-access        # 推荐，全局
feishu install -l npm:pi-mcp-adapter     # 仅当前项目
feishu list
feishu remove npm:pi-subagents
feishu update --extensions
feishu config set npm:pi-web-access extensions off
feishu config -l set ./local-package skills off
feishu skills sync
```

不建议用于 Feishu：`@oh-my-pi/*` 生态的包——它们面向的是另一个 `oh-my-pi`/`omp` agent，而非 `pi-coding-agent`，与本 runtime 不兼容。

全局包位于 `~/.feishu-agent/`；项目包位于 `<git 根目录>/.feishu-agent/`。清单中的 Extensions、Skills、Prompts、Themes 按 Pi 包过滤语义加载：省略类型则全加载，`[]` 表示不加载，glob 排除可收窄，精确 `+path`/`-path` 强制包含/排除。`feishu config` 打开 Feishu 全局设置，`feishu config -l` 打开项目 Feishu 设置；`feishu config [ -l ] set <来源> <资源> <on|off>` 是等价的脚本化开关。隔离的 UI 子进程防止 Pi 的 config 退出行为终止宿主。官方和私有 Feishu Skills 绝不扫描普通 Pi、`.pi`、`.agents`、Codex 或 Claude 的 skill 目录。

## 飞书身份与高危审批

Feishu Agent 复用现有 `lark-cli` 状态，不复制 token。个人资源操作显式使用 `--as user`；仅在被要求或接口要求时使用 Bot 身份。当用户的请求明确无误地说明了破坏性动作、精确目标、用户/机器人身份和影响范围时，会授予一次匹配的 `lark-cli ... --yes` 操作。模糊、链式、扩大范围、被修改或重复的破坏性操作会被拦截；Print 模式会终止而不是提示。该 runtime 守卫不是 OS 安全边界。

## 长期记忆

直接依赖 `mem0ai` 钉在 3.0.8（首个使用 `uuid` 11.1.1 的兼容 3.x 版本）；已安装生产树的 `npm audit --omit=dev` 干净。Mem0 自动捕获用户消息和助手文本，使用防碰撞的 Feishu Project key。原始工具输出不自动捕获；全局记忆需要显式动作。配置的 `feishu:<身份>` 覆盖外部 `MEM0_USER_ID`，`MEM0_API_KEY` 仅环境变量，遥测关闭。启动时做有界健康检查；recall、capture 或 Dream 失败时同时在终端和交互界面发出警告，并在该降级会话中禁用后续记忆动作。之后一次健康的调用会恢复，且不改动无关的 Feishu 设置。

## 离线发布测试矩阵

测试套件编译真实 CLI，只用临时 HOME/项目、PTY 和回环 fake 模型、Mem0、Lark、npm 服务来运行——绝不访问真实网络端点或用户凭证。它验证：

- 全新 HOME 可以跑 `feishu init`、一次即时 Print、一次挂载的 Interactive、带显式 `--as user` 的 fake 个人 Lark 命令、项目本地会话，以及符合条件的用户/助手记忆捕获；
- 恶意的普通 Pi home/项目 `.pi` 和 `.agents` 资源保持不加载，冲突的包核心工具被拒绝并警告，替换 prompt 或自定义 editor 无法替换基础身份或外层命令守卫；
- 两个项目只共享配置的全局 `feishu:<身份>`，会话、私有 Skills、包设置、已加载包 Skills 以及防碰撞 Mem0 app ID 彼此独立；
- Mem0 降级与官方 Skill 回退发出可见警告，同时核心文件、Bash、Lark、Print、Interactive 工作继续；
- 递归产物与诊断扫描拒绝 Mem0 密钥和被复制的 Lark token，原始工具输出保持本地在会话中，且不被自动 Mem0 捕获。

## 隔离与限制

资源隔离阻止自动加载其他 agent 的内容；但不限制文件系统、子进程、扩展或网络权限。已安装的 Feishu 包扩展以当前用户权限执行。Feishu Agent 不复制 Lark/模型 token，不支持会话分享/导入，也不接受无关的通用软件开发工作——那请使用普通 `pi`。
