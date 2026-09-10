# 独立的跨平台 Trigger，不保留模型会话

访谈已确认：Automation Job 的定义与用法兼容 macOS/Linux，任务仅在用户指定的单台主机执行，不做自动同步、接力或跨机去重。允许一个由用户首次显式启用、独立于聊天窗口的轻量后台 Trigger，使用共同的应用级调度逻辑；系统服务只负责托管这个进程，而不是逐任务解释日程。这样避免把调度语义绑定到 systemd 或 launchd，同时保留 ADR-0002 的全新短命无人运行原则：Trigger 只计时和派发，不持有模型上下文、不持续调用模型，正常 Interactive/Print/init 启动不隐式安装、启动或等待它。

本决定取代 ADR-0004 的 Linux-only、逐任务 systemd 调度与禁止任何 Feishu 常驻进程的取舍，保留现有高危护栏与凭证保护；跨平台一致性值得承担独立调度进程的生命周期管理成本。任务业务范围按 ADR-0003 修订采用提示词约束，不新增硬授权层或受限工具集。SPEC §15/§16.5 与[完整 PRD](../designs/cross-platform-automation-spec.md) 已将访谈收敛成实现和测试合同，并发布为 [#38](https://github.com/Azhi-ss/feishu-agent/issues/38)（`ready-for-agent`）；仅规格发布已获授权，尚未实现、部署或迁移已有 Briefing。旧 systemd 草案仅作历史记录。参考：[一手来源调研](../designs/cross-platform-cron-research.md)。
