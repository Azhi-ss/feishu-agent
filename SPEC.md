# Feishu Agent 技术设计规范

## Problem Statement

当前通用 Pi Coding Agent 会自动发现并加载普通 Pi、Codex、`.agents/` 以及项目 `.pi/` 中的资源，模型配置、插件、Skills、提示词、会话和长期记忆容易互相污染。用户需要一个以 `feishu` 为唯一入口的专用飞书助手：它保留 Pi 的模型、会话树、压缩、TUI 和基础文件/命令能力，但资源加载、包管理、项目上下文、会话和 Mem0 长期记忆必须属于独立的 Feishu Agent 边界。

这个助手不是通用 Coding Agent。它可以读取项目代码、实验记录、Git 历史和进展，也可以修改服务于飞书交付的草稿、XML、Markdown、脚本或配置；但与飞书工作流无关的普通开发、重构和调试应转交普通 `pi`。

## Solution

构建一个名为 `feishu` 的独立薄壳，直接组合 Pi 的公开 SDK、`AgentSessionRuntime`、Interactive TUI 和 Print Runner，不 Fork Pi 源码。

Feishu Agent 使用独立的 `~/.feishu-agent/` 作为 Agent Home，自定义 ResourceLoader 只加载明确允许的 Feishu 资源。模型提供商凭证只读复用普通 Pi 的认证文件，但默认模型、设置、包、Skills、提示词、会话和长期记忆全部隔离。

长期记忆使用 `@mem0/pi-agent-plugin`。`feishu init` 自动安装和配置该包，启用项目级自动学习；自动捕获用户消息和 Assistant 文本回复，不捕获原始工具结果。Mem0 不可用时 Feishu Agent 降级运行而不是拒绝启动。

Feishu Agent 暴露 Pi 的基础文件和 Shell 工具，飞书操作通过 Bash 直接调用现有 `lark-cli`。现有 `lark-cli` Profile 与登录态继续复用，不复制飞书 Token。

## User Stories

