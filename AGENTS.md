# AGENTS.md — feishu-agent 行动指北

给在本仓库工作的 AI 编码助手。人类读者从 README.md 开始。

## 这个项目是什么

`feishu` 是飞书专用助手：Pi 公共 SDK + TUI 之上的可执行薄壳。它不是 Pi fork，也不是通用编码 agent。领域术语见 CONTEXT.md；需求与设计决策见 SPEC.md；两者冲突时以 SPEC.md 为准。

## 常用命令

```bash
npm run build          # tsc → dist/，并恢复 dist/src/cli.js 执行位
npm test               # build + 全量 node --test（当前 104 个）
node --test dist/test/<name>.test.js   # 跑单个测试文件（先 build）
```

## 代码规范

- TypeScript strict，ESM，Node >= 22.19。产物在 `dist/`，不提交。
- 不引新依赖：优先复用 `@earendil-works/pi-coding-agent` 已导出的能力。
- 测试只断言外部可观察行为——真实 CLI 子进程 + 临时 HOME + PATH 注入的 fake `lark-cli`/`npm` + 回环 fake 模型/Mem0 服务；不断言私有字段或 Pi 内部实现。每个非平凡行为至少一个会失败的测试。
- CLI 用户可见文案用英文（与现有输出一致）；SPEC.md / CONTEXT.md 保持中文，README / CONTEXT 保持英文。

## 硬边界（动这些之前先停下来和用户讨论）

1. **启动路径零网络、零阻塞**。Interactive/Print/init 启动只允许本地命令（如 `lark-cli --version`）和缓存命中。任何网络请求、自动更新、长超时同步调用都要先征得用户同意——2026-09 曾因启动时自动更新 lark-cli（同步网络 + `npx skills` 状态检查）导致 TUI 卡死，被整体移除（commit 08f769b）。官方 Skills 靠版本惰性同步：用户手动 `lark-cli update` 后，下次启动自动按新版本重建缓存。
2. **不 Fork Pi、不 patch 第三方包**。`@earendil-works/pi-coding-agent` 与 `@mem0/pi-agent-plugin` 原样使用，版本在 package.json 里钉死。
3. **资源隔离**。绝不加载 `.pi/`、`.agents/`、Codex、Claude 的资源；Feishu 的设置、包、Skills、会话、Mem0 状态全部在 `~/.feishu-agent/`。普通 Pi 的 `auth.json`/`models.json` 只读复用。
4. **凭证**。不复制、不打印、不落盘任何 token/API key；`MEM0_API_KEY` 只走环境变量，且不得出现在错误信息、Session 文件或测试输出里。
5. **高危 lark-cli 写操作**。`--yes` 必须精确匹配用户已明确表达的动作、目标、身份、范围，一次批准只绑一条命令；Print 模式无法交互确认时快速失败（非零退出码），绝不挂起。
6. **CLI 参数面保持最小**（SPEC.md §15）。新增命令或旗标先改 SPEC 再写代码。

## 验收标准

- `npm test` 全绿；`git diff --check` 干净。
- 新行为 → 新测试；修 bug → 先写会失败的回归测试。
- 测试矩阵原则：临时 HOME/项目、回环 fake 服务，绝不碰真实网络端点、真实飞书账号或用户凭证。
- 秘密扫描：测试断言产物与诊断输出不含 Mem0 key、lark token。

## 本仓库的特殊性

- 在本仓库目录里运行 `feishu` 时，本文件会被 FeishuResourceLoader 自动注入为项目上下文——等于修改那个助手系统提示的一部分，措辞需要慎重。
- `~/.feishu-agent/` 是运行时状态（会话、skills 版本缓存、包、记忆配置），调试时可整体删除后重新 `feishu init`。
