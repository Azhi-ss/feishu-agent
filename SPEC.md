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
36. 作为用户，我希望官方 `lark-cli` Skills 按 CLI 版本惰性同步，从而 Skill 文档和当前 CLI 能力一致。
37. 作为用户，我希望 CLI 版本未变化时复用缓存，从而启动无需重复导出所有 Skills。
38. 作为用户，我希望同步失败时回退最近一次成功缓存并显示告警，从而网络或 CLI 局部故障不阻塞启动。
39. 作为用户，我希望执行 `feishu skills sync` 强制刷新官方 Skills，从而可以主动修复缓存。
84. 作为用户，我希望 `feishu skills sync --update` 一条命令先升级 lark-cli 再按新版本重建官方 Skills，从而不必手动串两条命令；且该联网升级只在我显式调用时发生，启动与 init 永不自动升级。
40. 作为用户，我希望同名 Skill 使用“项目私有 > 全局私有 > 安装包 > 官方缓存”的确定优先级，从而覆盖行为可预测。
41. 作为用户，我希望启动时列出所有被遮蔽的 Skill 来源，从而覆盖不能静默发生。
42. 作为用户，我希望在 Feishu Agent 中用 `/find-skill <query>` 搜索公开 Skill 目录，并在确认后把选中的 Skill 安装到 Feishu 私有目录，从而不污染普通 Pi 或其他 Agent。
43. 作为用户，我希望 `/find-skill` 安装前显示来源、安装量、声明的许可证和目标路径，并要求交互确认，从而能先审阅第三方 Skill 的基本 provenance。
44. 作为用户，我希望 Print/无人值守模式的 `/find-skill` 只支持搜索而不执行需要确认的安装，从而不会因网络或确认提示挂起。
45. 作为用户，我希望全局 `~/.feishu-agent/SYSTEM.md` 定义不可替换的 Feishu Agent 身份，从而项目和插件不能改变助手的根本职责。
46. 作为项目维护者，我希望 `<project>/.feishu-agent/AGENTS.md` 追加 Feishu 专用项目规则，从而定制项目工作流。
47. 作为项目维护者，我希望项目根目录 `AGENTS.md` 也自动加入上下文，从而复用已有项目约束。
48. 作为用户，我希望 Feishu Agent 忽略其他 Agent 的全局提示词和项目 `.pi`、`.agents` 上下文，从而保持身份隔离。
49. 作为用户，我希望项目 `.feishu-agent/` 和根 `AGENTS.md` 自动加载而不额外弹出信任门禁，从而减少重复确认。
50. 作为用户，我希望 Feishu Agent 提供 `read`、`edit`、`write`、`bash`、`grep`、`find` 和 `ls`，从而能准备飞书交付所需的本地材料。
51. 作为用户，我希望 Bash 能运行现有项目工具链和 `lark-cli`，从而无需额外的专用 CLI 包装工具。
52. 作为用户，我希望 Agent 可以读取项目代码、Git 历史、实验记录和进展，从而基于真实项目状态生成飞书内容。
53. 作为用户，我希望 Agent 可以修改直接服务于飞书交付的草稿、XML、Markdown 和辅助脚本，从而完成端到端工作流。
54. 作为用户，我希望与飞书无关的普通开发请求被转交普通 `pi`，从而 Feishu Mem0 不学习大量无关编码内容。
55. 作为用户，我希望个人飞书资源操作默认显式使用 `--as user`，从而调用者身份明确。
56. 作为用户，我希望只有在我要求或接口强制时使用 `--as bot`，从而不会悄悄切换操作者。
57. 作为用户，我希望 Feishu Agent 复用已有 `lark-cli` Profile 和登录态，从而不需要重复飞书授权。
58. 作为用户，我希望可通过启动参数指定其他 `lark-cli` Profile，从而在多个应用配置间切换。
59. 作为用户，我希望 Feishu Agent 不复制任何飞书 Token 到 Agent Home，从而降低凭证扩散风险。
60. 作为用户，我希望明确请求某个准确的高风险飞书操作时，Agent 可以直接携带 `--yes`，从而不重复询问同一意图。
61. 作为用户，我希望目标、身份或影响范围不明确时仍停下确认，从而破坏性意图不能被推断。
62. 作为用户，我希望一次高风险批准只适用于该准确操作，从而不能扩展成其他删除或撤回动作。
63. 作为用户，我希望 Feishu Project 以 Git Root 识别，从而从仓库任意子目录启动都共享配置、Skills、会话与 Mem0 Scope。
64. 作为非 Git 目录用户，我希望启动目录回退为 Feishu Project，从而仍能正常使用专用 Agent。
65. 作为用户，我希望运行时工作目录保持 `feishu` 的启动目录，从而相对路径符合当前终端位置。
66. 作为用户，我希望项目身份和运行时工作目录分离，从而 Monorepo 可共享项目资源但保留子目录操作上下文。
67. 作为用户，我希望会话集中存放在 `~/.feishu-agent/sessions/<project-key>/`，从而不会把飞书对话误提交进仓库。
68. 作为用户，我希望 `feishu --session <id>` 精确恢复当前 Feishu Project 中该会话，`feishu -c` 只继续最近的会话，从而不会串到其他项目；退出提示不得引导用户绕过专用 Runtime 直接运行 `pi --session-dir ... --session ...`。
69. 作为用户，我希望 `/resume` 只浏览当前项目会话，从而会话选择范围明确。
70. 作为用户，我希望普通 Pi 的 `/resume` 看不到 Feishu Agent 会话，从而会话空间隔离。
71. 作为用户，我希望 `feishu` 提供完整 Interactive TUI，从而可以进行持续的飞书工作。
72. 作为自动化用户，我希望 `feishu -p "任务"` 单次运行并退出，从而可用于简单脚本。
73. 作为用户，我希望 Print 模式无法交互确认时明确失败而不是挂起，从而自动化行为可预测。
74. 作为用户，我希望首版不包含 JSON 和 RPC 模式，从而实现范围保持最小。
75. 作为用户，我希望 `/share` 被提交前拦截，从而不能误把飞书会话上传为 GitHub Gist。
76. 作为用户，我希望 `/import` 被提交前拦截，从而外部会话不能污染 Feishu 会话和自动记忆。
77. 作为用户，我接受禁用命令仍可能出现在 Pi 原生自动补全中，从而无需为此 Fork 或重写整套 TUI。
78. 作为用户，我希望本地 `/export` 仍可用，从而可以人工检查和脱敏后再处理会话。
79. 作为用户，我希望 `/new`、`/resume`、`/tree`、`/fork`、`/clone` 和 `/compact` 仍可用，从而保留 Pi 的本地会话能力。
80. 作为用户，我希望 `feishu init` 创建 Agent Home、系统提示词、默认配置、Mem0 设置和 Skills 缓存，从而一次初始化即可使用。
81. 作为用户，我希望 `feishu init` 执行 `lark-cli doctor`，从而提前发现飞书配置或连接问题。
82. 作为用户，我希望初始化检查复用的 Pi 模型认证，从而在进入 TUI 前发现无可用模型。
83. 作为用户，我希望初始化可重复执行且不会覆盖已有身份、模型和自定义系统提示词，除非我明确选择重置，从而配置不会意外丢失。

