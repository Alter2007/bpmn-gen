# bpmn-gen：自然语言 → BPMN 2.0（Flowable）审批流生成器

**当前阶段：S0 契约 + S1 内核 + S2 修复 + S3 自然语言/大模型 + L2 官方 XSD 校验 + L4 实例运行（核心零依赖，无需 `npm install`）**

**演示视频**：[B 站 · BV1FvHA6YEyP](https://www.bilibili.com/video/BV1FvHA6YEyP/) —— P1 大模型版（2:14）/ P2 离线模式（2:38）
（视频录制于 `30b4f85`，展示的是**形态 ① 命令行版**；仓库当前还包含形态 ② 桌面应用版）

**一条命令复现全部验证**：`verify-all.cmd` → 六层全绿（126 项断言 / XSD 28 文件 / 引擎校验 28/28 / 实例运行 6/6）

核心设计思想：**绝不让大模型直接产出 XML**。模型只产出结构化 IR，XML 由确定性代码生成——这样命名空间、id、坐标、标签闭合在物理上就不可能出错。

```
自然语言 ──(大模型：只出模板+槽位)──> IR(JSON) ──> 校验 ──> 序列化 ──> BPMN XML (含 DI)
                                             L0/L3      确定性        L1
```

> **本仓库有两种形态，别搞混**：
> **① 命令行版**（⭐ 演示视频展示的就是这一版）｜**② 桌面应用版**（视频之后新增）。
> 两者共用同一套内核，产出的 BPMN 逐字节一致。详见 [两种形态](#两种形态重要先看这里)。

## 快速开始

```bat
:: 0) 一句话直接出图（离线，不需要任何 API Key）
nl2bpmn.cmd "我要做一个差旅报销审批流，金额小于1000主管批，超过5000财务复核" -o travel.bpmn

:: 看看有哪些模板
nl2bpmn.cmd --list

:: 1) 有 IR 的话，直接生成
bpmn-gen.cmd test\cases\travel-expense.json -o travel.bpmn

:: 2) 脏 IR 自动修复
bpmn-gen.cmd test\cases-repairable\dirty.json --repair --verbose -o fixed.bpmn

:: 3) 只看 XML 不写文件
bpmn-gen.cmd test\cases\leave-request.json --stdout

:: 4) 跑全部测试（正向 2 / 反向 1 / 可修复 1 / 自然语言 8）
node test\run.js
```

## 两种形态（重要：先看这里）

本仓库包含**同一引擎的两种形态**。演示视频里展示的是**形态 ①**；形态 ② 是视频之后新增的增强外壳。

| | **形态 ① · 命令行版**<br>（⭐ 演示视频展示的就是这一版） | **形态 ② · 桌面应用版**<br>（视频之后新增） |
|---|---|---|
| 对应提交 | `30b4f85` 及之前 | `4743c8a` 之后（当前 `main`） |
| 怎么打开 | 终端里跑 `demo.cmd` | **双击桌面图标** |
| 要不要命令行 | **要** | **不要** |
| Key 从哪来 | `dev-shell.cmd -WithKey` 或环境变量 | 界面「设置」页**直接粘贴** |
| 窗口形态 | 普通浏览器标签页 | 无地址栏、无标签页的应用窗口 |
| 关闭之后 | 手动 `Ctrl+C` | 约 35 秒服务自动退出，Key 随之消失 |
| 涉及文件 | `demo.cmd`、`dev-shell.cmd` | `创建桌面快捷方式.cmd`、`启动应用.vbs`、`停止应用.vbs` |
| 是否出现在视频里 | **是** | 否 |

> **两者共用同一套 `src/` 生成内核与同一套六层校验，产出的 BPMN 逐字节一致。**
> 差别只在"外壳"：① 你自己开服务、自己开浏览器；② 一个 VBS 静默拉起服务并打开应用样式窗口。

### 想精确复现视频里的版本

```bat
git checkout 30b4f85
demo.cmd
```

看完可以 `git checkout main` 回到最新版。

---

### 形态 ① · 命令行版（⭐ 视频演示 / 比赛提交对应这一版）

```bat
:: 启动服务并自动打开浏览器（默认 8099）
demo.cmd

:: 换端口
node web\serve.js 8100
```

Key 有两种给法：

```bat
:: ① 交互式录入（推荐：Key 不进命令历史、不落盘）
dev-shell.cmd -WithKey

:: ② 自己设环境变量
set DEEPSEEK_API_KEY=sk-...
```

没设 Key 也能用——侧栏显示「无密钥(仅模板)」，生成自动退回离线模板匹配。

### 形态 ② · 桌面应用版（视频之后新增）

**第一次用（只需一次）**：双击 `创建桌面快捷方式.cmd` → 桌面出现「BPMN 生成器」图标。
（`.lnk` 含本机绝对路径，所以不进仓库；这个脚本是**现场生成**快捷方式的，克隆下来也能用。）

**以后每次**：双击桌面图标，会发生两件事：

1. 后台**静默启动服务**（不弹黑窗口）
2. 打开一个**无地址栏、无标签页**的窗口 —— 看起来就是个桌面软件

然后：左侧「设置」→ 粘贴 `sk-…` 开头的密钥 → 保存 → 侧栏变绿点「已就绪」→ 回「生成」页开始用。

| 文件 | 作用 |
|---|---|
| `创建桌面快捷方式.cmd` | 在桌面生成快捷方式（只需一次） |
| `启动应用.vbs` | 静默起服务 + 开应用窗口；**会先结束上一次的残留进程**，保证干净启动 |
| `停止应用.vbs` | 停止本地服务 |

> 关掉窗口后约 35 秒，服务和内存里的 Key 会一起消失，下次打开是干净状态。
> 这是有意设计的——避免残留进程一直占着旧密钥。

---

### 两种形态共同的界面

| 页面 | 内容 |
|---|---|
| 生成 | 输入一句话 → 生成 → 可视化 → 下载 .bpmn / 复制 XML |
| 模板库 | 8 个模板的 ID、说明、关键词、节点/连线规模 |
| 验证报告 | 六层验证结果（含 L4 实例运行） |
| 设置 | 粘贴 API Key（仅形态 ②）、供应商、模型、接口地址、计数、退出应用 |

**密钥安全**：界面粘贴的密钥只进进程内存，不写文件、不写日志、不进命令历史；
接口只返回掩码（`sk-ab…wxyz`），服务端日志只打长度。服务只监听 `127.0.0.1`，局域网无法访问。

服务前台运行：不注册系统服务、不建数据库、不写注册表；生成逻辑是同进程 `require` 核心模块完成的，
不 spawn 子进程（P-04 不破例）。

## 自然语言直接生成（S3，离线）

`nl2bpmn` 把一句话变成 BPMN，全程不联网、不调 API：

```
业务描述 ──① 关键词加权匹配──> 模板 ──② 抽取数字/名词──> 槽位 ──③ 渲染──> IR ──④ 管线──> BPMN
```

匹配打分 = **关键词长度 × 出现次数**（不是简单的"出现过就算"，所以"采购"出现两次会压过"部门"出现一次）。

### 内置 8 个模板

| 模板 | 适用 | 结构 | 可参数化 |
|---|---|---|---|
| `amount_tiered` | 金额分级审批 | 排他网关三分支 | 两档阈值、变量名 |
| `leave_days` | 请假天数审批 | 排他网关两分支 | 免升级天数 |
| `expense_reimburse` | 费用报销串行 | 线性四步 | — |
| `purchase_request` | 采购申请分级 | 排他网关三分支 | 两档阈值 |
| `contract_review` | 合同并行会签 | 并行网关汇合 | — |
| `onboarding_parallel` | 入职办理 | 并行网关汇合 | — |
| `seal_apply` | 用章申请 | 线性三步 | — |
| `simple_approval` | 单级审批 | 线性 | 审批人 |

### 实测

输入需求文档里的原句：

> 我要做一个差旅报销审批流，金额小于1000直接主管批，大于1000需要总监批，超过5000需要财务复核

输出（模板得分 14，自动提取 `tier1=1000, tier2=5000`）：

```xml
<bpmn:exclusiveGateway id="Gateway_1" name="报销金额判断" default="Flow_5">
<bpmn:sequenceFlow id="Flow_3" name="≤1000" ...>
  <bpmn:conditionExpression><![CDATA[${amount <= 1000}]]></bpmn:conditionExpression>
<bpmn:sequenceFlow id="Flow_4" name="1000~5000" ...>
  <bpmn:conditionExpression><![CDATA[${amount > 1000 && amount <= 5000}]]></bpmn:conditionExpression>
```

### 为什么"先模板、后大模型"

这是本项目的关键取舍：

| 做法 | 一次成功率 | 可预测性 | 演示稳定性 |
|---|---|---|---|
| 纯大模型自由生成 IR | 中 | 低（每次不同） | 有风险 |
| **模板匹配 + 槽位填充** | **高** | **高**（确定性） | **稳** |
| 大模型只负责"选模板 + 填槽位"（S3 下一步） | 最高 | 高 | 稳 |

离线模板已经能覆盖典型审批流场景，**没有 Key 也能演示完整链路**；接入大模型后，它只做"选模板 + 填参数"这一件小事，出错面被压到最小。

产物默认写到工作区的 `.data\out\`，不会到处乱丢。

## 大模型通道（S3，需要 Key）

### 供应商：默认 DeepSeek，可一键切百炼

| 供应商 | 接口 | 默认模型 | Key 变量 | 控制台 |
|---|---|---|---|---|
| **deepseek**（默认） | `https://api.deepseek.com` | `deepseek-flash` | `DEEPSEEK_API_KEY` | [platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys) |
| dashscope | `.../compatible-mode/v1` | `qwen-plus` | `DASHSCOPE_API_KEY` | [bailian.console.aliyun.com](https://bailian.console.aliyun.com/) |

```bat
:: 切到通义千问（答辩若被问"是不是开源 Qwen"，一条命令即可演示）
set LLM_PROVIDER=dashscope
```

> **模型名以厂商控制台为准**，且会随迭代变化。先用 `ai2bpmn.cmd --models` 查一次，再决定是否 `set LLM_MODEL=...`。

### 三条命令

```bat
dev-shell.cmd -WithKey     :: 录入 Key（不回显、不落盘、不进命令历史）
ai2bpmn.cmd --models       :: 确认当前 Key 可用的模型名
ai2bpmn.cmd "描述"          :: 真实调用，出 BPMN
run-llm-tests.cmd          :: 8 条用例批量回归，出一次通过率报告
```

### Key 的安全约定（P-05）

- Key 只从环境变量读取，不写文件、不写日志、不打印；
- 录入走 `dev-shell -WithKey`（SecureString），只存在于该窗口内存；
- **不要把 Key 发给任何人或任何 AI**。协作时提供的是「运行结果」，不是 Key。

## IR 契约

```json
{
  "id": "travel-expense",
  "name": "差旅报销审批流",
  "processKey": "travelExpense",
  "variables": [{ "name": "amount", "type": "number" }],
  "nodes": [
    { "id": "StartEvent_1", "type": "startEvent", "name": "发起报销" },
    { "id": "Task_Submit", "type": "userTask", "name": "提交报销单", "assignee": "${initiator}" },
    { "id": "Gateway_Amount", "type": "exclusiveGateway", "name": "金额判断" }
  ],
  "flows": [
    { "id": "Flow_3", "from": "Gateway_Amount", "to": "Task_Manager",
      "name": "≤1000", "condition": "${amount <= 1000}" },
    { "id": "Flow_5", "from": "Gateway_Amount", "to": "Task_Finance",
      "name": ">5000", "default": true }
  ]
}
```

### 节点类型

| type | 说明 | 支持的属性 |
|---|---|---|
| `startEvent` | 开始事件（必须有且仅有 1 个） | `name` |
| `endEvent` | 结束事件（至少 1 个） | `name` |
| `userTask` | 人工审批 | `assignee`、`candidateGroups`、`formKey` |
| `serviceTask` | 自动服务 | `expression`、`delegateExpression` |
| `exclusiveGateway` | 排他网关（多出向**必须**有 default） | `name` |
| `parallelGateway` | 并行网关（出向**不可**带条件） | `name` |
| `inclusiveGateway` | 包容网关 | `name` |

### 连线字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 唯一 |
| `from` / `to` | 是 | 节点 id |
| `condition` | 否 | Flowable 表达式，如 `${amount > 1000}` |
| `default` | 否 | 同一源节点最多 1 条，序列化时自动写成网关的 `default` 属性 |
| `name` | 否 | 连线文字（条件流建议写，评审看得懂） |

## 校验分层

| 层 | 实现 | 状态 |
|---|---|---|
| L0 契约（字段/类型/id 唯一/自环） | `src/ir.js` | ✅ 已实现 |
| L1 XML 良构（栈式配对/根元素唯一） | `src/xml-lint.js` | ✅ 已实现 |
| L3 图论语义（起止唯一/悬挂/不可达/死路/网关 default/并行不含条件） | `src/graph.js` | ✅ 已实现 |
| L2 BPMN 规范级（官方 OMG XSD） | `tools/xsd-validate/Validate.java`（JDK 17 单文件运行，零依赖） | ✅ 已实现并实测 |
| L2b 第三方模型校验（bpmn-moddle） | `web/check-model.js`（与 bpmn-js 同源的标准模型库） | ✅ 16/16 通过 |
| L4-lite 引擎解析 + 流程校验（Flowable 自己的代码） | `tools/flowable-check/FlowableCheck.java`（jar 按需下载到 `.cache`） | ✅ **28/28 通过** |
| L4 实例运行（真实部署 + 执行 + 路径断言） | `tools/flowable-run/FlowableRun.java`（Flowable + H2 内存引擎） | ✅ **6/6 通过** |

## 为什么一定要有 DI

BPMN XML 分两半：`<bpmn:process>` 是**逻辑**，`<bpmndi:BPMNDiagram>` 是**坐标**。

只生成逻辑段，引擎能部署、能跑，但用 bpmn-js 打开是**一片空白**——演示当场翻车。所以 `src/layout.js` 用最长路径法自动分层排版，序列化时一并输出 Shape 和 Edge。反向用例测试会断言 Shape 数 == 节点数、Edge 数 == 连线数。

## 目录

```
bpmn-gen/                    73 个文件
├─ 【形态 ①：命令行】根目录启动器
│  ├─ demo.cmd               起服务 + 开浏览器
│  ├─ nl2bpmn.cmd            一句话 → BPMN（离线）
│  ├─ ai2bpmn.cmd            一句话 → BPMN（大模型）
│  ├─ bpmn-gen.cmd           IR → BPMN
│  ├─ verify-all.cmd         六层验证一条命令跑完
│  └─ validate-xsd.cmd / flowable-check.cmd / flowable-run.cmd / run-llm-tests.cmd
│
├─ 【形态 ②：桌面应用】桌面启动器
│  ├─ 创建桌面快捷方式.cmd    在桌面生成图标（只需一次）
│  ├─ create-shortcut.ps1    上面那个的实现（现场生成，不依赖 .lnk）
│  ├─ 启动应用.vbs           静默起服务 + 开应用窗口
│  ├─ 停止应用.vbs           停止本地服务
│  └─ assets/                app.ico / app-256.png
│
├─ bin/                      CLI 入口（3 个）
├─ src/                      生成内核（零依赖，18 个文件）
│  ├─ ir.js                  L0 契约校验
│  ├─ graph.js               L3 图论语义校验
│  ├─ layout.js              自动布局 + DI 坐标
│  ├─ serialize.js           IR → BPMN XML
│  ├─ xml-lint.js            L1 XML 良构检查
│  ├─ repair.js              S2 确定性修复器
│  ├─ nl.js                  S3 关键词匹配 + 槽位抽取
│  ├─ prompt.js              提示词与模型输出解析
│  ├─ llm.js                 大模型供应商适配（DeepSeek / 百炼）
│  ├─ pipeline.js            不可跳过的管线
│  └─ templates/             8 个审批流模板（JSON，可直接增删）
├─ web/                      Web 应用（唯一有依赖的目录）
│  ├─ index.html / app.js / styles.css
│  ├─ serve.js               本地服务（同进程 require 内核，不 spawn）
│  └─ check-model.js         bpmn-moddle 模型校验
├─ tools/                    Java 单文件验证器（3 个）
│  ├─ xsd-validate/          L2 OMG 官方 XSD
│  ├─ flowable-check/        L4-lite 引擎解析与过程校验
│  └─ flowable-run/          L4 实例运行 + 路径断言
├─ test/                     126 项断言（正向 / 反向 / 可修复 / 自然语言 / 提示词 / 脚本卫生）
├─ scripts/                  零依赖工具（原则检查、批量回归、schema/jar 下载）
├─ docs/                     8 份文档
│  ├─ bpmn-gen-report.pdf    作品介绍（11 页）
│  ├─ ARCHITECTURE.md        架构与设计决策（答辩材料）
│  ├─ DELIVERABLES.md        交付清单与三分钟复现
│  ├─ VIDEO-SCRIPT.md        视频脚本
│  ├─ DEMO-EXAMPLES.md       演示示例与预期结果
│  ├─ THIRD-PARTY.md         第三方许可清单
│  └─ build-report.py        PDF 生成脚本
├─ PRINCIPLES.md             项目宪法（11 条，10 条自动检查）
├─ LICENSE / NOTICE          Apache-2.0 + 大模型辅助声明
└─ .gitignore / .gitattributes
```

## 开源合规声明

本项目由开发者主导架构设计与核心实现；部分辅助代码由大模型生成，经人工审查与重构，确保无 GPL/AGPL 传染性代码污染。

| 项 | 内容 |
|---|---|
| 许可证 | **Apache License 2.0** —— [LICENSE](LICENSE)、[NOTICE](NOTICE) |
| 第三方组件 | [docs/THIRD-PARTY.md](docs/THIRD-PARTY.md)，当前运行时依赖 **0 个** |
| 大模型辅助 | 已在 NOTICE 声明；核心逻辑（序列化/图论/布局）配自动化测试，测试即人工审查的证据 |
| 合规自检 | `node scripts\check-principles.js` 中的 **P-11** |

## 技术架构与答辩材料

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)：分层架构图、**5 个关键设计决策**（含被否决的备选方案）、**3 个核心难点**、常见追问的标准回答
- [PRINCIPLES.md](PRINCIPLES.md)：11 条工程原则，10 条自动检查

## 验证记录

两种使用方式共用同一套验证，一条命令跑完全部六层：`verify-all.cmd`

| # | 层 | 手段 | 结果 |
|---|---|---|---|
| 1 | 单元/回归 | `node test\run.js`（正向/反向/可修复/自然语言/提示词/脚本卫生） | ✅ **126 项断言** |
| 2 | L1 良构 | 自研 `xml-lint.js` | ✅ |
| 3 | L2 规范 | **OMG 官方 XSD** + JDK 17 单文件校验器 | ✅ **28/28 文件** |
| 4 | L2b 模型 | **第三方 bpmn-moddle** | ✅ **28/28 文件** |
| 5 | L4-lite 引擎 | **Flowable 7.2.0** 的 `BpmnXMLConverter` + `ProcessValidator` | ✅ **28/28 文件** |
| 6 | **L4 实例运行** | **Flowable + H2 内存引擎**：部署 → 启动实例 → 自动完成任务 → **路径断言** | ✅ **6/6 场景** |
| — | 大模型端到端 | `run-llm-tests.cmd`（真实调用 8 条用例） | ✅ 8/8（100%） |

**L4 实测路径（同一文件、不同变量走不同分支）**：

```
amount=800   → 提交报销单 → 主管审批
amount=2500  → 提交报销单 → 总监审批
amount=6000  → 提交报销单 → 财务复核
days=2       → 填写请假单 → 直属主管审批
days=9       → 填写请假单 → 人事备案
合同会签     → 提交 → 法务/财务/业务三方并行 → 汇总结束
```

**两个真实收获**：

1. Flowable 的 `ProcessValidator` 抓到我们自研图论校验漏掉的规则——「默认流不允许带条件」，已补进 `src/graph.js`；
2. 实例运行验证了**条件表达式真的在起作用**：同一份 BPMN，金额不同走的审批人确实不同。

## 环境原则（项目宪法）

完整版见 [PRINCIPLES.md](PRINCIPLES.md)：**10 条原则**，其中 9 条由代码自动检查，红灯即不得产出。

```bat
node scripts\check-principles.js
```

| 编号 | 原则 | 检查方式 |
|---|---|---|
| P-01 | 磁盘边界：产物不出工作区 | 扫源码里的 `APPDATA`/`os.tmpdir` 等 |
| P-02 | 零依赖优先 | 依赖字段为空 + 无 `node_modules` |
| P-03 | 不碰系统层 | 扫 `reg add`/`sc create`/`setx` |
| P-04 | 进程边界：前台运行 | 扫 `child_process` |
| P-05 | 密钥不落地 | 扫硬编码密钥特征 |
| P-06 | 生成物确定性 | 两次序列化比对字节 |
| P-07 | 模型不直接产出 XML | 校验调用顺序 + 拒绝非 IR 输入 |
| P-08 | 校验不可跳过 | 坏图必须报错、好图必须零错 |
| P-09 | 可归零 | `.gitignore` 覆盖 + 项目内无 `*.bpmn` |
| P-10 | 诚实（未验证不得声称） | 人工守则 |

## 环境约束（本项目强约束）

- **零运行时依赖**：不需要 `npm install`，不需要 `node_modules`。
- 引擎验证只在 S5 用 `java -jar` 前台跑，不注册服务。
- 所有产物落在工作区内（`.data\out\`），交付完 `clean.cmd -All -Force` 一键归零。
- LLM 密钥只在运行时从环境变量读（`DASHSCOPE_API_KEY`），不写进仓库、不写进日志。