1. 作为飞书重度用户，我希望运行 `feishu` 启动专用助手，从而不把普通 Coding Agent 的能力和记忆混入飞书工作。
2. 作为现有 Pi 用户，我希望 Feishu Agent 复用 Pi SDK 和 TUI，从而继续获得模型切换、会话树、压缩和终端交互体验。
3. 作为维护者，我希望 Feishu Agent 是薄壳而非 Pi Fork，从而可以跟随 Pi 升级而不长期合并上游源码。
4. 作为用户，我希望 `~/.feishu-agent/` 成为独立 Agent Home，从而隔离设置、包、Skills、提示词、会话和 Mem0 状态。
5. 作为用户，我希望 Feishu Agent 只读复用 `~/.pi/agent/auth.json` 和模型目录，从而无需重复登录模型提供商。
6. 作为用户，我希望 Feishu Agent 拥有独立默认模型，从而修改 Feishu 偏好时不影响普通 Pi。
7. 作为新设备用户，我希望 `feishu init` 展示已认证模型并让我选择默认模型，从而完成可预测的首次配置。
8. 作为用户，我希望 Feishu Agent 禁用 `/login` 和 `/logout`，从而不会意外修改普通 Pi 共用的认证状态。
9. 作为用户，我希望通过 `feishu init` 显式设置稳定的 Mem0 Identity，从而跨设备共享同一 Feishu Agent 记忆。
10. 作为用户，我希望 Mem0 Identity 使用独立的 `feishu:<identity>` 命名空间，从而普通 Pi 无法召回 Feishu Agent 的云端记忆。
11. 作为用户，我希望 `MEM0_API_KEY` 只从环境变量读取，从而密钥不写入本地配置文件。
12. 作为用户，我希望 `feishu init` 验证 `MEM0_API_KEY` 可用但不显示其值，从而兼顾可用性和保密性。
13. 作为用户，我希望 Mem0 自动学习每轮用户消息和 Assistant 文本回复，从而长期积累偏好与项目知识。
14. 作为用户，我希望自动学习固定为 Project Scope，从而不同项目的飞书内容不会互相召回。
15. 作为用户，我希望跨项目偏好只能显式写入 Global Scope，从而全局知识不会由普通会话自动扩散。
16. 作为用户，我希望原始 `read`、Bash 和 `lark-cli` 工具输出不被自动上传 Mem0，从而减少飞书正文、邮件和逐字稿的暴露面。
17. 作为用户，我希望 Mem0 暂时不可用时仍可操作飞书和本地文件，从而长期记忆不是启动的单点故障。
18. 作为用户，我希望启动时明确看到 Mem0 降级告警，从而不会误以为本次会话仍在学习和召回。
19. 作为隐私敏感用户，我希望 Feishu Agent 强制设置 `MEM0_TELEMETRY=false`，从而关闭 Mem0 插件的 PostHog 使用遥测。
20. 作为用户，我希望 `feishu init` 自动安装 `@mem0/pi-agent-plugin`，从而不需要额外的手动安装步骤。
21. 作为用户，我希望运行 `feishu install npm:@mem0/pi-agent-plugin` 安装全局 Feishu 包，从而命令语义与 Pi 熟悉习惯一致。
22. 作为项目维护者，我希望运行 `feishu install -l <package>` 安装项目级包，从而项目能力可随项目配置管理。
23. 作为用户，我希望 `feishu list`、`remove`、`update --extensions` 和 `config` 管理 Feishu 包，从而不必使用普通 `pi` 修改它们。
24. 作为用户，我希望普通 `pi list` 看不到 Feishu Agent 的安装记录，从而两个 Agent 的包空间保持隔离。
25. 作为项目维护者，我希望项目级 Feishu 包真实存放在 `<project>/.feishu-agent/`，从而不会污染 `<project>/.pi/`。
26. 作为维护者，我希望兼容适配器复用 Pi 的包管理实现，从而不复制安装、更新和解析逻辑。
27. 作为包使用者，我希望安装包默认加载 Manifest 声明的 Extensions、Skills、Prompts 和 Themes，从而保持完整 Pi Package 语义。
28. 作为包使用者，我希望通过 `feishu config` 按资源类型禁用包内容，从而能收窄已安装包的生效范围。
29. 作为安全负责人，我希望核心工具、基础身份和命令策略不能被第三方 Extension 覆盖，从而已确认的 Feishu 边界始终有效。
30. 作为插件作者，我希望非冲突资源仍可正常加载，从而核心保护不会无谓禁用整个插件。
31. 作为用户，我希望插件冲突被明确告警，从而知道哪些资源被 Feishu 核心策略拒绝或遮蔽。
32. 作为用户，我希望 Feishu Agent 只自动加载官方 `lark-cli` Skills、Feishu 私有 Skills 和 Feishu Packages，从而不会混入 Codex 或其他 Agent 的 Skills。
33. 作为用户，我希望全局私有 Skills 存放在 `~/.feishu-agent/skills/`，从而可以创建跨项目复用的飞书工作流。
34. 作为项目维护者，我希望项目私有 Skills 存放在 `<project>/.feishu-agent/skills/`，从而项目可以定义自己的飞书流程。
35. 作为用户，我希望 Feishu Agent 不扫描 `~/.agents/skills`、`~/.pi/agent/skills`、项目 `.agents/skills` 和 `.pi/skills`，从而避免其他 Agent 资源泄漏进来。
36. 作为用户，我希望每次正常启动先检查并自动安装可用的 `lark-cli` 更新，再同步对应版本的官方 Skills，从而 CLI 能力与 Skill 文档保持一致。
37. 作为用户，我希望 CLI 已是最新版时复用缓存，从而启动无需重复导出所有 Skills。
38. 作为用户，我希望更新检查、自动更新或同步失败时回退当前 CLI/最近成功缓存并显示告警，从而网络或安装问题不阻塞启动。
39. 作为离线用户，我希望 `PI_OFFLINE=1` 跳过更新检查，同时仍可执行 `feishu skills sync` 强制刷新本地 CLI 暴露的官方 Skills，从而离线运行和缓存修复都可控。
40. 作为用户，我希望同名 Skill 使用“项目私有 > 全局私有 > 安装包 > 官方缓存”的确定优先级，从而覆盖行为可预测。
41. 作为用户，我希望启动时列出所有被遮蔽的 Skill 来源，从而覆盖不能静默发生。
42. 作为用户，我希望全局 `~/.feishu-agent/SYSTEM.md` 定义不可替换的 Feishu Agent 身份，从而项目和插件不能改变助手的根本职责。
43. 作为项目维护者，我希望 `<project>/.feishu-agent/AGENTS.md` 追加 Feishu 专用项目规则，从而定制项目工作流。
44. 作为项目维护者，我希望项目根目录 `AGENTS.md` 也自动加入上下文，从而复用已有项目约束。
45. 作为用户，我希望 Feishu Agent 忽略其他 Agent 的全局提示词和项目 `.pi`、`.agents` 上下文，从而保持身份隔离。
46. 作为用户，我希望项目 `.feishu-agent/` 和根 `AGENTS.md` 自动加载而不额外弹出信任门禁，从而减少重复确认。
47. 作为用户，我希望 Feishu Agent 提供 `read`、`edit`、`write`、`bash`、`grep`、`find` 和 `ls`，从而能准备飞书交付所需的本地材料。
48. 作为用户，我希望 Bash 能运行现有项目工具链和 `lark-cli`，从而无需额外的专用 CLI 包装工具。
49. 作为用户，我希望 Agent 可以读取项目代码、Git 历史、实验记录和进展，从而基于真实项目状态生成飞书内容。
50. 作为用户，我希望 Agent 可以修改直接服务于飞书交付的草稿、XML、Markdown 和辅助脚本，从而完成端到端工作流。
51. 作为用户，我希望与飞书无关的普通开发请求被转交普通 `pi`，从而 Feishu Mem0 不学习大量无关编码内容。
52. 作为用户，我希望个人飞书资源操作默认显式使用 `--as user`，从而调用者身份明确。
53. 作为用户，我希望只有在我要求或接口强制时使用 `--as bot`，从而不会悄悄切换操作者。
54. 作为用户，我希望 Feishu Agent 复用已有 `lark-cli` Profile 和登录态，从而不需要重复飞书授权。
55. 作为用户，我希望可通过启动参数指定其他 `lark-cli` Profile，从而在多个应用配置间切换。
56. 作为用户，我希望 Feishu Agent 不复制任何飞书 Token 到 Agent Home，从而降低凭证扩散风险。
57. 作为用户，我希望明确请求某个准确的高风险飞书操作时，Agent 可以直接携带 `--yes`，从而不重复询问同一意图。
58. 作为用户，我希望目标、身份或影响范围不明确时仍停下确认，从而破坏性意图不能被推断。
59. 作为用户，我希望一次高风险批准只适用于该准确操作，从而不能扩展成其他删除或撤回动作。
60. 作为用户，我希望 Feishu Project 以 Git Root 识别，从而从仓库任意子目录启动都共享配置、Skills、会话与 Mem0 Scope。
61. 作为非 Git 目录用户，我希望启动目录回退为 Feishu Project，从而仍能正常使用专用 Agent。
62. 作为用户，我希望运行时工作目录保持 `feishu` 的启动目录，从而相对路径符合当前终端位置。
63. 作为用户，我希望项目身份和运行时工作目录分离，从而 Monorepo 可共享项目资源但保留子目录操作上下文。
64. 作为用户，我希望会话集中存放在 `~/.feishu-agent/sessions/<project-key>/`，从而不会把飞书对话误提交进仓库。
65. 作为用户，我希望 `feishu --session <id>` 精确恢复当前 Feishu Project 中该会话，`feishu -c` 只继续最近的会话，从而不会串到其他项目；退出提示不得引导用户绕过专用 Runtime 直接运行 `pi --session-dir ... --session ...`。
66. 作为用户，我希望 `/resume` 只浏览当前项目会话，从而会话选择范围明确。
67. 作为用户，我希望普通 Pi 的 `/resume` 看不到 Feishu Agent 会话，从而会话空间隔离。
68. 作为用户，我希望 `feishu` 提供完整 Interactive TUI，从而可以进行持续的飞书工作。
69. 作为自动化用户，我希望 `feishu -p "任务"` 单次运行并退出，从而可用于简单脚本。
70. 作为用户，我希望 Print 模式无法交互确认时明确失败而不是挂起，从而自动化行为可预测。
71. 作为用户，我希望首版不包含 JSON 和 RPC 模式，从而实现范围保持最小。
72. 作为用户，我希望 `/share` 被提交前拦截，从而不能误把飞书会话上传为 GitHub Gist。
73. 作为用户，我希望 `/import` 被提交前拦截，从而外部会话不能污染 Feishu 会话和自动记忆。
74. 作为用户，我接受禁用命令仍可能出现在 Pi 原生自动补全中，从而无需为此 Fork 或重写整套 TUI。
75. 作为用户，我希望本地 `/export` 仍可用，从而可以人工检查和脱敏后再处理会话。
76. 作为用户，我希望 `/new`、`/resume`、`/tree`、`/fork`、`/clone` 和 `/compact` 仍可用，从而保留 Pi 的本地会话能力。
77. 作为用户，我希望 `feishu init` 创建 Agent Home、系统提示词、默认配置、Mem0 设置和 Skills 缓存，从而一次初始化即可使用。
78. 作为用户，我希望 `feishu init` 执行 `lark-cli doctor`，从而提前发现飞书配置或连接问题。
79. 作为用户，我希望初始化检查复用的 Pi 模型认证，从而在进入 TUI 前发现无可用模型。
80. 作为用户，我希望初始化可重复执行且不会覆盖已有身份、模型和自定义系统提示词，除非我明确选择重置，从而配置不会意外丢失。