## Implementation Decisions

### 1. Runtime shape

- 构建独立的 `feishu` 可执行薄壳，使用 Pi 公共 SDK，不维护 Pi 源码 Fork。
- Interactive 模式组合 `AgentSessionRuntime` 与 Pi `InteractiveMode`；Print 模式使用 Pi 的单次输出 Runner。
- 首版只支持 Interactive 与 Print；JSON、RPC 不实现。
- Feishu 核心策略作为最终组合层，在第三方包资源加载后重新施加，防止 Extension 替换核心边界。
- `/remote` 由已安装的 Feishu Remote Package 提供，不再由 Runtime 内联工厂注册。

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
- Project Root 用于项目 Settings、Packages、Skills、项目说明和 Session 分区。Mem0 `app_id` 不随 Project Root 变化：自动记忆按人隔离，所有 Feishu Project 与机器共用固定桶 `feishu`（配合稳定用户 `feishu:<identity>`，见 issue #35）；Session 分区与项目 Package 仍按 Project Root 路径隔离。
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
- 仓库根目录的 `skills/feishu-control/` 是面向宿主 Agent 分发的桥接资源，不属于 Feishu Runtime；ResourceLoader 不自动发现它，`feishu init` 也不得把它安装到宿主 Agent 目录或 `~/.feishu-agent/skills/`。
- 项目 Feishu 资源和根 `AGENTS.md` 自动加载，不走 Pi 项目信任提示。
- 全局 `SYSTEM.md` 是基础身份，项目说明和 Extension 只能追加，不能替换。

### 6. Skill synchronization and precedence

- 启动读取 `lark-cli --version`（本地命令，无网络请求），缓存目录以完整 CLI 版本命名。
- Interactive、Print 运行时在入口设置 `PI_OFFLINE=1`（仅该进程），关闭 Pi 内核的启动期网络检查：既不再出现上游 `pi update` 新版本提示，也不出现 `pi update --extensions` 包更新提示——这两个提示对 Feishu 都是错误入口（pi-coding-agent 版本由 feishu 自己的 package.json 钉死，`pi update --extensions` 操作的是 `~/.pi/agent` 的另一套包）。init/install/update 管理命令不设置该变量，npm 安装不受影响；真实模型、Mem0、lark 调用也不受影响。
- 当前版本缓存完整且带成功标记时直接复用。
- 版本变化时，通过 `lark-cli skills list/read` 导出官方 Skills 到临时目录，完成校验后原子移动到版本缓存目录。
- 同步失败时使用最近一次成功版本并产生 Startup Warning；不存在任何成功缓存时仍可启动，但必须明确报告官方 Skills 不可用。
- `feishu skills sync` 忽略已有缓存并强制同步。`feishu skills sync --update` 是显式一键升级：先以 `lark-cli update --json` 升级 CLI（联网 + 全局安装，长超时），成功后再按新版本重建官方 Skills 缓存；CLI 升级失败则中止且不动缓存。
- 升级 lark-cli 属于用户显式手动操作（`lark-cli update`，或一键的 `feishu skills sync --update`）；启动与 init 路径不做任何网络更新检查，启动时只读取与当前 CLI 版本匹配的缓存（不自动重建）。CLI 升级后缓存不会在启动时自动重建，需显式 `feishu skills sync`（或 `--update`、或重跑 init）。
- 同名 Skill 按“项目私有 > 全局私有 > 安装包 > 官方缓存”解析。
- 每次启动输出冲突诊断，列出最终来源与所有被遮蔽路径。

### 6.1. Private Skill discovery and installation

- 交互式 `/find-skill <query>` 只在用户显式提交命令后查询公开的 `skills.sh` 搜索索引；启动和 `feishu init` 绝不搜索或安装第三方 Skill。
- 搜索结果展示 source、Skill 名称、安装量和 `skills.sh` 链接。用户选择结果后，系统先用公开的 `skills` CLI 做临时 staging，读取其中的元数据（若声明了许可证则一并显示），再在启用前请求确认。
- `/find-skill install <owner/repo@skill>` 是显式指定结果的安装形式。首版只接受经过校验的 GitHub shorthand 和一个 Skill 名称；任意 Shell 文本、本地路径和未经审阅的 URL 都拒绝。
- 安装器绝不能在真实用户 `HOME` 下执行 `npx skills add --global`。它使用临时 `HOME` 和 Pi 目标（`--global --agent pi --copy`），然后只把选中且校验通过的 Skill 树（包括相对引用文件）复制到 `~/.feishu-agent/skills/<name>`。
- staging 子进程不继承 `MEM0_API_KEY`、Token、Secret、Password 等凭证环境变量；npm 缓存、配置和临时锁文件也必须留在临时 HOME 中。
- 已存在的私有 Skill 必须经过第二次明确确认才能覆盖。源树中的符号链接和路径穿越会被拒绝；安装先 staging，目标变更完成后再清理临时树。
- 复制成功后，当前 Runtime 重新加载 Resources，使 Skill 立即可用。已安装 Skill 仍以当前用户权限运行，确认流程不构成沙箱。
- Print 模式可以输出搜索结果；没有 UI 时安装必须快速失败，不能等待确认。
- 当前实现的全新 Home 有 9 个内置 Feishu Skill：`feishu-skill-maker`、`feishu-find-skill`、`feishu-latex-rendering`、`process-optimization-biweekly`、`deslop-zh`、`feishu-pro-diagram`、`feishu-tech-note-writer`、`feishu-package-curator` 与 `volc-devinstance`。本规格 §16.5 待实现的 `feishu-automation` 将成为第 10 个，沿用显式 init 补齐流程；公共资源只能使用脱敏占位符，个人标识留在用户本地。

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
- Feishu Remote Package（`@azhi-ss/feishu-remote`）是本仓库 workspace 子目录中独立发布的只传输 Pi 兼容 npm 包。`feishu init` 以钉版本 npm 源自动安装；普通 Pi 可显式安装同一 npm 包。用户已配置该包（本地 path 或任意 `npm:@azhi-ss/feishu-remote` 源）时不得改回另一源。本地 path 不复制树。核心包装清单不直接依赖飞书 Node SDK。

### 8. Core policy precedence

- 保留内置工具名：`read`、`edit`、`write`、`bash`、`grep`、`find`、`ls`。
- 第三方 Extension 注册同名工具时，核心工具保留，冲突来源产生 Warning；插件其他资源继续加载。
- Extension 可追加 System Prompt，但不得替换全局基础身份。
- Extension 可请求自定义 Editor，但 Feishu Command Policy Editor 必须作为最外层提交拦截器。
- 核心策略应用必须在初始加载和 `/reload` 后都重新执行。
- `/remote` 仅允许包装清单名为 `@azhi-ss/feishu-remote` 的扩展注册；其他来源的同名命令删除并警告。该包仍不得替换保留核心工具或 `/find-skill`、`/feishu-resume`。

