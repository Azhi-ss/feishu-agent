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
- 高危写操作（删除/移除/撤销/撤回）只有在用户本轮消息明确要求该类动作时才能带 \`--yes\`，不得自行推断；无 \`--yes\` 时交给 lark-cli 自己的确认提示。
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

const FEISHU_LATEX_RENDERING = `---
name: feishu-latex-rendering
version: 1.0.0
license: MIT
description: "飞书云文档（Docx / XML）与 Markdown 场景下的数学公式（LaTeX）渲染规范与排坑指南。解决从 Markdown/LaTeX 到飞书云文档时 \`$ ... $\` 与 \`$$ ... $$\` 无法渲染、字符转义报错、行内与独立块排版、表格/高亮块嵌套等问题。"
metadata:
  requires:
    bins: ["lark-cli"]
    skills: ["lark-doc", "lark-markdown", "lark-shared"]
---

# 飞书数学公式（LaTeX）渲染规范与排坑指南

本文档为在飞书云文档（Docx / XML）中编写、转换与更新**数学公式（LaTeX）**的标准规范与排坑手册。

---

## 1. 核心渲染原理与致命死穴

### ❌ 常见错误与现象
- **现象**：在 Markdown 或 XML 中直接写入 \`$E=mc^2$\` 或 \`$$\\log p(x) = \\dots$$\`，发布到飞书云文档后**原样显示为带有 \`$\` 符号的纯文本**，公式未被渲染。
- **根源**：飞书 Docx 富文本引擎与底层 XML 解析器**不识别 Markdown 风格的 \`$\` / \`$$\` 语法**，飞书原生公式必须使用专用标签 \`<latex>...</latex>\`。

### ✅ 正确语法对照表

| 场景 | Markdown 习惯写法（❌ 在飞书 XML 不渲染） | 飞书 XML 原生写法（✅ 正确渲染） |
| :--- | :--- | :--- |
| **行内公式 (Inline)** | \`$v_\\theta(x_t, t)$\` | \`<latex>v_\\theta(x_t, t)</latex>\` |
| **独立行公式 (Block)** | \`$$\\mathcal{L}(\\theta) = \\mathbb{E}[\\|v - u\\|^2]$$\` | \`<p><latex>\\mathcal{L}(\\theta) = \\mathbb{E}[\\|v - u\\|^2]</latex></p>\` |
| **表格单元格** | \`<td>$x_t = (1-t)x_0 + tx_1$</td>\` | \`<td><p><latex>x_t = (1-t)x_0 + tx_1</latex></p></td>\` |
| **高亮块 (Callout)** | \`<callout><p>$$\\nabla_\\theta L = 0$$</p></callout>\` | \`<callout><p><latex>\\nabla_\\theta L = 0</latex></p></callout>\` |

---

## 2. 飞书 XML 公式排版与嵌套规范

### 2.1 容器包裹铁律
\`<latex>\` 是**行内级元素**，必须包裹在块级容器标签内（如 \`<p>\`、\`<td>\`、\`<th>\`、\`<li>\`、\`<blockquote>\`）：
\`\`\`xml
<!-- ✅ 正确：包裹在 <p> 中 -->
<p>瞬时速度定义为：<latex>v_t = \\frac{dx_t}{dt}</latex>，其中时间 <latex>t \\in [0, 1]</latex>。</p>

<!-- ✅ 正确：独立公式块 -->
<p><latex>\\log p_1(x_1) = \\log p_0(x_0) - \\int_0^1 \\text{Tr}\\left(\\frac{\\partial v_t}{\\partial x}\\right) dt</latex></p>

<!-- ❌ 错误：顶层直接使用 <latex>（会导致 XML 解析失败或渲染丢失） -->
<latex>E = mc^2</latex>
\`\`\`

### 2.2 XML 特殊字符转义红线
由于 \`<latex>\` 存在于 XML 文档中，**LaTeX 公式内部不能出现未转义的 XML 保留字符**：

| LaTeX 字符 | 冲突原因 | 安全替代写法 |
| :--- | :--- | :--- |
| \`<\` (小于号) | 破坏 XML 标签开始符 | 使用 \`\\lt\`、\`\\le\`（小于等于）或 \`&lt;\` |
| \`>\` (大于号) | XML 标签结束符 | 使用 \`\\gt\`、\`\\ge\`（大于等于）或 \`&gt;\` |
| \`&\` (对齐符号) | XML 实体起始符 | 在单行公式避免 \`&\`；若必须使用转义为 \`&amp;\` |

**示例**：
\`\`\`xml
<!-- ❌ 错误：< 会导致 XML 解析报错 -->
<p><latex>t < 1.0</latex></p>

<!-- ✅ 正确：使用 \\lt 或 \\le -->
<p><latex>t \\lt 1.0</latex> 或 <latex>t \\le 1.0</latex></p>
\`\`\`

---

## 3. 支持的 LaTeX 语法特性

飞书内置 KaTeX/MathJax 兼容子集，支持主流数学符号与宏：
- **微积分与算子**：\`\\int_0^1\`, \`\\sum_{i=1}^n\`, \`\\frac{\\partial v}{\\partial x}\`, \`\\nabla_\\theta\`, \`\\text{Tr}(\\cdot)\`, \`\\mathbb{E}\`
- **希腊字母与矩阵**：\`\\alpha\`, \`\\theta\`, \`\\sigma_{min}\`, \`\\mathcal{L}\`, \`\\mathbb{R}^{d}\`, \`\\mathbf{X}\`
- **箭头与关系符**：\`\\to\`, \`\\sim\`, \`\\approx\`, \`\\Longrightarrow\`, \`\\mid\`, \`\\cdot\`, \`\\otimes\`
- **范数与括号**：\`\\| x \\|^2\`, \`\\left( \\dots \\right)\`, \`\\left[ \\dots \\right]\`, \`\\{ \\dots \\}\`

---

## 4. 自动化转换脚本（Markdown → 飞书 XML）

当有包含 \`$...$\` 与 \`$$...$$\` 的 Markdown 或草稿文本时，可使用以下 Python 正则脚本一键替换：

\`\`\`python
import re

def convert_markdown_math_to_feishu_xml(text: str) -> str:
    """
    将 Markdown 风格的 $$ ... $$ 和 $ ... $ 自动转换为飞书 XML 的 <latex> 标签
    并自动处理 XML 实体转义
    """
    # 1. 替换多行独立公式 $$ ... $$ -> <p><latex> ... </latex></p>
    def replace_block_math(match):
        formula = match.group(1).strip()
        # 转义 < 和 &
        formula = formula.replace('&', '&amp;').replace('<', r'\\lt ')
        return f"<p><latex>{formula}</latex></p>"

    text = re.sub(r'\\$\\$(.*?)\\$\\$', replace_block_math, text, flags=re.DOTALL)

    # 2. 替换单行行内公式 $ ... $ -> <latex> ... </latex>
    def replace_inline_math(match):
        formula = match.group(1).strip()
        formula = formula.replace('&', '&amp;').replace('<', r'\\lt ')
        return f"<latex>{formula}</latex>"

    text = re.sub(r'(?<!\\$)\\$(?!\\$)(.*?)(?<!\\$)\\$(?!\\$)', replace_inline_math, text)
    return text
\`\`\`

---

## 5. 快速检查 Checklist

在执行 \`lark-cli docs +create\` 或 \`lark-cli docs +update\` 之前，必须执行自检：
1. [ ] 全文搜索 \`$\`：确认**无遗留的 \`$ ... $\` 或 \`$$ ... $$\`**；
2. [ ] 检查 \`<latex>\` 内部：确认没有裸写 \`<\` 或未转义 \`&\`；
3. [ ] 检查父容器：确认每个 \`<latex>\` 都处于 \`<p>\`、\`<td>\`、\`<th>\` 或 \`<li>\` 内部；
4. [ ] 预览验证：在飞书云文档中打开网页版，确认公式无文本乱码并正常居中/行内渲染。
`;