## Implementation Decisions

### 1. Runtime shape

- 构建独立的 `feishu` 可执行薄壳，使用 Pi 公共 SDK，不维护 Pi 源码 Fork。
- Interactive 模式组合 `AgentSessionRuntime` 与 Pi `InteractiveMode`；Print 模式使用 Pi 的单次输出 Runner。
- 首版只支持 Interactive 与 Print；JSON、RPC 不实现。
- Feishu 核心策略作为最终组合层，在第三方包资源加载后重新施加，防止 Extension 替换核心边界。

### 2. Agent Home and environment

- Feishu Agent Home 固定为 `~/.feishu-agent/`。
- 普通 Pi 的 Agent Home 不参与 Feishu Settings、Packages、Skills、Prompts、Themes、Sessions 或 Memory 的发现。
- 进程设置独立 Agent 标识，但普通 Bash 和子进程仍继承用户真实 `HOME`、`PATH`、SSH、Git 和 `lark-cli` 环境。
- Mem0 等写死 `~/.pi/agent` 的第三方 Extension 通过兼容 Home 初始化：仅在模块加载和 Extension Factory 初始化边界临时切换 `HOME`，使其看到隔离路径；完成后恢复真实 `HOME`。
- 兼容 Home 必须映射到 `~/.feishu-agent/`，不得复制密钥或生成第二套用户主目录。
- 必须验证 Extension 是否在初始化后缓存所有 Home 派生路径；若其在后续 Hook 中重新调用 `os.homedir()`，兼容层需升级为 Extension 专用子进程或其他隔离执行方式，而不能永久修改全进程 `HOME`。