### 9. Tool capability and domain boundary

- 启用 Pi 的基础文件工具与 Bash。
- Bash 可运行项目工具链、Git 和 `lark-cli`；不提供额外 `lark_cli` Tool。
- System Prompt 明确：飞书操作优先使用 `lark-cli` Shortcut，陌生命令先查 `--help` 或 `schema`。
- Agent 可以检查项目材料或编写辅助代码，但必须直接服务于飞书交付或 `lark-cli` 工作流。
- 与飞书无关的普通开发请求返回简洁转介，建议使用普通 `pi`。
- 资源加载隔离不是 OS Sandbox；Bash 仍拥有当前用户权限，这一点必须在文档和启动帮助中明确。

### 9.1. Feishu Remote Package

- 制品只做传输：出站 WebSocket、Card Kit 流式卡片、`/remote`、主人一对一注入。不带官方 Skills、高风险批准、SYSTEM 身份或 Mem0。
- 身份：先读 `~/.lark-cli/config.json` 再读 XDG `lark-cli` 配置（零网络）。文件存在但无效或缺少 app/owner 时失败，不回退环境变量。两个路径都不存在时允许 `FEISHU_REMOTE_APP_ID` 与 `FEISHU_REMOTE_OWNER_OPEN_ID`。App secret 只来自 `FEISHU_REMOTE_APP_SECRET`。
- `/remote start` 在建连前获取 `$HOME/.cache/feishu-remote/<appId>.lock`（HOME 取进程环境）。锁文件为 JSON：`{"pid","startedAt","cwd"}`（旧版纯 pid 文件仍可读取）。活进程占用则失败并指出 pid 与项目目录名；死 pid 可回收。`/remote stop` 与会话关闭释放本进程的锁。
- 多窗口待机：同一应用禁止两条 WebSocket 长连接（事件会被飞书负载均衡到不同消费者，见 ADR-0001），多窗口永远只有一个连接消费者；常驻转发网关是未来选项，不在本里程碑。另一个 TUI 窗口活持锁时，`/remote start` 仍报错；`FEISHU_REMOTE=1` 自启则不报错，安静进入 `standby` 状态，状态行显示 `remote:standby` 与持锁 pid/目录名，`/remote status` 同口径展示。
- `/remote switch` 在本窗口请求接管：写一个短生命周期（~15s）的 yield 请求文件 `<appId>.yield` 并等待锁释放（轮询 ~200ms，上限 10s），拿到锁后正常建连；本窗口已连接则提示已连接。持锁窗口用 unref'd 定时器（250ms）轮询该文件，发现后在自己的事件循环 tick 上优雅停桥（状态行 `remote:off`，通知 `handed off`），不处理 turn 之外的任何逻辑。不用进程信号（SIGUSR2 会打断 TUI 原始模式 stdin read）；无锁/死 pid 锁直接回收后连接；持锁者已死（请求文件无人响应）超时则报错，不强杀对方。锁释放时清理残留 yield 文件。
- `/new`、`/resume`、`/fork`、`/reload` 等会话替换必须立刻作废尚未完成的 `start()`：不得把 gateway 交给已失效的 Extension runner，也不得用过期 `pi.sendUserMessage` 注入。新会话需要重新 `/remote start` 或 `FEISHU_REMOTE=1` 自动启动。
- TUI 状态由包直接调用 Pi `setStatus`，文案保持 `remote:<status>`。核心不为 Remote 增加状态插槽。
- 运输保持 ADR-0001：进程内官方 SDK `WSClient`；不得与 `lark-cli event consume` 同时占用同一应用。包从本仓库 workspace 公开发布到 npm，发布制品只包含 Extension 源码和包文档。

### 10. Lark identity and profile

- 复用现有 `lark-cli` 配置、Token、Profile 和默认身份，不向 Feishu Agent Home 复制凭证。
- 支持启动参数覆盖 `lark-cli` Profile；实现方式是在 Feishu 启动进程环境中设置或在生成命令规范中持续携带 Profile，不能修改用户全局默认 Profile。
- 个人资源默认显式使用 `--as user`。
- 只有用户明确指定 Bot 或 CLI/接口要求 Bot 时才使用 `--as bot`。
- `feishu init` 执行 `lark-cli doctor` 并报告失败项。

### 11. High-risk Lark operations

- Guard 只做一件事：Bash Tool Call 中的 `lark-cli` 破坏性命令（delete/remove/revoke/withdraw）带 `--yes` 时，要求用户本轮消息明确表达破坏性意图（中文“删除/移除/撤销/撤回”或对应英文动词）；否则拦截。
- 不解析命令目标、身份、范围，不查 lark-cli 元数据，不做一次性消费；批准按“当前轮次用户意图”生效。用户确认目标后下一轮重新执行即可。
- 不带 `--yes` 时：TUI 模式透传给 `lark-cli` 自身的 Confirmation Gate；Print 模式快速失败，返回非零退出码与可操作报错（提示用户明确要求后重跑加 `--yes`），不等待输入。
- 拦截报错必须给出下一步指引（如何合法完成），不只是拦截原因。
- System Prompt 与 Feishu 核心 Extension 共同约束此规则；核心 Extension 可审计 Bash Tool Call，但不能声称构成 OS 级安全边界。

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
- `FEISHU_UNATTENDED=1` 的无人值守进程不注册 Mem0 扩展（无 Recall、Capture、Dream，且不需要 API key）；见 §16。
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
  6. 自动安装 Feishu Remote Package（CLI 安装根下的绝对路径，禁止依赖用户 cwd 的相对路径）；
  7. 写入非敏感 Mem0 配置；
  8. 写入独立 Feishu Settings 和默认模型；
  9. 强制关闭 Mem0 Telemetry；
  10. 同步官方 Skills；
  11. 执行 `lark-cli doctor`；
  12. 验证至少一个模型凭证可用。
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
- `feishu skills sync [--update]`（`--update` 先显式 `lark-cli update` 再按新版本重建缓存；仅显式调用才联网）
- `feishu automation list` / `feishu automation show <name>`
- `feishu automation add --name <slug> (--cron <expr> | --at <ISO-time> | --every <duration>) (--prompt-file <path> | --prompt-stdin) [--tz <IANA>] [--catch-up <duration> | --no-catch-up] [--timeout <duration>] [--yes]`
- `feishu automation update <name> [同 add 的可变选项，不含 --name] [--yes]`
- `feishu automation run <name>` / `pause <name>` / `resume <name>` / `cancel <name>` / `rm <name> [--purge]`
- `feishu automation start` / `stop` / `status` / `serve`（Trigger 生命周期，与任务的 pause/cancel 区分；详见 §16.5）
- `feishu -c`
- `feishu -r`
- `feishu --session <id>`
- `feishu --lark-profile <profile>`
- 交互式 Slash Command：`/find-skill <query>`、`/find-skill install <owner/repo@skill>`、`/remote [start|stop|status|switch]`（`/remote` 由已安装的 Feishu Remote Package 提供，不是内联核心命令）

