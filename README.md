# bpmn-gen：自然语言 → BPMN 2.0（Flowable）审批流生成器

**当前阶段：S0 契约 + S1 内核 + S2 修复 + S3 自然语言/大模型 + L2 官方 XSD 校验（核心零依赖，无需 `npm install`）**

核心设计思想：**绝不让大模型直接产出 XML**。模型只产出结构化 IR，XML 由确定性代码生成——这样命名空间、id、坐标、标签闭合在物理上就不可能出错。

```
自然语言 ──(S3 待做)──> IR(JSON) ──> 校验 ──> 序列化 ──> BPMN XML (含 DI)
                                    L0/L3     确定性         L1
```

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

## Web 应用（本地）

```bat
demo.cmd                    :: 启动服务并自动打开浏览器（默认 8099）
node web\serve.js 8100      :: 换端口
```

| 页面 | 内容 |
|---|---|
| 生成 | 输入一句话 → 生成 → 可视化 → 下载 .bpmn / 复制 XML |
| 模板库 | 8 个模板的 ID、说明、关键词、节点/连线规模 |
| 验证报告 | 五层验证结果（含 L4-lite 边界说明） |
| 设置 | 供应商、模型、接口地址、密钥状态、计数 |

**关于密钥**：服务从 `process.env` 读 Key，页面上会显示当前状态。

- 普通窗口启动 → 侧栏显示「无密钥(仅模板)」，生成自动退回离线模板匹配；
- 在 `dev-shell -WithKey` 窗口启动 → 走真实大模型，侧栏显示「已就绪」。

服务只监听 `127.0.0.1`，前台运行、`Ctrl+C` 即停；不注册服务、不建数据库、不写注册表。
生成逻辑是**同进程直接 require 核心模块**完成的，不 spawn 子进程（P-04 不破例）。

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
| L4-lite 引擎解析 + 流程校验（Flowable 自己的代码） | `tools/flowable-check/FlowableCheck.java`（jar 按需下载到 `.cache`） | ✅ **19/19 通过** |
| L4 实例运行（真实部署 + 执行 + 路径断言） | `tools/flowable-run/FlowableRun.java`（Flowable + H2 内存引擎） | ✅ **6/6 通过** |

## 为什么一定要有 DI

BPMN XML 分两半：`<bpmn:process>` 是**逻辑**，`<bpmndi:BPMNDiagram>` 是**坐标**。

只生成逻辑段，引擎能部署、能跑，但用 bpmn-js 打开是**一片空白**——演示当场翻车。所以 `src/layout.js` 用最长路径法自动分层排版，序列化时一并输出 Shape 和 Edge。反向用例测试会断言 Shape 数 == 节点数、Edge 数 == 连线数。

## 目录

```
bpmn-gen/
├─ bin/
│  ├─ bpmn-gen.js        IR -> BPMN 的 CLI
│  └─ nl2bpmn.js         自然语言 -> BPMN 的 CLI（离线）
├─ src/
│  ├─ ir.js              L0 契约校验
│  ├─ graph.js           L3 图论语义校验
│  ├─ layout.js          自动布局 + DI 坐标
│  ├─ serialize.js       IR -> BPMN XML
│  ├─ xml-lint.js        L1 XML 良构检查
│  ├─ repair.js          S2 确定性修复器
│  ├─ nl.js              S3 匹配 + 抽取 + 渲染
│  ├─ pipeline.js        不可跳过的管线（修复→校验→序列化→良构）
│  └─ templates/         8 个审批流模板（JSON，可直接增删）
├─ test/
│  ├─ run.js             69 项断言
│  ├─ cases/             正向用例
│  ├─ cases-bad/         反向用例（必须被拒绝）
│  ├─ cases-repairable/  可修复用例（不修必败、修完必过）
│  └─ nl-cases.json      自然语言用例
├─ docs/
│  ├─ ARCHITECTURE.md    架构与设计决策（答辩材料）
│  └─ THIRD-PARTY.md     第三方许可清单
├─ scripts/
│  └─ check-principles.js 11 条原则的自动检查（10 条机检）
├─ PRINCIPLES.md         项目宪法
├─ LICENSE               Apache-2.0
└─ NOTICE                大模型辅助生成声明
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

一条命令跑完全部五层：`verify-all.cmd`

| # | 层 | 手段 | 结果 |
|---|---|---|---|
| 1 | 单元/回归 | `node test\run.js`（正向/反向/可修复/自然语言/提示词/脚本卫生） | ✅ 118 项断言 |
| 2 | L1 良构 | 自研 `xml-lint.js` | ✅ |
| 3 | L2 规范 | **OMG 官方 XSD** + JDK 17 单文件校验器 | ✅ 16/16 文件 |
| 4 | L2b 模型 | **第三方 bpmn-moddle** | ✅ 16/16 文件 |
| 5 | L4-lite 引擎 | **Flowable 7.2.0** 的 `BpmnXMLConverter` + `ProcessValidator` | ✅ 19/19 文件 |
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