### 3. Model authentication and defaults

- 模型凭证与模型 Catalog 从普通 Pi 路径只读复用。
- Feishu Settings 独立保存默认 Provider、Model、Thinking Level 等偏好。
- `feishu init` 必须从当前已认证模型列表中显式选择默认模型。
- `/model` 可切换当前会话模型；Feishu 默认模型变更不得修改普通 Pi 默认值。
- Feishu Editor 拦截 `/login` 和 `/logout`；认证变更通过普通 Pi 完成。

### 4. Project and cwd model

- Feishu Project 优先使用 `git rev-parse --show-toplevel`；失败时使用启动目录。
- Project Root 用于项目 Settings、Packages、Skills、项目说明、Session 分区和 Mem0 `app_id`。
- Runtime CWD 保持用户启动 `feishu` 时的目录；文件工具与 Bash 相对路径基于该目录。
- 从会话池恢复会话时，默认采用当前启动目录作为本次 Runtime CWD，并对“会话原创建目录与当前目录不同”显示提示。该默认值闭合了 Grilling 中最后一个非阻塞遗漏，并保持“启动目录优先”的既有原则。
- Session Header 仍保留原创建目录用于审计；恢复时不删除或篡改历史值。

### 5. ResourceLoader

- 使用自定义 ResourceLoader，不调用 Pi 默认全局/项目自动发现。
- 只加载以下来源：
  1. 当前 `lark-cli` 版本对应的官方 Skill 缓存；
  2. 已启用 Feishu Packages；
  3. `~/.feishu-agent/skills/`；
  4. `<project>/.feishu-agent/skills/`；
  5. 全局 `~/.feishu-agent/SYSTEM.md`；
  6. `<project>/.feishu-agent/AGENTS.md`；
  7. `<project>/AGENTS.md`。
