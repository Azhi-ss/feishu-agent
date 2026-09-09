# AGENTS.md — feishu-agent 行动指北

给在本仓库工作的 AI 编码助手。人类读者从 README.md 开始。

## 这个项目是什么

`feishu` 是飞书专用助手：Pi 公共 SDK + TUI 之上的可执行薄壳。它不是 Pi fork，也不是通用编码 agent。领域术语见 CONTEXT.md；需求与设计决策见 SPEC.md；两者冲突时以 SPEC.md 为准。

## 常用命令

```bash
npm run build          # tsc → dist/，并恢复 dist/src/cli.js 执行位
npm test               # build + 全量 node --test
node --test dist/test/<name>.test.js   # 跑单个测试文件（先 build）
```

## 代码规范

- TypeScript strict，ESM，Node >= 22.19。产物在 `dist/`，不提交。
- 不引新依赖：优先复用 `@earendil-works/pi-coding-agent` 已导出的能力。
- 测试只断言外部可观察行为——真实 CLI 子进程 + 临时 HOME + PATH 注入的 fake `lark-cli`/`npm` + 回环 fake 模型/Mem0 服务；不断言私有字段或 Pi 内部实现。每个非平凡行为至少一个会失败的测试。
- CLI 用户可见文案用英文（与现有输出一致）；SPEC.md / CONTEXT.md 保持中文，README / CONTEXT 保持英文。
- **Vendored 第三方资源**（当前为 `themes/`）必须在同目录登记来源 URL、版本/日期与同步步骤（见 `themes/CREDITS.md`）；从上游同步后重跑 `npm test`。Vendored 内容不通过 npm 依赖引入。
- **空 `catch`** 必须注释吞掉了什么错误、为什么 best-effort，且 `try` 只包一条语句。
- **Pi SDK 钉版本且属 pre-stable**：升级版本号前先读上游 CHANGELOG 的 extension/editor/theme 行为变更，升完在 Node 22 与 24 下跑全量测试，破坏点写进 commit/issue；不盲目追新——已知 0.85.x 的 turn 结算回归会挂 Remote Bridge 电话回合（blocked-tool 场景），锁在 0.84.x 直到上游修复或 bridge 层适配。

## 硬边界（动这些之前先停下来和用户讨论）

1. **启动路径零网络、零阻塞**。Interactive/Print/init 启动只允许本地命令（如 `lark-cli --version`）和缓存命中。任何网络请求、自动更新、长超时同步调用都要先征得用户同意——2026-09 曾因启动时自动更新 lark-cli（同步网络 + `npx skills` 状态检查）导致 TUI 卡死，被整体移除（commit 08f769b）。官方 Skills 靠版本惰性同步：启动只读与当前 `lark-cli` 版本匹配的缓存（不自动重建）；用户显式 `feishu skills sync` 重建，或 `feishu skills sync --update` 一条命令先 `lark-cli update` 再按新版本重建（唯一会联网升级 CLI 的入口，仍需手动）。
2. **不 Fork Pi、不 patch 第三方包**。`@earendil-works/pi-coding-agent` 与 `@mem0/pi-agent-plugin` 原样使用，版本在 package.json 里钉死。
3. **资源隔离**。绝不加载 `.pi/`、`.agents/`、Codex、Claude 的资源；Feishu 的设置、包、Skills、会话、Mem0 状态全部在 `~/.feishu-agent/`。普通 Pi 的 `auth.json`/`models.json` 只读复用。仓库根目录的 `skills/feishu-control/` 是给宿主 Agent 安装的分发资源，不是 Feishu Runtime Skill；不得加入 `DEFAULT_SKILLS`，也不得由 `feishu init` 安装到宿主 Agent 目录或 `~/.feishu-agent/skills/`。
4. **凭证**。不复制、不打印、不落盘任何 token/API key；`MEM0_API_KEY` 只走环境变量，且不得出现在错误信息、Session 文件或测试输出里。
5. **高危 lark-cli 写操作**。Guard 只拦一种情况：`lark-cli` 破坏性命令（delete/remove/revoke/withdraw）带 `--yes` 但用户本轮消息没有明确表达破坏性意图。不解析目标/身份/范围、不做一次性消费；用户在对话中确认后于同一轮或下一轮重跑即可放行。不带 `--yes` 时 TUI 透传给 lark-cli 自身确认；Print 模式无法交互确认时快速失败（非零退出码 + 可操作报错），绝不挂起。
6. **CLI 参数面保持最小**（SPEC.md §15）。新增命令或旗标先改 SPEC 再写代码。

## 验收标准

- `npm test` 全绿；`git diff --check` 干净。
- 新行为 → 新测试；修 bug → 先写会失败的回归测试。
- 测试矩阵原则：临时 HOME/项目、回环 fake 服务，绝不碰真实网络端点、真实飞书账号或用户凭证。
- 秘密扫描：测试断言产物与诊断输出不含 Mem0 key、lark token。
- 改 `package.json`/`package-lock.json` 后，用 Node 22 跑一次干净 `npm ci` 验证：npm 11（Node 24）生成的 lock 会漏写 npm 10 要求的 optional peer 条目（CI 矩阵为 22+24，2026-09 曾因此挂过 master）。
- 迭代跑聚焦测试文件即可，推送 gate 是全量 `npm test`；只报告实际执行过的命令，CI 拥有全量与平台矩阵。
- 重写历史一律 `git push --force-with-lease`，绝不用裸 `--force`。

## 本仓库的特殊性

- 在本仓库目录里运行 `feishu` 时，本文件会被 FeishuResourceLoader 自动注入为项目上下文——等于修改那个助手系统提示的一部分，措辞需要慎重。每条规则自包含，细节链到 SPEC.md/docs 而不在此复述；清晰度不降时就压缩，能删则删。
- `~/.feishu-agent/` 是运行时状态（会话、skills 版本缓存、包、记忆配置），调试时可整体删除后重新 `feishu init`。

## Agent skills

### Issue tracker

Issues 与 PRD 以 GitHub issue 管理（`Azhi-ss/feishu-agent`），统一用 `gh` CLI；不把外部 PR 作为 triage 请求面。见 `docs/agents/issue-tracker.md`。

### Triage labels

使用五态默认标签：`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`。见 `docs/agents/triage-labels.md`。

### Domain docs

单上下文仓库：根目录 `CONTEXT.md` 领域词汇表 + `docs/adr/`；工程设计以 `SPEC.md` 为准。见 `docs/agents/domain.md`。

### Capability layering

给 Feishu/Pi 增加能力时，先用「能形成确定性闭环的最低权限层」实现，缺执行/生命周期/分发边界时才向上升级：复用任务措辞 → Prompt Template；按需知识与配套文件 → Skill；结构化参数与结果 → Tool（由 Extension 注册）；模型之外强制策略或监听生命周期 → Extension；安装/锁版/跨机共享 → 再用 Package 包装（Package 是交付维度，不给代码降权、不造沙箱）。润色 prompt 换不来 Runtime 保证；OS/外部调度器能闭环就不要写常驻 Hook。选型问题、各层测试合同与本仓库的对应实例（high-risk guard、工位 AGENTS.md、官方 Skills、钉版 Package、systemd 定时器）见 `docs/agents/capability-layering.md`。