const PROCESS_OPTIMIZATION_BIWEEKLY = `---
name: process-optimization-biweekly
version: 1.0.0
license: MIT
description: "工艺优化（如目标材料专题、配方与烧结优化等）周报与双周例会进展的完整调研、信息获取与写作规范。包含 IM 单聊/群聊/排期表/技术文档的信息获取全景地图，以及按项目生命周期 5 阶段演进的硬核工程师写作模版与飞书操作流。"
metadata:
  requires:
    bins: ["lark-cli"]
    skills: ["lark-doc", "lark-sheets", "lark-im", "lark-contact", "lark-shared"]
---

> 这是公开的可复用模板。使用前请把尖括号占位符替换为当前项目的资源标识；不要把真实 Open ID、Chat ID、文档或表格 token 写入 Skill。
> 优先通过名称搜索资源，或使用用户在当前任务中明确提供的标识。

# 工艺优化周报与双周例会：信息获取与写作规范

本文档为工艺优化（以目标材料专题为标杆）算法/研发工程师在进行**周报、双周例会进展梳理、下一步工作规划及飞书文档更新**时的标准化操作手册。

---

## 一、 每周从哪里获取内容（信息源全景地图）

工艺优化每周的工作内容随项目推进不断变化。撰写前必须从以下 **4 类信息源** 提取客观事实：

\`\`\`
┌─────────────────────────────────────────────────────────────────────────────┐
│                            工艺优化周报信息源地图                            │
├───────────────────────┬─────────────────────────┬───────────────────────────┤
│    1. IM 即时通讯     │     2. 项目进度排期     │      3. 专项技术资产      │
│  • P2P单聊(PM/专家)   │  • 排期底表(Sheet)      │  • 专题方案与备忘(Docx)   │
│  • 项目/指标/算法群聊 │  • 责任人任务行与 Note  │  • 数据字典与门禁标准     │
└───────────────────────┴─────────────────────────┴───────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    4. 目标周例会 / 双周报文档 (Docx)                        │
│             • 提取第 3 节「当前进展」与第 4 节「下一步计划」                │
└─────────────────────────────────────────────────────────────────────────────┘
\`\`\`

### 1. IM 单聊与群聊监控清单

#### A. 核心协同人单聊（P2P）
| 对接人 | 角色 / 部门 | 检索目的与关注要点 | 常用 OpenID / Chat ID |
|---|---|---|---|
| **项目经理** | PM / 项目经理 | 获取本周例会议程、客户催办、截稿提醒、硬件/商务进展、待办确认 | \`<OPEN_ID>\`<br>\`<CHAT_ID>\` |
| **算法专家** | 架构师 / 算法专家 | 获取算法选型共识、指标量化定义、评测基准探讨、技术方案评审意见 | 通讯录检索 \`算法专家\` |
| **表征负责人** | 表征算法负责人 | 获取物性表征与工艺算法的输入对齐（如 SEM 图像特征、粒度 D50 作为工艺变量） | 通讯录检索 \`表征负责人\` |
| **平台负责人** | 平台交付负责人 | 获取算法工具封装、平台 API 接口联调、私有化部署环境与数据安全要求 | 通讯录检索 \`平台负责人\` |
| **客户技术专家** | 客户方技术专家 | 获取客户历史批次台账提供进度、异常字段说明、实验工况与排产反馈 | 单聊或项目群 |

#### B. 核心协同群聊（Group）
| 群聊名称 | Chat ID | 关注内容与检索关键词 |
|---|---|---|
| **项目总群** | \`<CHAT_ID>\` | 硬件配置（GPU/算力）、商务预付款、高层例会通知与整体交付节奏 |
| **项目材料群** | \`<CHAT_ID>\` | 项目总体排期变更、主方案合稿、客户周例会日程通知 |
| **交付指标群** | \`<CHAT_ID>\` | 验收指标确认意见、评测集定义、算法精度与实验指标量化标准 |
| **算法讨论群** | \`<CHAT_ID>\` | 贝叶斯优化（BO）、高维采样、多目标寻优、基线模型对比讨论 |

#### C. IM 常用提取命令
\`\`\`bash
# 1. 检查 PM（项目经理）最近 10 条聊天记录
python3 -c "
import subprocess, json
res = subprocess.run(['lark-cli', 'im', '+chat-messages-list', '--chat-id', '<CHAT_ID>', '--as', 'user'], capture_output=True, text=True)
for msg in json.loads(res.stdout).get('data', {}).get('messages', [])[-10:]:
    print(f\\"[{msg.get('create_time')}] {msg.get('sender',{}).get('name')}: {msg.get('msg_type')} -> {msg.get('content')[:120]}\\")
"

# 2. 检查群聊内最新文件或指标讨论
lark-cli im +chat-messages-list --chat-id "<CHAT_ID>" --as user
\`\`\`

---

### 2. 项目进度排期底表（Sheet）

- **表格定位**：飞书电子表格《项目进度排期》（Token: \`<SPREADSHEET_TOKEN>\`）。
- **重点提取字段**：
  \`\`\`bash
  # 读取当前周对应的任务状态与 Note
  python3 -c "
  import subprocess, json
  res = subprocess.run(['lark-cli', 'sheets', '+read', '--spreadsheet-token', '<SPREADSHEET_TOKEN>', '--range', '<SHEET_RANGE>', '--as', 'user'], capture_output=True, text=True)
  for r in json.loads(res.stdout)['data']['valueRange']['values'][1:]:
      if len(r) > 2 and '项目负责人' in str(r[2]):
          print(f\\"Task {r[0]}: {r[1]} | 状态: {r[9] if len(r)>9 else ''} | 备注: {r[11] if len(r)>11 else ''}\\")
  "
  \`\`\`
- **关键任务映射**：
  - \`Task 18\`：LFP 专题需求沟通（目标、基线、核心变量、实验验证资源）
  - \`Task 19\`：LFP 历史数据字段整理（配方、细磨、烧结、前驱体物性、检测指标）
  - \`Task 20\`：LFP 数据质量评估（缺失、异常、批次链路追溯）
  - \`Task 21 & 22\`：LFP 需求整理与评审会（M1 基线冻结）
  - \`Task 42~47\`：LFP 模型训练、离线评测、候选方案推荐、实验验证、模型迭代

---

### 3. 专项技术与方案资产（Docx / Base）

- **技术基准文档**：如 [《目标材料专题模型与数据对接方案》](<FEISHU_DOC_URL>)（Token: \`<DOC_TOKEN>\`）。
- **核心提取要点**：
  1. **优化目标定义**：主优化目标（压实密度 $\\text{g/cm}^3$）与硬约束指标（首次放电容量 $\\text{mAh/g}$、首次库仑效率 $\\ge 85\\%$、循环寿命）。
  2. **4 大工艺变量池**：
     - 前驱体与原材料（$\\text{Fe/P}$ 比、振实密度、BET、一次粒径）；
     - 配料与砂磨（$\\text{Li/Fe}$ 比、碳源类型与添加量、砂磨细度 D50/D100、砂磨线速度/时间）；
     - 喷雾造粒与高温烧结（进/出风温、烧结主温区温度、恒温保温时间、残氧量 $\\text{ppm}$、升降温速率）；
     - 成品粉体物性与微观表征（总碳 $\\text{wt}\\%$、成品 BET、D10/50/90、残碱、包覆层厚度）。
  3. **数据质量五步门禁**：工况对齐、全流程批次号关联链条、装配异常样本剔除、缺失值物理插补、历史有效样本量预期（30~50 批次）。

---

## 二、 怎么写（按项目生命周期 5 阶段演进模版）

工艺优化的双周/周报不能写死，必须**根据当前所属的项目生命周期阶段**灵活套用以下模板：

### 核心叙事法则（Anti-AI 铁律）
1. **真实硬核**：直接说具体参数、物理量、样本数、真实 Gap 与阻塞点，禁止空洞大话。
2. **三要素闭环**：每一期必须交代 **① 技术产出** + **② 实测数据/指标** + **③ 协同与阻塞项**。

---

### 阶段 1：需求对齐与数据对接期（当前阶段）

> **阶段特征**：刚启动项目，明确目标、圈定变量池、制定门禁标准、与客户对齐字段。

\`\`\`markdown
当前进展：
1. 编制完成《目标材料专题模型与数据对接方案》（关联飞书文档 cite），明确以压实密度为主优化目标，容量、首效、循环等作为约束指标。
2. 梳理前驱体物性、配料砂磨、造粒烧结、成品表征等 4 类关键变量池，并确立数据质量五步门禁（工况对齐、全流程批次链条关联、异常剔除、缺失插补规则）。
3. 与客户技术专家（客户技术专家）完成首轮需求与关键字段沟通，推进字段范围与历史台账对接。

下一步计划：
1. 推动客户完成核心字段与取值范围确认，收集 30~50 组具备完整工艺记录的历史批次台账。
2. 开展首批 LFP 样本数据质量评估，跑通清洗管道并检查批次追溯链条与异常分布。
3. 形成目标材料工艺优化模型算法需求规格文档，准备组织需求评审会。
\`\`\`

---

### 阶段 2：数据清洗、EDA 与特征工程期

> **阶段特征**：拿到客户历史数据，跑清洗流水线，发现脏数据/断链/异常，进行探索性分析。

\`\`\`markdown
当前进展：
1. 接收客户首批交付的 XX 组 LFP 历史批次数据，完成数据字典对齐与格式标准化。
2. 跑通数据质量五步门禁：发现 X 组批次存在编号断链（烧结炉次缺失）、X 组扣电首效<80%异常剔除，最终锁定 XX 组有效建模样本。
3. 完成特征探索分析（EDA）：发现细磨 D50 与总碳含量对压实密度的相关性最高，提取配料摩尔比与烧结温区积分等衍生特征。

下一步计划：
1. 针对次要缺失变量采用物理先验约束插补，完成训练集/测试集划分（如 4:1 按时间划分）。
2. 构建工艺优化基线模型（Baseline），完成第一轮离线回归精度评测。
3. 与客户专家复核离群样本的工艺异常记录。
\`\`\`

---

### 阶段 3：算法建模、Baseline 与离线评测期

> **阶段特征**：多模型对比、贝叶斯优化（BO）框架搭建、超参调优、特征重要性排序。

\`\`\`markdown
当前进展：
1. 完成 GP / XGBoost / 混合机理模型 Baseline 搭建，在测试集上压实密度预测 RMSE 达到 X.XX g/cm³（R²=X.XX）。
2. 完成特征贡献度归因（SHAP 分析）：确认主烧结温度在 XXX~XXX℃ 区间存在明显非线性极值，细磨 D50 最佳窗口在 X.X~X.X μm。
3. 完成高维贝叶斯优化（BO）推荐算法框架开发，集成多目标约束（容量>XXX mAh/g）。

下一步计划：
1. 优化采集函数（Acquisition Function），增强边界勘探能力与抗噪鲁棒性。
2. 生成第 1 轮目标材料推荐工艺候选参数方案（Top 3~5 组）。
3. 组织内部算法评审，输出候选参数置信度与机理合理性评估报告。
\`\`\`

---

### 阶段 4：候选方案推荐与产线闭环验证期

> **阶段特征**：给出推荐方案，客户实验/产线排产验证，实测数据回填，归因分析。

\`\`\`markdown
当前进展：
1. 完成第 X 轮工艺推荐，向客户输出 3 组候选方案（涵盖推荐配方、细磨参数与烧结温度曲线），给出预期压实密度预测区间 [X.XX ~ X.XX] g/cm³。
2. 协同客户完成试制排产与扣电测试，实测压实密度达到 X.XX g/cm³（相比基线提升 X.X%），容量与首效均满足约束。
3. 开展实测与预测 Gap 归因：第 2 组因实际炉温漂移 5℃ 导致预测偏差 X%，已将扰动因子纳入鲁棒性修正。

下一步计划：
1. 将本轮实测批次数据回填至暖启动知识库，更新先验分布。
2. 启动第 X+1 轮候选工艺推荐，针对高压密极限参数区间进一步收敛。
3. 准备实验对比分析报告与产线阶段性进展汇报。
\`\`\`

---

### 阶段 5：模型迭代、工具化与交付验收期

> **阶段特征**：算法固化、接口集成、性能压测、验收文档与培训。

\`\`\`markdown
当前进展：
1. 完成 LFP 工艺推荐核心算法封装，提供标准的配方推荐、物性预测与参数敏感性分析 API 接口。
2. 配合平台研发完成算法模块接入与前端交互联调，跑通批量计算与报告自动导出链路。
3. 整理一期算法交付测试报告，核心指标（压实密度提升幅度和推荐准确率）达到合同验收基线。

下一步计划：
1. 配合进行系统试运行与客户培训，收集试运行反馈并修复边缘 Bug。
2. 完善算法技术白皮书与交付归档文档。
3. 推进一期项目终验评审。
\`\`\`

---

## 三、 飞书文档更新标准操作流（CLI）

当根据上述模板整理好内容后，使用 \`lark-cli\` 执行局部更新：

\`\`\`bash
# 1. 精确定位例会文档中的 Block ID
lark-cli docs +fetch --doc "<DOC_TOKEN>" --detail with-ids --as user

# 2. 更新第 3 节「当前进展」下的工艺优化
lark-cli docs +update --doc "<DOC_TOKEN>" --command block_replace --block-id "<BLOCK_ID_3>" \\
  --content '<ol><li seq="1">...</li><li>...</li><li>...</li></ol>' --doc-format xml --as user

# 3. 重新 fetch 获取第 4 节最新 Block ID 并更新「下一步计划」
lark-cli docs +update --doc "<DOC_TOKEN>" --command block_replace --block-id "<BLOCK_ID_4>" \\
  --content '<ol><li seq="1">...</li><li>...</li><li>...</li></ol>' --doc-format xml --as user

# 4. 闭环验证
lark-cli docs +fetch --doc "<DOC_TOKEN>" --as user
\`\`\`
`;