- 不加载 `.agents/skills`、`.pi/skills`、普通 Pi Prompts/Themes/Extensions、Codex/Claude Skills 或其他 Agent Home。
- 项目 Feishu 资源和根 `AGENTS.md` 自动加载，不走 Pi 项目信任提示。
- 全局 `SYSTEM.md` 是基础身份，项目说明和 Extension 只能追加，不能替换。

### 6. Skill synchronization and precedence

- Interactive、Print 与 `feishu init` 的正常启动先执行 `lark-cli update --json`；若 CLI 报告 `updated`，后续同步必须读取更新后的二进制版本。
- `already_up_to_date` 静默继续；`manual_required`、网络失败、安装失败或无法解析的响应以 `Startup Warning` 告警并继续使用已安装版本，不得阻塞 Feishu Runtime。
- `PI_OFFLINE=1` 跳过启动更新检查；显式管理命令（例如 `feishu skills sync`）不受此开关改写。
- 随后读取 `lark-cli --version`，缓存目录以完整 CLI 版本命名。
- 当前版本缓存完整且带成功标记时直接复用。
- 版本变化时，通过 `lark-cli skills list/read` 导出官方 Skills 到临时目录，完成校验后原子移动到版本缓存目录。
- 同步失败时使用最近一次成功版本并产生 Startup Warning；不存在任何成功缓存时仍可启动，但必须明确报告官方 Skills 不可用。
- `feishu skills sync` 忽略已有缓存并强制同步；即使 CLI 版本未变化也可主动修复缓存。
- 同名 Skill 按“项目私有 > 全局私有 > 安装包 > 官方缓存”解析。
- 每次启动输出冲突诊断，列出最终来源与所有被遮蔽路径。

### 7. Package management

- `feishu install`、`remove`、`list`、`update`、`config` 复用 Pi 的 Package Manager 与 Settings 数据结构。
- 全局 Package Manager 使用 `~/.feishu-agent/` 作为 `agentDir`。
- 项目级真实存储固定为 `<project>/.feishu-agent/`。
- 由于 Pi Package Manager 将项目目录硬编码为 `.pi`，使用 `~/.feishu-agent/.compat/projects/<project-key>/` 作为兼容 CWD，并使其 `.pi` 解析到真实项目 Feishu 目录。
- 自定义 SettingsStorage 负责真实全局与项目 Settings 文件；兼容路径只服务于 Pi 内部目录假设。
- 项目路径映射应优先使用受控 Symlink；Windows 或不支持 Symlink 的环境应明确判定为暂不支持或使用 Junction，不得静默复制两份 Package 状态。
- `feishu install` 默认全局，`-l` 表示项目级。
- 安装包默认启用 Manifest 声明的 Extensions、Skills、Prompts 和 Themes。
- `feishu config` 可按资源类型收窄包资源。
- 普通 Pi 不应发现或列出 Feishu Packages。

### 8. Core policy precedence

- 保留内置工具名：`read`、`edit`、`write`、`bash`、`grep`、`find`、`ls`。
- 第三方 Extension 注册同名工具时，核心工具保留，冲突来源产生 Warning；插件其他资源继续加载。
- Extension 可追加 System Prompt，但不得替换全局基础身份。
- Extension 可请求自定义 Editor，但 Feishu Command Policy Editor 必须作为最外层提交拦截器。
- 核心策略应用必须在初始加载和 `/reload` 后都重新执行。

### 9. Tool capability and domain boundary

- 启用 Pi 的基础文件工具与 Bash。
- Bash 可运行项目工具链、Git 和 `lark-cli`；不提供额外 `lark_cli` Tool。
- System Prompt 明确：飞书操作优先使用 `lark-cli` Shortcut，陌生命令先查 `--help` 或 `schema`。
- Agent 可以检查项目材料或编写辅助代码，但必须直接服务于飞书交付或 `lark-cli` 工作流。
- 与飞书无关的普通开发请求返回简洁转介，建议使用普通 `pi`。
- 资源加载隔离不是 OS Sandbox；Bash 仍拥有当前用户权限，这一点必须在文档和启动帮助中明确。