CLI 参数只实现上述需求，不追求 Pi CLI 的完整参数兼容；`/find-skill` 属于 Runtime 内的交互命令，不新增顶层 `feishu` 参数。

### 16. Unattended Automation

术语见根目录 `CONTEXT.md` 的「Unattended Automation」词条；架构取舍见 ADR-0002、ADR-0003 修订与 ADR-0005。§16.2–16.4 保留已有 Briefing 部署及独立 Sweep 里程碑；新跨平台管理能力以 §16.5 为准，不隐式迁移或启用这些旧任务。

#### 16.1 形态

- 唯一常驻的是与模型会话分离的 Trigger；既有 Briefing 使用外部系统定时器，新的管理能力使用独立应用级调度进程。每次自动化是一个全新的短命 `feishu -p` print run，跑完即退，不保留模型上下文。
- 无人运行设置 `FEISHU_UNATTENDED=1`，不注册 Mem0 扩展（无召回、捕获或 dream），不需要 `MEM0_API_KEY`；个性化与任务上下文写在工位说明和任务文件中，不依赖历史会话。
- 无人运行从独立非 git Automation Workspace 启动，位于 Agent Home 之外。旧 Briefing 工位、策略与制品保持不动；新任务使用独立 managed 工位。会话继续按工位路径分区；任务迁移不意味着迁移凭证、会话或自动接力。
- Trigger 不持有模型会话、不将密钥写入服务配置；每次执行只读复用模型认证，lark-cli 自管登录态。普通 Interactive/Print/init 不隐式安装、启动或等待 Trigger，也不增加调度相关网络请求。
- 旧 Briefing 系统单元仍是部署制品；新 `feishu automation` 管理面列入 §15，不再沿用「一律不增加 CLI」或 Linux-only 的限制。

#### 16.2 v0：Briefing

- systemd user timer，工作日北京时间 08:30 触发（timer 用内联时区 `…08:30:00 Asia/Shanghai`，与机器系统时区无关），`Persistent=true`；登录补跑仅在北京时间 11:00 cutoff 前发生，逾期跳过。手动出口始终保留：在工位目录运行同一 print prompt 可随时出简报。
- 事实每次以 user 身份实时拉取，记忆不作为事实来源：今日日程（calendar +agenda）、逾期/今明到期的未完成任务（task +get-my-tasks，其余折叠为数量）、待审批、近 48 小时真人 @我（im +messages-search --is-at-me，过滤 @所有人 与机器人卡片）、近 7 天本人编辑文档（drive +search --edited-since，只列标题与链接）。
- 交付：bot 以富文本 post 发到 owner 与 bot 的单聊；每条事项带飞书直达链接。部分数据源失败时简报照发，结尾注明失败的数据源；完全静默不是允许的失败模式。user token 过期导致拉取失败时，以 bot 通道通知 owner 重新登录 lark-cli。
- 运行安全沿用现有轮次高危护栏 + 工位 AGENTS.md 的只读策略（唯一写出口是 owner 单聊），v0 不做代码级只读强制；攻击面与升级条件见 ADR-0003。
- v0 只交付 Briefing。Sweep（@我轮询，30 分钟量级；先用廉价命令预筛，无新增不发起模型回合；`.state` 排重）在 Briefing 稳定运行一周后再启用，且 v0 只巡 @我；其完整设计（分层、游标、定时器、护栏升级判定、启用门槛）见 §16.4，本里程碑只设计、不实现、不启用。Alert（应用内→短信/电话加急）最后实现，必须具备显式级别阈值、静默时段与每日上限。bot 不加入任何群；某群需要实时性时逐群单独升级为事件监听。

#### 16.3 部署

- v0 部署在 owner 的 WSL 机器（systemd 用户态，不要求 Linger；该机系统时区为 JST），接受「机器不开则无自动化」的边界——飞书手机端始终是工作时段外的原生通道。时间口径统一钉在**北京时间（Asia/Shanghai，UTC+8 无夏令时）**：触发点是北京 08:30（在 JST 机上即本地 09:30 / UTC 00:30），`run-briefing.sh` 内 `export TZ=Asia/Shanghai` 使 cutoff、周末与子进程「今天日期」都按北京时间，搬到其他时区的常开机器也不变。
- 部署制品全部在 Automation Workspace，不进仓库：`systemd/feishu-briefing.service`（oneshot，`WorkingDirectory=%h/feishu-automation`，`Environment=FEISHU_UNATTENDED=1`，`UnsetEnvironment=MEM0_API_KEY FEISHU_REMOTE FEISHU_REMOTE_APP_SECRET FEISHU_REMOTE_APP_ID FEISHU_REMOTE_OWNER_OPEN_ID FEISHU_REMOTE_LOOPBACK_URL`，显式列出全部 6 个变量、不用 glob）与 `systemd/feishu-briefing.timer`（`OnCalendar=Mon..Fri *-*-* 08:30:00 Asia/Shanghai`、`Persistent=true`）。安装/停用各一条命令：`./install-systemd.sh`（拷贝到 `~/.config/systemd/user/` 并 `enable --now` timer）、`./disable-systemd.sh`（`disable --now` timer，加 `--purge` 删除单元）。单元只用 `%h`/`$HOME` 与标准前缀，无写死的本机路径，工位整体拷贝到另一台常开机器后跑一次 install 即可复用。
- 11:00 cutoff 与周末跳过在 `run-briefing.sh` 的运行路径判定（均按北京时间；timer 只管 Mon–Fri 调度；但 `Persistent` 可能把错过的周五触发重放到周六登录，故运行路径也拒绝周末）：北京时间 ≥11:00 或周六/周日则记一条 skip 原因到 journal 并退出 0；`--force`/`BRIEFING_FORCE=1` 是始终可用的手动出口。成败与耗时以 `briefing START/END exit=<rc> duration=<n>s` 写入 `journalctl --user -u feishu-briefing.service`，非零退出由 systemd 记为 failed。
- 测试要求：临时 HOME + fake 模型/服务下断言 `FEISHU_UNATTENDED=1` 的 print 进程不实例化记忆扩展（无 ping、无 search、无 add；见 `test/unattended-mode.test.ts`）。11:00 cutoff/周末跳过、journal 成败耗时、post 单聊出口、缺数据源注明均通过「真实 systemd service 子进程 + 临时覆盖时钟」在部署机端到端验收（部署制品不属于仓库，故不入仓库测试）；cutoff 是一条显然正确的北京时间判断。

#### 16.4 Sweep 设计（v0 只设计、不实现、不启用）

