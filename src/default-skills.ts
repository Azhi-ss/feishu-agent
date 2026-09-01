export interface DefaultSkill {
  name: string;
  body: string;
}

const FEISHU_SKILL_MAKER = `---
name: feishu-skill-maker
version: 1.0.0
description: "创建和维护 Feishu Skill 的规范与工作流。当用户要求创建、新增、编写、修改或发布一个 Feishu Skill（把飞书操作封装成可复用的 SKILL.md）时使用。"
---

# Feishu Skill Maker

Feishu Skill 是只对 Feishu Agent 可见的按需能力包，形式为一份 \`SKILL.md\`。本文件同时是规范与执行步骤：新建 Skill 时必须逐条遵循。

## 存放位置与优先级

1. 项目私有：\`<project>/.feishu-agent/skills/<name>/SKILL.md\` —— 只在该 Feishu Project 生效
2. 全局私有：\`~/.feishu-agent/skills/<name>/SKILL.md\` —— 跨项目复用（**用户未指定位置时默认放这里**）
3. 安装的 Feishu Package、官方 lark-cli 缓存（只读，不要手工改）

同名 Skill 最终生效顺序：项目私有 > 全局私有 > 安装包 > 官方缓存；被遮蔽的来源会在启动时告警。不要创建与现有官方 Skill（如 lark-im、lark-mail）同名的技能，避免无意遮蔽。

## 目录结构

\`\`\`
skills/<name>/
  SKILL.md           # 必填
  references/*.md    # 可选，SKILL.md 用相对路径引用
\`\`\`

## SKILL.md 规范

- frontmatter 必填 \`name\` 和 \`description\`；\`name\` 用 kebab-case，飞书域技能建议 \`feishu-\` 或 \`lark-\` 前缀。
- \`description\` 用中文写清“做什么 + 什么时候用”，包含触发词（如“创建 skill”“发审批”），这是模型自动加载和 \`/skill:<name>\` 检索的依据。
- 正文先写触发条件，再写分步操作；每步给出可直接执行的 \`lark-cli\` 命令。优先级：Shortcut（\`+xxx\`）> 已注册 API > \`lark-cli api\` 裸调。
- 个人资源命令默认带 \`--as user\`；只有用户明确要求或接口强制时用 \`--as bot\`。
- 高危写操作（\`Risk: high-risk-write\`）必须等用户明确确认后才能带 \`--yes\`，不得自行推断。
- 不写入、不复制、不打印任何 Token/API Key；认证复用 lark-cli 现有登录态或环境变量名，不落地密钥。
- 首次创建前用 \`lark-cli schema <service.resource.method>\` 或 \`lark-cli <service> --help\` 核对参数，禁止编造标志。
- 不确定的命令写 \`--help\` 查询而不是猜。

## 创建流程

1. 确认需求属于飞书交付或 lark-cli 工作流；否则转交普通 pi。
2. 确定存放位置（默认全局 \`~/.feishu-agent/skills/\`）。
3. 写 \`SKILL.md\`，遵循上面的 frontmatter 与命令规范。
4. 自检：\`name\` 唯一且不与官方缓存冲突；\`description\` 含触发词；所有命令真实存在（\`--help\`/\`schema\` 验证过）。
5. 告知用户保存路径与生效范围，并提示可用 \`/skill:<name>\` 手动调用。

## 最小示例

\`\`\`markdown
---
name: feishu-calendar-review
description: "查看并总结飞书日历日程。当用户要查今天/本周的日程安排时使用。"
---

# Calendar Review

1. 查日程：\`lark-cli calendar +agenda --as user\`
2. 用中文总结当天安排；无日程则如实说明。
\`\`\`
`;

export const DEFAULT_SKILLS: DefaultSkill[] = [{ name: "feishu-skill-maker", body: FEISHU_SKILL_MAKER }];