### 10. Lark identity and profile

- 复用现有 `lark-cli` 配置、Token、Profile 和默认身份，不向 Feishu Agent Home 复制凭证。
- 支持启动参数覆盖 `lark-cli` Profile；实现方式是在 Feishu 启动进程环境中设置或在生成命令规范中持续携带 Profile，不能修改用户全局默认 Profile。
- 个人资源默认显式使用 `--as user`。
- 只有用户明确指定 Bot 或 CLI/接口要求 Bot 时才使用 `--as bot`。
- `feishu init` 执行 `lark-cli doctor` 并报告失败项。

### 11. High-risk Lark operations

- 若用户当前请求已经明确给出准确的破坏性动作、目标、身份和范围，该请求视为一次 High-risk Approval，Agent 可直接为该命令加入 `--yes`。
- 若上述任一信息不明确，首次执行不得猜测批准；由 `lark-cli` Confirmation Gate 或 Agent 主动确认暂停流程。
- 批准只绑定当前准确操作，不得复用于不同目标、扩展范围或后续命令。
- System Prompt 与 Feishu 核心 Extension 共同约束此规则；核心 Extension 可审计 Bash Tool Call，但不能声称构成 OS 级安全边界。
- Print 模式缺少交互时，未预先明确批准的 High-risk Write 必须返回非零退出码与可读错误，不等待输入。

### 12. Long-term memory

- 默认安装 `@mem0/pi-agent-plugin`，不自研 Memory Backend。
- 配置：`autoCapture=true`、`defaultScope=project`、`contextInjection=true`。
- `MEM0_API_KEY` 只从进程环境读取，不写入文件、不打印、不进入日志或 Session。
- `feishu init` 显式采集稳定身份并写成 `feishu:<identity>`；运行时强制该 `userId`，不允许外部 `MEM0_USER_ID` 覆盖造成串库。
- 自动捕获采用插件默认语义：仅用户消息和 Assistant 文本回复，不包含 Tool Result。
- 自动捕获固定 Project Scope；Global Memory 只能由显式 Memory 命令或 Tool Action 写入。
- 强制为 Feishu 进程设置 `MEM0_TELEMETRY=false`。
- Mem0 加载、健康检查、召回或捕获失败时产生显式 Warning，但不得使 Runtime 创建失败。
- 降级会话中禁用或跳过本轮 Memory Capture、Recall 和 Dream；其他工具继续工作。
- 不修改第三方包源码；升级继续使用原始 npm 包。

### 13. Session storage and commands

- Sessions 集中存放在 `~/.feishu-agent/sessions/<project-key>/`。
- `project-key` 必须由规范化 Project Root 稳定生成，避免同名路径冲突；建议使用可读 Slug 加短哈希。
- `feishu --session <id>` 只在当前 Project 分区内按完整或唯一前缀 ID 查找并恢复会话；不存在时明确失败，不搜索其他 Project。
- `feishu -c` 和 `/resume` 默认只查看当前 Project 分区。
- 正常退出持久化 Interactive 会话时，外层 Feishu Runtime 将 Pi 的通用 `To resume this session: pi --session-dir ... --session ...` 提示改写为 `To resume this Feishu session: feishu --session <id>`；如果 `feishu` 不在 PATH，则使用 `FEISHU_RESUME_COMMAND` 指定的可执行文件；不得建议用户直接用普通 Pi 打开 Feishu Session。
- Interactive 模式保留 `/new`、`/resume`、`/tree`、`/fork`、`/clone`、`/compact`、`/export`。
- Feishu Command Policy Editor 在提交前拒绝 `/share`、`/import`、`/login`、`/logout` 及其参数形式，并显示明确原因。
- Pi 自动补全仍可能展示禁用命令；首版接受此限制。
- 禁用内置命令仅防误用，不限制 Bash 的网络或文件能力。

### 14. Initialization

- `feishu init` 是幂等引导流程，负责：
  1. 创建 Agent Home 和必要子目录；
  2. 初始化默认 `SYSTEM.md`；
  3. 要求用户显式输入稳定 Memory Identity；
  4. 检查 `MEM0_API_KEY` 是否存在并验证连接，但不显示值；
  5. 自动安装 `@mem0/pi-agent-plugin`；
  6. 写入非敏感 Mem0 配置；
  7. 写入独立 Feishu Settings 和默认模型；
  8. 强制关闭 Mem0 Telemetry；
  9. 同步官方 Skills；
  10. 执行 `lark-cli doctor`；
  11. 验证至少一个模型凭证可用。
