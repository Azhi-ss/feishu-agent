# Automation 作为可选 Package，而非 Feishu 本体能力

用户明确要求本体保持干净，并授权代码拆分和本机旧简报停用。复用已有
Package 安装/资源加载机制，不新增插件框架，不改变 Remote/Mem0 默认策略。

Automation 的 CLI、调度、记录、进程监管、系统服务与 Skill 提取到
`packages/feishu-automation/`。现有调度/确认/存储合同原样保留；本体移除
`feishu automation` 和默认 Skill，保留通用无记忆 Print。Package worker
负责 admission，之后 POSIX exec 为公开的 `feishu -p`，保留被监管的 PID
及进程组，不依赖本体私有 import 或启动普通 Pi。独立包不引入 Runtime 依赖。

已有候选中，pi-scheduler/pi-routines 依赖活跃会话；pi-extension-cron
最接近，但文档入口为普通 Pi，且 Linux 重启托管和时区合同不等价。本轮
不 fork 或 patch 第三方包，也不把未验证的替代方案安装到真实环境。
先提取已有实现比同时替换引擎更容易验证。它减少本体职责，不声称减少了
调度实现本身的复杂度；后续可在不修改本体的情况下替换整个可选包。

包尚未发布 npm；本地 build/pack/install 为交付入口。安装不启动服务，
移除前必须显式 stop 并验证，任务/日志/旧 Briefing 文件保留。其他用户的
init/升级不自动删改旧 Skill；迁移文档要求先归档再移出加载目录。

本决定只改变 ADR-0005 的交付归属，保留独立 Trigger、单主机、无上下文
短命执行与提示词级业务策略。新命令合同见 SPEC §16.5，操作见
[包 README](../../packages/feishu-automation/README.md)。