Sweep 是 30 分钟量级、以 owner 本人 user 身份轮询「谁在 @ 我」的轻量巡查；v0 只巡 @我，bot 不进任何群。本节把七个开放决策定清楚，供观察周后的实现票照做。Sweep 与 Briefing 共用同一个 Automation Workspace（`~/feishu-automation/`）、同一套 `FEISHU_UNATTENDED=1` 无记忆 print run（§16.1）与同一个 bot→owner 单聊出口；它只新增 `.state/` 游标、一个预筛脚本和一对独立的 systemd 单元。**本里程碑不落任何代码、`.state` 实现、systemd 单元或部署，也不安装/不启用 Sweep timer。**

**形态：两层（廉价预筛 + 按需 print run）。** 决策 1：无新增 @ 时绝不发起模型回合。
- 第 1 层（确定性脚本，零模型、零密钥）：timer 每次触发跑一个不经模型的 `run-sweep-prefetch.sh`（沿用 `run-briefing.sh` 风格，`export TZ=Asia/Shanghai`），以 user 身份执行 `im +messages-search --is-at-me`，复用 Briefing 的 @栏 过滤规则剔除 @所有人 广播与机器人/卡片消息，再按 `.state/` 游标去重，得到「本轮新增」候选。输入：定时器 + `.state/`；输出：候选为空则记 journal 后退出 0（不启动模型）；非空则把候选（message_id、群名、发送人、时间、原文摘要、直达链接）落盘为本轮候选文件并进入第 2 层。网络未就绪、user token 过期或 lark-cli 非零退出：不进入第 2 层，按下方失败语义处理，下一轮自愈，脚本自身退出码区分「空 / 有候选 / 预筛失败」。
- 第 2 层（按需一次 print run）：仅当第 1 层产出非空候选才以 `FEISHU_UNATTENDED=1` 启动一次全新短命 `feishu -p`，候选集经**文件**（工位内候选文件路径）传入，不把群消息原文拼进命令行。print run 只读取该候选文件并据此生成一条合并提醒、经 bot 发到 owner 单聊；它**不再另拉数据源、不扩大读取面**（见决策 6 的硬只读策略）。发送成功后由第 1 层脚本推进游标；模型回合失败（非零退出）时游标不推进，下一轮用同一候选自然重试（at-least-once，可能重复、绝不漏）。

**排重游标。** 决策 2：`.state/sweep-cursor.json` 存 `{"watermarkMs": <epoch ms>, "notifiedIds": [...]}`。`watermarkMs` 是已成功提醒消息的最大时间戳（仅用于缩小查询窗口），`notifiedIds` 是近一个窗口内已成功提醒的 `message_id` 有界集合（正确性去重，按时间或条数裁剪），二者都按 `Asia/Shanghai` 口径记录、存储用 epoch 毫秒以天然规避时钟/时区歧义（与 §16.3 的北京时间口径一致）。去重以 `message_id` 为准：`@所有人` 与机器人消息在进游标前即被过滤。**缺失/损坏一律安全退化为「宁可重复」**：文件缺失→首轮只查有界回看窗口（默认近 48h，与 Briefing @栏一致）而不是全历史，记 journal warning；JSON 解析失败→把坏文件改名归档（不删除）、按「有界回看 + 空 notifiedIds」重建，本轮至多重发该窗口内的 @。重复提醒可容忍，漏 @ 不可接受；时钟回拨由 `message_id` 去重兜底，不依赖单调时钟。

**定时器形态。** 决策 3：systemd **user** timer，周期约 30 分钟，单元放工位 `systemd/`（如 `feishu-sweep.service` oneshot + `feishu-sweep.timer`），与 Briefing 单元同构（`WorkingDirectory=%h/feishu-automation`、`Environment=FEISHU_UNATTENDED=1`、同样的 `UnsetEnvironment` 六变量显式清单、只用 `%h`/`$HOME`）。计时用 `OnBootSec=5min` + `OnUnitActiveSec=30min`，**不用** `OnCalendar=*:0/30`：轮询是相对节拍而非整点约定，且开机后错开 5 分钟、按上次实际触发滚动，可避免 WSL/笔记本休眠恢复后的整点突发。**显式 `Persistent=false`（且不写 `Persistent=true`）：不做任何补发**——轮询是持续覆盖过程，错过的轮次由下一轮的有界回看窗口自然覆盖，补发只会在开机时一口气重放一串陈旧 @，这与 Briefing「固定时点晨报、错过要在 cutoff 前补打」的语义相反。网络依赖用软依赖 `Wants=network-online.target` + `After=network-online.target`（不加硬 `Requires`，避免 WSL 用户态/网络目标缺失时拖垮单元）；网络未就绪由第 1 层快速失败、下一轮覆盖，不做重试循环。

**安静时段 / 频率护栏：v0 明确不做。** 决策 4：v0 不设夜间免打扰，也不设单轮/单日「抑制上限」——@我是旁人主动发起的协同信号，静默压下它反而可能漏事；真正需要分级与静默的是未来的 **Alert**，其显式级别阈值、静默时段、每日上限属于 Alert 里程碑，Sweep 提前实现这些就是提前实现 Alert，明确不做。唯一保留的是第 1 层的**防故障洪泛 sanity bound**（如一轮候选数异常巨大，疑似搜索/游标损坏）：超过上限时不逐条灌满一屏，而是合并成一条「本轮 @ 异常多（N 条，已折叠，请直接查飞书）」的提醒并记 warning——这是退化保护而非免打扰/频率策略。是否引入真正的免打扰时段，列入观察周后复核项。

**通知出口、合并与失败语义。** 决策 5：出口仍是 bot→owner 单聊富文本 post 一条，空结果不发（这是常态：多数 30 分钟无新增）。一轮多条新 @ **合并成一条**消息（每条一行：群名、发送人、一句摘要、飞书直达链接），不逐条轰炸；中文、一屏内、只依据第 1 层候选、禁止编造，与 Briefing 同一工位 AGENTS.md 口径。发送幂等靠 `message_id` 游标，不依赖消息平台去重。失败语义对齐 Briefing（完全静默不是允许的失败模式）：模型回合/发送失败→不推进游标，下一轮重发（可能重复）；**第 1 层预筛连续失败**（user token 过期鉴权失败、lark-cli 非零退出、网络持续不可达等）→单次失败只记 journal（偶发抖动由下一轮自愈，不打扰），当第 1 层**连续 N 次失败（v0 暂定 N=6，约 3 小时）**才经 bot 通道发**一条**去重提醒（token 过期文案为「请重新登录 lark-cli」，其余为「Sweep 巡查暂时不可用」），并在 `.state/` 记 notice 标记，同一连续失效周期只发一次、预筛重新成功后清除——既不静默停摆，也不复刻 Briefing 每次失败都提醒的行为。