- 已存在配置不得被静默覆盖；重新执行时显示当前值并只补齐缺失项。
- 重置 Identity、默认模型或 `SYSTEM.md` 必须使用显式重置选项。

### 15. CLI surface

首版命令面：

- `feishu`
- `feishu -p <prompt>`
- `feishu init`
- `feishu install <source> [-l]`
- `feishu remove <source> [-l]`
- `feishu list`
- `feishu update [source|--extensions]`
- `feishu config`
- `feishu skills sync`
- `feishu -c`
- `feishu -r`
- `feishu --session <id>`
- `feishu --lark-profile <profile>`

CLI 参数只实现上述需求，不追求 Pi CLI 的完整参数兼容。

## Testing Decisions

### Test philosophy

- 测试外部可观察行为，不断言内部私有字段或 Pi 的实现细节。
- 最高测试缝是“以临时 HOME、临时项目和 Fake `lark-cli`/Mem0 环境运行真实 `feishu` 命令”。优先用这一条端到端 CLI 缝覆盖初始化、发现、安装、隔离和启动诊断。
- 只有无法稳定通过 CLI 观察的纯路径解析、优先级和命令判定逻辑，才补少量模块级测试。
- 不为每个函数创建单测；每个非平凡策略至少有一个会失败的行为测试。

### Modules and behaviors

1. **Project resolver**
   - Git 子目录解析为同一 Project Root；Runtime CWD 仍是启动目录。
   - 非 Git 目录回退启动目录。
   - 路径规范化和 Project Key 在重启后稳定。

2. **Resource loader**
   - 只加载四类 Skill 来源与两类项目说明文件。
   - 明确证明 `.agents`、`.pi`、普通 Pi Agent Home 不被加载。
   - 同名 Skill 按既定优先级选择并输出遮蔽诊断。
   - 基础 `SYSTEM.md` 不能被项目或 Extension 替换。

3. **Official Skill cache and startup update**
   - 正常启动先执行 `lark-cli update --json`；可自动安装的版本必须在 Skill 导出前生效。
   - 已是最新版、更新成功、手工安装提示、更新失败与 `PI_OFFLINE=1` 跳过路径均有行为测试。
   - 首次版本同步、缓存复用、版本变化、原子发布、同步失败回退和无缓存告警。
   - `feishu skills sync` 强制刷新。

4. **Package commands**
   - 全局安装写入 Feishu Agent Home。
   - `-l` 写入真实项目 `.feishu-agent/`，不产生真实 `.pi/`。
   - `list/remove/update/config` 仅影响 Feishu Settings。
   - 普通 Pi Fixture 看不到 Feishu 包。
   - Manifest 全资源加载和过滤行为与 Pi Package 语义一致。

5. **Compatibility Home**
   - Mem0 模块加载和初始化看到隔离 Home。
   - 初始化后真实 `HOME` 恢复。
   - Bash 子进程看到真实 Home。
   - Mem0 Config、Dream Lock、Telemetry ID 全部落在 Feishu Agent Home。

6. **Memory behavior**
   - 自动捕获用户与 Assistant 文本，不捕获 Tool Result。
   - 使用稳定 `feishu:<identity>` 和 Project Scope。
   - 外部 `MEM0_USER_ID` 不能覆盖配置身份。
   - `MEM0_API_KEY` 不出现在配置、日志、Session 和错误信息中。
   - `MEM0_TELEMETRY=false` 被强制设置。
   - Mem0 故障时 Runtime 可用并产生降级诊断。

7. **Model behavior**
   - 可从共享认证读取可用模型。
   - Feishu 默认模型独立保存。
   - `/login`、`/logout` 被拦截且共享认证文件不变化。
   - `/model` 不应修改普通 Pi 默认设置。

8. **Command policy editor**
   - 精确拦截 `/share`、`/import ...`、`/login ...`、`/logout`。
   - 不误拦截普通文本中提到这些字符串。
   - `/export` 和本地会话命令继续生效。
   - 第三方自定义 Editor 存在时，外层策略仍执行。
   - `/reload` 后策略仍生效。