const FEISHU_FIND_SKILL = `---
name: feishu-find-skill
version: 1.0.0
license: MIT
description: "在 Feishu Agent 内搜索、审阅并安装第三方 Skill。当用户说查找 skill、推荐 skill、安装 skill、/find-skill，或想把普通 Pi skill 放进 Feishu 时使用。"
---

# Feishu Skill Discovery

使用内置的 \`/find-skill\` 命令发现和安装第三方 Skill；不要直接调用普通 Pi 的全局安装路径。

## 用法

- 搜索：\`/find-skill <关键词>\`
- 从搜索结果选择后，Feishu Agent 会显示 source、安装量、\`SKILL.md\` 中声明的描述/许可证和目标路径，再询问是否安装；安装量只是排序信号，不是安全或法律背书。
- 明确安装某个结果：\`/find-skill install <owner/repo@skill-name>\`

## 边界

- 目标只允许是 Feishu Agent 私有目录：\`~/.feishu-agent/skills/<name>\`；不要写入 \`~/.agents/skills\`、\`~/.pi/agent/skills\` 或项目的 \`.agents/.pi\`。
- 启动和 \`feishu init\` 不搜索、不自动安装；联网只发生在用户显式调用 \`/find-skill\` 时。
- 第三方 Skill 以当前用户权限运行。许可证缺失或内容未经审阅时要明确提示，不把“可安装”说成“已合规”。
- 安装完成后重新加载 Runtime；如果当前模式没有 UI，搜索可以输出结果，但安装必须快速失败，不能等待确认。
`;

export const DEFAULT_SKILLS: DefaultSkill[] = [
  { name: "feishu-skill-maker", body: FEISHU_SKILL_MAKER },
  { name: "feishu-find-skill", body: FEISHU_FIND_SKILL },
  { name: "feishu-latex-rendering", body: FEISHU_LATEX_RENDERING },
  { name: "process-optimization-biweekly", body: PROCESS_OPTIMIZATION_BIWEEKLY },
];