**ADR-0003 硬只读升级判定：本里程碑在「启用」时点触发，且是启用前置。** 决策 6（明确结论，不回避）：Sweep 一旦启用，就会在**无人在场、非固定时点、每天约 48 次**自动产生对外写动作（向 owner 单聊发提醒），直接命中 ADR-0003「**Sweep gaining write actions**」这一已写明的升级触发条件。因此 v0 Sweep **不再适用纯提示词级只读护栏**：在 Sweep timer 被 enable 之前，必须先把无人运行升级为**硬命令策略（read allow-list + 单一写出口）**，否则不得启用。本结论是对既有 ADR-0003 的直接应用，该 ADR 已预先裁决且注明「改动局部、无需重设计」，故**不新增 ADR**；策略范围与落地顺序在此定清楚：
- **范围**：策略作用于所有 `FEISHU_UNATTENDED=1` 的 print run（Briefing 与 Sweep 一并收紧，单一规则，不为 Sweep 开特例分支）。Bash 只允许一份只读 `lark-cli` 读命令 allow-list（calendar/task/approval/im 搜索/drive 搜索等），唯一写出口是「bot 向 owner open_id 的 1-on-1 发 post」这一个参数化出口；非 allow-list 命令与任何其它写/发动作在命令层被拒，而非靠提示词自觉。Sweep 第 1 层是不经模型的确定性脚本，天然不产生模型驱动写动作；第 2 层 print run 不得自行调用通用发送命令，只经该唯一受控出口。
- **落地顺序（后续实现票，本票只写设计）**：① 先实现 launch-mode 硬命令策略（无人命令策略编辑器：读 allow-list + 单写出口）并配仓库测试——**该实现落地即取代 ADR-0003 的提示词级护栏裁决，届时在 0003 标记 superseded 或新增一条硬策略 ADR（本设计票不新增）**；② 预筛脚本 + `.state/` 游标；③ 按需 print run 与唯一发送出口接线；④ Sweep systemd 单元（安装但不 enable）+ 手动/影子验收；⑤ 仅在决策 7 的门槛全部满足后才由 owner 显式 enable。

**启用门槛（默认不启用）。** 决策 7：Sweep 单元可随工位制品一起**安装但保持 disabled**（`enable` 需要 owner 显式执行一条命令，安装动作本身不 enable），`feishu init` 不触碰 Sweep；默认安装态下不存在任何 30 分钟巡查。Briefing 观察周（稳定运行一周，见 §16.2）期间采集三类信号——**送达率**（简报/通知是否稳定到达、失败是否都有 bot 告警而非静默）、**是否有越权工具调用**（是否出现 AGENTS.md/allow-list 之外的读写动作；这同时是 ADR-0003 的独立升级触发）、**打扰度/信息密度**（真实 @ 的信噪比、是否被 @所有人/机器人噪声污染、合并与折叠是否够用）；Sweep 自身的入站量在观察周用**只写日志不发提醒的影子（dry-run）预筛**评估，不开真实通知；该影子只读、无模型、无写动作，可在观察周内先行落地，不被决策 6 的硬写策略门槛阻塞（即后续票的②预筛脚本先以 log-only 形态运行，观察周后再接①硬策略、③发送与④定时器）。确认人是 owner（单人，无自动启用）。**enable 需同时满足**：Briefing 满一周且上述信号可接受；决策 6 的硬命令策略已实现并通过测试；owner 在工单/工位显式签字。未满足则继续 disabled，观察周结论可回头修订本设计。

**Out of Scope（Sweep v0）**：实时事件监听 / `lark-cli event consume` 常驻看护；bot 加入任何群或群内实时升级；Alert / 应用内→短信→电话加急及其级别阈值、静默时段、每日上限；@我 之外的多数据源（任务、文档、审批变更等）巡查；Sweep 的任何代码、`.state` 实现、systemd 单元与部署；对 Briefing 本身的改动。

**后续实现票建议拆分（本票不实现）**：① 无人硬只读命令策略（ADR-0003 升级，read allow-list + 单写出口）+ 仓库测试；② 预筛脚本与 `.state/` 游标（含损坏/缺失退化、影子 dry-run）；③ 按需 print run 与唯一发送出口接线（合并通知、token 过期单次提醒）；④ Sweep systemd 单元（30 分钟、无 Persistent，安装默认 disabled）+ 部署机端到端验收；⑤ 观察周信号核对后由 owner 显式 enable。

**验收口径**：Sweep 行为（分层、游标退化、无 Persistent、通知合并/去重、越权拦截）与 Briefing 部署制品同属「工位/外部契约/模型内容」，仓库只对其中的核心代码（硬命令策略、无人模式契约）做测试；预筛脚本、systemd 单元、时区与通知内容靠「真实 systemd 子进程 + 临时覆盖时钟」在部署机端到端验收及观察周人工确认，不入仓库测试。

#### 16.5 跨平台 Automation 管理与应用级 cron