9. **Core tool precedence**
   - 恶意 Fixture Extension 尝试覆盖 `bash` 或 `read` 时，核心实现仍被使用并产生 Warning。
   - Extension 其他非冲突工具仍可用。
   - Extension 尝试替换 System Prompt 或 Editor 时，基础身份和外层命令策略仍保留。

10. **Lark behavior**
    - 复用现有 Profile，不复制 Token。
    - Profile Override 不修改用户默认 Profile。
    - System Prompt 要求默认 `--as user`，明确 Bot 场景允许 `--as bot`。
    - 已明确的准确 High-risk 请求可直接携带 `--yes`；模糊请求必须确认。
    - Print 模式下未批准的高风险操作快速失败。

11. **Sessions**
    - 当前 Project 会话隔离于其他 Project 和普通 Pi。
    - 从不同子目录恢复时采用当前启动 CWD，并显示原会话 CWD 提示。
    - 持久化 Interactive 会话的 Feishu 退出提示为 `feishu --session <id>`，精确恢复只查当前 Project 分区，不把普通 Pi 命令作为恢复入口；`feishu` 不在 PATH 时显示 `FEISHU_RESUME_COMMAND`。
    - 会话文件不出现在项目目录。

12. **Initialization**
    - 全新 HOME 一次初始化成功。
    - 缺少 API Key、无模型、`lark-cli doctor` 失败时输出精确诊断。
    - 重复初始化幂等，不覆盖已有配置。
    - 显式重置选项才改变 Identity、模型或 System Prompt。

### Prior art

- Pi SDK 的 `createAgentSessionRuntime`、Custom ResourceLoader、Package Manager、Settings Storage、Custom Editor 和 Extension Gate 示例作为行为参考。
- Pi 自身 SDK 示例中的 Full Control 配置作为不自动发现资源的参考。
- `@mem0/pi-agent-plugin` 的现有命令、自动捕获和 Scope 行为作为兼容基线；测试应使用 Fake Client 或网络拦截，不访问真实 Mem0 数据。

## Out of Scope

- Fork 或修改 Pi Core。
- 修改、Patch 或维护 `@mem0/pi-agent-plugin` Fork。
- JSON 与 RPC 运行模式。
- OS Sandbox、容器或 VM 级文件隔离。
- 禁止 Bash 网络访问或阻止用户主动读取其他 Agent 文件。
- 从 Pi 自动补全列表彻底删除禁用命令。
- 自动捕获 `lark-cli`、Bash 或文件工具的原始输出。
- 全局自动记忆。
- 普通通用编码、独立 Bug 修复或与飞书交付无关的重构。
- 将 Session 存入项目仓库。
- 自动推断 Mem0 Identity。
- 在 Feishu Agent 内管理模型登录凭证。
- 首版跨平台完整支持；项目包兼容 Symlink/Junction 的 Windows 行为需单独验收。
- 自定义飞书 API Client 或替代 `lark-cli`。

## Further Notes

### Security and privacy

- 自动加载项目 `.feishu-agent/` 与根 `AGENTS.md` 是明确接受的 Prompt Injection 风险；本系统只有资源加载隔离，没有 OS 权限隔离。
- 第三方 Pi Package Extension 具有当前用户权限。`feishu install` 即表示信任包声明的可执行资源。
- 禁用 `/share`、`/import` 只减少误操作，不阻止 Bash、GitHub CLI、Curl 或其他程序外传数据。
- 自动记忆仍会将用户与 Assistant 对话发送给 Mem0 Cloud；原始工具输出默认不发送。
- 本地 Session 可能包含飞书敏感信息，必须保持在 Feishu Agent Home，并依赖用户文件权限保护。

### Resolved final default

Grilling 结束时唯一尚未显式回答的问题是“恢复会话时当前启动目录还是原会话目录优先”。它不是阻塞架构的问题，已按此前连续确认的原则收敛为：**当前启动目录优先，Project Root 仍负责资源、会话池和 Memory Scope；启动时提示原会话目录差异。**

### Delivery status

- The repository is hosted at `https://github.com/Azhi-ss/feishu-agent`; implementation tickets and verification history are recorded in `docs/agents/overnight-log.md`.
