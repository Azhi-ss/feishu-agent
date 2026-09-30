---
name: feishu-control
description: '委派任务给独立的 Feishu Agent，并返回其结果。这是 Host Agent 使用的桥接 Skill：用户明确说“让飞书助手做”“用 Feishu Agent/feishu-agent/feishu-send”，要求使用 Feishu Agent 的记忆，或显式调用 `/skill:feishu-control` 时使用。触发后必须调用 `feishu-send`；不要把请求交给当前 Agent 的 lark-* Skills，也不要把它当作普通 coding 任务。'
---

# Feishu Agent Delegation Bridge

> 这是 Host Agent 的路由和传输协议，不是 Feishu Runtime 的内部 Skill、coding skill，也不是 lark-cli 命令手册。
>
> **安装边界：** 将本目录安装到 Host Agent 的 Skill 目录（通常是 `~/.agents/skills/`）。不要把它加入 `~/.feishu-agent/skills/`，也不要在 Feishu Agent 的 `DEFAULT_SKILLS` 中内置它，否则会让子 Agent 尝试调用自己。

## 角色

- **Host Agent**：当前 Agent。负责判断是否委派、准备必要上下文、调用桥接脚本、转交结果。
- **Feishu Agent**：由 `feishu -p` 启动的独立同事 Agent，负责真正执行 Feishu/Lark 操作。它可以反问、等待用户确认；同一件事可以按会话 ID 多轮续接（Delegation Session）。
- **`feishu-send`**：Host Agent 到 Feishu Agent 的唯一桥接入口。
- **`lark-cli`**：Feishu Agent 内部使用的飞书能力层。

Feishu Agent 的文件和 Shell 能力只是支持飞书交付的工具；它不是通用 coding agent。

## 路由规则

1. 用户明确提到 Feishu Agent、`feishu-agent`、`feishu-send`，或显式调用本 Skill：
   - 本路由优先于任何 `lark-*` Skill。
   - 必须委派给 Feishu Agent。
2. 用户没有明确要求 Feishu Agent：
   - 不要仅因为任务涉及日历、消息或文档而自动启用本 Skill。
   - 由 Host Agent 的普通 lark-cli 路由处理。
3. 用户说“用这个”但当前上下文无法确定“这个”是否指 Feishu Agent：
   - 先询问一次，不要猜。
4. 混合任务：
   - Host Agent 处理普通本地代码或文件准备。
   - Feishu/Lark 操作完成后，再委派对应部分。
   - 不要把无关的软件开发交给 Feishu Agent。

## 执行协议

触发委派后，除非缺少必要输入，当前轮次必须执行一次 Bash 调用，不要只解释命令或先写一份替代方案。

不指定 Profile：

```bash
"$HOME/.agents/skills/feishu-control/feishu-send" "<原始用户请求>"
```

用户明确指定 Profile：

```bash
"$HOME/.agents/skills/feishu-control/feishu-send" \
  --profile "<profile>" \
  "<原始用户请求>"
```

续接同一件事（回答 Feishu Agent 的问题、确认、或要求修改刚才的结果）：

```bash
"$HOME/.agents/skills/feishu-control/feishu-send" \
  --session "<上次 stderr 中 Feishu Session: 后面的 ID>" \
  "<用户的原话回复>"
```

执行要求：

- 将完整请求作为一个 Shell 参数传入，并正确转义。
- 默认使用当前工作目录；只有用户明确要求其他项目或记忆范围时，才设置 `FEISHU_CONTROL_CWD`。
- 只有用户明确指定 Profile 时，才传 `--profile`。
- 每次运行结束后，无论退出码是什么，都在你自己的后续上下文里保留三项：`Feishu Session` 的 ID、当时的工作目录（或 `FEISHU_CONTROL_CWD`）、以及用过的 `--profile`。不要只在它提问时才记。
- 续接必须沿用这三项。会话按 Feishu Project（Git 根目录）分区，换到另一个仓库会找不到会话。`--profile` 不参与分区：换掉它会话还在，但飞书身份会变成另一个人，所以必须沿用原来的。
- 用户下一句是在改刚才的结果、回答刚才的问题、或确认刚才拦住的操作：用保留的 ID 续接。
- 用户下一句是一件新的飞书任务，而且不指着刚才的结果：不带 `--session`。
- 分不清就问用户一次，不要猜。
- 每个用户轮次最多自动调用一次；用户后续回复可以触发新的调用。
- 不要直接调用 `feishu -p`，统一使用 `feishu-send`。

## 请求转发规则

- 优先原样转发用户的操作请求，不要总结、翻译或弱化其中的目标、身份、范围和动作。
- 如果必须补充上下文，放在单独的 `Context supplied by Host` 部分。
- 不要转发 Host Agent 的内部推理。
- 不要把 Token、API Key、密码或其他凭证放进请求。
- 不要自行添加 `--yes`，不要替用户批准破坏性操作。续接时原样转发用户的答复；只有用户自己明确说出破坏性意图（例如“确认删除 X”），才把这句话转发过去，不要自拟“确认”。
- 不要把一次委派拆成多个自动重试，尤其是写操作。

## 返回协议

- **会话 ID**：每次运行的 stderr 都有一行 `Feishu Session: <id>`。记下它用于续接；它不是警告。
- **退出码为 0**：`stdout` 是 Feishu Agent 的最终回复。将其作为主要结果返回，不要重新执行同一任务。会话 ID 留在你的上下文里；用户接着改刚才的结果时，用它续接。
- **退出码为 0 且有其他 stderr**：任务仍然成功；将 stderr 视为警告，只在有用时简短转告用户。
- **退出码为 3**：Feishu Agent 在等用户。`stdout` 是它的问题和编号选项，或 `stderr` 是高危操作需要确认的说明。原样转告用户后停下等待，不要替用户回答或确认；用户回复后再用 `--session <id>` 续接。
- **退出码为其他非 0 值**：不要声称任务完成。返回退出状态和经过脱敏的错误信息。
- **超时（124）**：假定操作可能已经部分完成，不要自动重试。把会话 ID 告诉用户并等待决定。如果续接报 `No Feishu session found`，说明进程在模型开口前就结束了，这个 ID 没有会话文件，不要用它重试。
- 退出码为 0 但回复本身是在提问时，与退出码 3 同样处理：原样转告，停下等用户，再用 `--session` 续接。不要自行猜测答案。
- 用户想亲自接着聊时，告诉他在同一目录运行 `feishu --session <id>` 打开交互界面。

## 完成条件

只有在以下条件都满足时，委派才算完成：

1. `feishu-send` 已经实际执行；
2. 已观察到退出码；
3. 已处理 stdout/stderr；
4. 已将成功结果、明确失败原因，或 Feishu Agent 的问题（附会话 ID，便于续接）返回给用户。