**状态：PRD [#38](https://github.com/Azhi-ss/feishu-agent/issues/38) 分片交付中。#39 提供一次性任务创建/查看/手动运行，#40 增加显式前台 `serve`、两小时默认窗口、持久化消费与重启恢复；尚无 OS 服务、重复日程、生命周期编辑或 automation Skill，也未部署或迁移旧任务。** 本节取代旧 systemd-only 管理草案（#37、ADR-0004）；保留 ADR-0002 的短命无记忆执行，采用 ADR-0005 的独立 Trigger 和 ADR-0003 修订的提示词约束。完整 PRD 与用户故事见[跨平台 Automation 规格](docs/designs/cross-platform-automation-spec.md)。

##### 分工与管理入口

- 一个 Automation 模块通过 §15 CLI 管理定义、日程、派发与记录，复用已有无人 Print runner。Feishu 私有 automation Skill 通过既有 Bash 帮用户编写、展示、确认和管理任务；不新增模型工具、常驻 Extension Hook 或独立自动化 Package。
- Skill 通过显式 init 幂等安装到新旧 Home，已有用户修改不覆盖；不在普通启动安装。任务必须自包含，不复制整个创建聊天或依赖 Mem0。新任务使用独立的非 git managed Automation Workspace，不改变既有 Briefing 工位及其政策。
- macOS/Linux 使用共同应用级 cron 逻辑；系统服务只托管一个 Trigger，不生成逐任务系统日程、不改 crontab。每任务只在选定主机执行，迁移需显式设置，不做同步、自动接力或跨机去重。
- `add` 要求唯一安全名、恰好一种日程、非空任务文件/stdin；名称为小写字母/数字/连字符，首位字母或数字，最长 32 字符。同名保留记录也不能静默覆盖。`update` 保留未传字段，校验完整结果，无选项报错。
- 创建和所有影响执行的修改均先显示完整计划/差异（时间、时区、下次触发、内容、动作、目标、身份、补跑、时限），再明确确认。TTY 等肯定答复，非 TTY 缺 `--yes` 快速失败；Skill 得到用户确认后才能携带该旗标。它是调用者的确认声明，不是签名授权；CLI 不把正文解析成 ACL。
- 创建时保存解析后的非敏感 Lark profile 并纳入确认/查看：依次采用已有显式 `--lark-profile`、调用环境的 profile、lark-cli 本地默认配置（包括其无名默认），本地无法确定时要求用户显式指定。定时与手动运行使用任务记录，不跟随之后 Trigger/调用方的默认值；改 profile 用现有旗标经 update 确认，不复制对应凭证。
- 参数非法、日程冲突、任务为空、同名或确认被拒时不产生任务/服务变更。`--catch-up` 与 `--no-catch-up` 互斥，duration 为正整数分钟/小时/天，至少一分钟。创建不自动真实试跑；去掉旧 `--run-now` 分支，显式 `run` 作为手动入口。
- CLI stdout 为结构化命令结果，英文诊断/交互确认放 stderr；不新增全局 JSON/RPC Agent 模式。`list/show` 提供任务状态、日程、时区、策略、下次执行、最近结果及留痕，`show` 可读完整说明；`status` 报真实 Trigger 状态。可在 Trigger 停止时保存 enabled 任务，但回执必须明确服务未运行。

##### 日程合同

| 类型 | 规则 |
|---|---|
| 日历重复 | 数字五字段 cron；支持通配符、列表、范围、步长；日与星期都受限时按 OR。拒绝秒字段、宏、扩展语法及 OnCalendar，不近似转换。 |
| 一次性 | `--at` 为 ISO 时间，无偏移按任务时区、有偏移为绝对时刻；相对自然语言由模型先转换为展示给用户的绝对时间。 |
| 固定间隔 | 首次启用为锚点，第一个间隔后触发；耗时/重启不改节拍。修改间隔建立新确认锚点，暂停/恢复不改锚点。 |

- 时区每任务固定保存，默认 `Asia/Shanghai`，可指定其他 IANA 时区；换机器/系统时区不漂移。分钟级调度，不承诺秒级精度；固定间隔是经过时长，不能用 cron 步长冒充。
- 重复任务默认两小时补跑窗口，可调整或关闭。恢复时最多执行最近一轮且必须在原定时刻的窗口内，不重放历史积压。一旦执行开始，失败或 unknown 不再当补跑。
- 一次性也默认两小时窗口，可调整；过窗且未开始则 expired，保留记录、不再自动执行。定时派发开始即消费该次计划，即使失败也不自动再次派发，手动再跑是新的明确尝试。
- 简单时钟默认：不早于计划时刻；回拨不重复已结算 occurrence；DST 不存在的本地分钟跳过，重复分钟只算一次。一次性无偏移时刻若不存在/歧义要求显式偏移。关闭补跑仍允许到期分钟内正常派发，不补更早分钟。

##### 运行与结果合同

- 同任务至多一份，覆盖定时/手动竞争；到点仍有本任务运行则 skip、不排队、不结束后补跑，手动重复返回 already-running。
- 同一 managed 工位最多两个不同任务并行，手动也占同一容量；其他 scheduled 工作等待但不延长窗口。等待的重复任务最多保留最新未开始一轮，派发前重查资格；过窗则重复 skip、一次性 expired，不建无界队列。
- 默认执行时限十分钟，可按任务改，从实际启动而非排队计时。超时终止并记录 timeout，不自动重跑；确认所属进程退出后释放容量，不凭陈旧 PID 误杀无关进程。
- 失败、超时、取消、结果不明均不自动整任务重试；后续正常重复日程保持 enabled。保留退出码、诊断、输出；unknown 不等于“没产生写入”，部分完成不回滚，手动重跑时提示可能重复。
- runner 完成不是所有业务写入成功的证明；不把模型自称成功或缺失回执变成 exactly-once 保证。保留成功、失败、超时、取消、unknown、过期与 skip 的区别。
- 本地版本化 JSON、任务文本与运行记录，原子更新、有限本地协调；记录足够的 occurrence/运行身份防止重启自动重新派发。坏记录/未知版本保留并报错，不清空证据或自动重启任务。

##### 生命周期默认值（由工程收敛，不再逐项访谈）

- `pause` 停新派发并丢弃未开始轮次，当前运行继续；`cancel` 中止当前轮次，不回滚写入。模型把日常管理意图映射到明确命令。`resume` 不补人为暂停期间，保留间隔锚点，过期 one-shot 不自动复活。
- 更新仅影响后续运行，当前轮次保留启动时的计划快照；修改待确认期间旧计划有效，除非用户明确暂停。只改正文不改日程锚点。
- `rm` 默认保留任务/历史，`--purge` 才删除保留制品；存在活跃运行时拒绝移除并给 pause/cancel 指引，不删无关文件。`run` 无需常驻 Trigger，但走共同执行/锁路径；允许手动执行保留的 paused/completed/expired 任务，不允许执行 removed 任务。手动运行不消费/重置 one-shot 的计划或过期状态，不移位重复日程；若未来仍有正常触发，回执明确提示。
- 独立手动调用负责监管自己的子进程直到结束；中断时做有界终止或记录 unknown。Trigger stop 只处理其所属执行，不终止独立手动进程，后者仍占共用容量。
- managed 工位与现有 Briefing 分离，缺失 standing instructions 在显式首次设置播种，已有不覆盖；每轮 scratch 分开以免并发冲突。留痕保留 30 天，清理不删除定义或活跃运行。
- 每轮新 `FEISHU_UNATTENDED=1` Print 进程，无 Mem0/旧会话上下文；保持正常资源隔离与工具，真实 HOME、非敏感 Lark profile。只读复用模型认证、lark-cli 自管 token，不保存环境快照或把秘密写进服务/日志/会话；不向子进程注入 Mem0/Remote Bridge 秘密或自启变量。
- 提示词要求任务不管理自身调度；管理入口对继承的 unattended 标记拒绝任务/服务管理调用，Trigger 直接启动 Print 子进程。此小检查仅防递归误用，有通用 Bash 就不是安全沙箱。
- `start` 显式安装并启用专属服务：macOS launchd、Linux/WSL user systemd，只托管共同 `serve` 进程；`stop` 停服务及重启、保留任务。停止 Trigger 时不新派发，对所属执行做有界结束，unknown 不自动重试；活运行不能被重启误认为已空闲。
- 安装先本地校验，缺可执行文件/user manager 快速失败、不半启用，支持含空格路径和不同 Node 布局。只记录必需路径/非秘密环境，不自动 root/linger/改登录设置；无 user manager 可显式前台 `serve`，该进程退出即无调度。
- 普通 Interactive/Print/init 不隐式安装、启动、等待或探测调度服务，不增加启动网络请求；显式初始化原有行为不扩张。不新增依赖、升级或 patch 第三方包。

##### 模型行为约束与范围

- 最终采用提示词约束：保留既有工具、Skills、高危护栏与凭证保护，不新增权限引擎、受限工具集、按目标 allow-list、受控发送 API 或沙箱。
- 任务说明写清目标、输入、固定目的地、动作、身份、产物与失败处理。首版仅约定固定会话 bot 普通消息与固定现有文档 user 追加；不覆盖/删除、换目标、加群、改权限/成员、处理审批或加急，不因访问失败自动换身份。
- 这是行为约定，不声称其他命令不可调用；外部内容的提示词注入、模型误判仍可越权。不得借 scheduler 入参校验重新引入被否决的业务权限项目。
- 原高危 guard 不变，不向定时 prompt 追加伪造破坏性批准；需要交互确认的调用在 Print 快速失败。定时业务仍由模型通过现有 lark-cli 工作流完成，不另写飞书 API 客户端。
- 不迁移或改变旧 Briefing，不实现/启用 Sweep/Alert、群监听、跨机协调。独立里程碑的门槛不作为此能力的隐式前置，也不由本规格自动取消。

##### 测试合同

- 用户已确认**一个主缝：真实 CLI 子进程**。临时 HOME/工位、PATH fake lark-cli/服务命令、回环 fake 模型/Mem0；观察退出码、结果、子进程启动数与制品，不断言私有字段或 Pi 内部。
- 一处受控测试时钟驱动真实管理/serve 路径，覆盖时间类型、时区/DST、重启/回拨、补跑/过期；不真等数小时，不新增公开时钟旗标或生产测试服务。
- fake 子进程关卡覆盖定时/手动竞争、同任务互斥、两任务容量、等候窗口、超时/取消与崩溃后不重跑，包含模拟副作用后失败的回归。
- 复用 CLI surface、Print、unattended、init/resource、release/isolation 的既有测试模式，验证确认门、Skill 安装/发现/正文加载/脚本结果、资源/身份上下文、无 Mem0、秘密不复制、高危 guard 不退化。
- 增补手动执行未到期/暂停/完成/过期 one-shot 不改计划、removed 不可运行、手动进程独立监管，以及保存的 Lark profile 不随调用方或服务默认变化的回归；改 profile 仍需确认。
- fake 模型只证明接线和政策进入上下文，不证明任意真实模型永不越权。两个平台运行相同行为测试（macOS/Linux × Node 22/24）；服务用替身，不触碰真实任务/crontab/服务。真实 service smoke 另需授权并单独报告；全量 gate、干净安装、diff-check 沿用仓库要求。

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

3. **Official Skill cache**
   - 首次版本同步、缓存复用、版本变化、原子发布、同步失败回退和无缓存告警。
   - Runtime 入口强制跳过 Pi 内置启动期网络检查（上游 `pi update` 版本提示与 `pi update --extensions` 包更新提示），管理命令不受影响。
   - `feishu skills sync` 强制刷新。
   - `feishu skills sync --update` 先调 `lark-cli update --json` 再按新版本重建；update 失败则中止且不动缓存；不带 `--update` 时绝不调用 update（临时 HOME + PATH 注入 fake lark-cli，见 `test/skills-update.test.ts`、`test/official-skills.test.ts`）。

4. **Package commands**
   - 全局安装写入 Feishu Agent Home。
   - `-l` 写入真实项目 `.feishu-agent/`，不产生真实 `.pi/`。
   - `list/remove/update/config` 仅影响 Feishu Settings。
   - 普通 Pi Fixture 看不到 Feishu 包。
   - Manifest 全资源加载和过滤行为与 Pi Package 语义一致。
   - `feishu init` 把钉版本 `npm:@azhi-ss/feishu-remote@<version>` 写入全局包列表；再跑 init 不重复追加；已配置任意 npm 版本或本地 path 源时不改源。

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
    - 用户本轮消息明确要求破坏性动作时可携带 `--yes`；否则不得自行加 `--yes`。
    - Print 模式下未批准的高风险操作快速失败并给出重跑指引。

11. **Sessions**
    - 当前 Project 会话隔离于其他 Project 和普通 Pi。
    - 从不同子目录恢复时采用当前启动 CWD，并显示原会话 CWD 提示。
    - 持久化 Interactive 会话的 Feishu 退出提示为 `feishu --session <id>`，精确恢复只查当前 Project 分区，不把普通 Pi 命令作为恢复入口；`feishu` 不在 PATH 时显示 `FEISHU_RESUME_COMMAND`。
    - 会话文件不出现在项目目录。

12. **Private Skill discovery**
    - `/find-skill` 搜索只在显式调用时访问回环 Fake/测试替代的搜索端点；启动和初始化零搜索、零第三方安装。
    - 选择结果后显示 source、Skill name、install count、license（缺失时明确显示未声明）和 Feishu 目标路径，并在拒绝确认时不改变目标目录。
    - 使用临时 HOME 调用 fake `npx skills add --global --agent pi --copy`，验证真实 `~/.agents/skills`、`~/.pi/agent/skills` 和项目 `.agents/.pi` 没有被写入；只把选中的 Skill 与 references 复制到 `~/.feishu-agent/skills`。
    - 恶意 source、路径穿越、符号链接、缺少合法 `SKILL.md` 或已存在目标的行为均快速失败或要求覆盖确认；安装失败不留下半成品。
    - 安装后 ResourceLoader reload 能发现新 Skill；Print 模式搜索可输出结果，安装在无 UI 时非零快速失败而不挂起。

13. **Initialization**
    - 全新 HOME 初始化安装默认 Feishu Skills（包括 §16.5 的 automation Skill），已有 Home 显式 init 可补齐缺失 Skill，已有用户内容不被覆盖。
    - 缺少 API Key、无模型、`lark-cli doctor` 失败时输出精确诊断。
    - 重复初始化幂等，不覆盖已有配置。
    - 显式重置选项才改变 Identity、模型或 System Prompt。

14. **Remote Bridge package**
    - Interactive PTY 夹具把 workspace 包绝对路径装进临时 Feishu Agent Home；现有 `/remote` 行为保持。
    - npm pack 只包含包清单、README 与 Extension 源码；包版本与 `feishu init` 的钉版本一致。
    - 同一临时 HOME、同一 app id 的两个会话先后 `/remote start`：第二个失败并提到占用 pid。
    - 临时 HOME 里预先写入死 pid 锁后，`/remote start` 仍能连上。
    - 同一把锁被活进程占用时，`/remote start` 失败并提到该 pid 与项目目录名；`FEISHU_REMOTE=1` 自启遇活锁不报错，进入 `standby` 并在状态行/`/remote status` 展示持锁者。
    - `/remote switch`：活持锁的第一个 PTY 轮询到 yield 请求后优雅停桥，第二个 PTY 自动建连成功；无活持锁者（死 pid）时直接回收并连接；请求超时未响应则报错。
    - 握手未完成时 `/new`：不得出现 stale-ctx 报错；手机消息不得打进已替换的会话。
    - 无 `lark-cli` 配置时环境变量身份可用；坏配置不回退环境变量。
    - 允许名单包装保留 `/remote`，其他包装同名命令被剥掉。

15. **Automation**
    - 复用真实 CLI 主测试缝，按 §16.5 与完整 PRD 验证任务管理/确认、受控时间、并发/恢复、无人 Print、Skill 接线、服务替身、秘密扫描及 macOS/Linux × Node 22/24 行为矩阵。
    - 只验证提示词注入和既有 guard，不把模型遵守业务规则当作硬权限测试；不触碰真实任务或账户。

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
- Windows 原生服务与其他平台完整适配；本次 Automation 明确支持 macOS/Linux，不沿用 Linux-only 限制，项目包 Symlink/Junction 的 Windows 行为仍单独验收。
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
