# 交付清单与验收步骤

> 给评委 / 接手人用：三分钟看清楚「交了什么、怎么跑、证据在哪」。

## 一、提交物对照

参赛要求三件，当前状态：

| 要求 | 文件 / 位置 | 状态 |
|---|---|---|
| 代码仓库链接 | [github.com/Alter2007/bpmn-gen](https://github.com/Alter2007/bpmn-gen)（67 文件 / 3 次提交，Public，Apache-2.0） | ✅ 已上线 |
| 作品介绍文档（推荐 PDF） | [`docs/bpmn-gen-report.pdf`](docs/bpmn-gen-report.pdf)（11 页） | ✅ 已完成 |
| 作品演示视频链接 | [B 站 BV1FvHA6YEyP](https://www.bilibili.com/video/BV1FvHA6YEyP/)（P1 大模型版 2:14 / P2 离线版 2:38） | ✅ 已发布 |

## 二、环境要求

| 依赖 | 版本 | 说明 |
|---|---|---|
| Node.js | ≥ 18（本机 24.18） | 生成核心。**不需要 npm install**，没有 node_modules 也能跑 |
| JDK | ≥ 17（本机 17） | 仅验证用（XSD 校验、Flowable 引擎）。JDK 11+ 支持直接运行单文件源码 |
| 浏览器 | 任意现代浏览器 | 仅 Web 应用需要 |

> Web 应用的可视化依赖 `bpmn-js`，已装在 `web/node_modules`（8.8 MB）。这是唯一需要安装的部分，删掉即恢复。

## 三、三分钟复现

```bat
:: 1) 一句话生成（离线，不需要任何密钥）
nl2bpmn.cmd "我要做一个差旅报销审批流，金额小于1000主管批，超过5000财务复核"

:: 2) 六层验证一次跑完
verify-all.cmd

:: 3) 打开网页版
demo.cmd
```

`verify-all.cmd` 的输出应当是：

```
[1/6] unit tests ...                    通过 142 / 失败 0
[2/6] ensure BPMN 2.0 XSD cached ...
[3/6] official OMG XSD validation ...   validated: 19 files
[4/6] ensure Flowable jars ...
[5/6] Flowable engine parse + validation ...   通过 19 / 19
[6/6] L4 real instance run ...                 实例运行通过 6 / 6
ALL GREEN
```

## 四、证据清单

| 结论 | 证据 | 复现方式 |
|---|---|---|
| 生成的 BPMN 符合 BPMN 2.0 规范 | OMG 官方 XSD，19/19 通过 | `verify-all.cmd` 第 3 步 |
| 模型能被标准库建立 | 第三方 bpmn-moddle，19/19 | `web/check-model.js` |
| 引擎接受这份流程定义 | Flowable 7.2.0 解析 + 流程校验，19/19 | `verify-all.cmd` 第 5 步 |
| **流程实例能真的跑完** | Flowable + H2，6/6 场景路径断言 | `verify-all.cmd` 第 6 步 |
| 大模型端到端可用 | 真实调用 8 条业务描述，8/8 | `run-llm-tests.cmd` |
| 同输入同输出 | 两次序列化逐字节比对 | `test/run.js` |
| 工程环境零污染 | 环境基线与差异报告 | `env-snapshot.cmd` / `env-guard.cmd` |
| 开源合规 | LICENSE / NOTICE / THIRD-PARTY | 见 `docs/THIRD-PARTY.md` |

## 五、仓库结构

```
bpmn-gen/
├─ bin/             命令行入口（IR→BPMN、自然语言→BPMN、AI 生成）
├─ src/             生成核心（零依赖）：契约、图论、布局、序列化、修复、提示词、供应商
├─ src/templates/   8 个审批流模板（JSON，可直接增删）
├─ test/            142 项断言：正向 / 反向 / 可修复 / 自然语言 / 提示词 / 脚本卫生
├─ tools/           Java 验证器：XSD 校验、Flowable 流程校验、Flowable 实例运行
├─ web/             本地 Web 应用（生成 / 模板库 / 验证报告 / 设置）
├─ scripts/         零依赖工具：原则检查、批量回归、schema/jar 下载
├─ docs/            架构说明、第三方清单、作品文档（PDF）、视频脚本
├─ _env（上一级）    环境守卫：快照 / 体检 / 归零 / 受控 Shell
├─ PRINCIPLES.md    11 条工程原则（10 条自动检查）
└─ LICENSE / NOTICE Apache-2.0 + 大模型辅助声明
```

## 六、已知边界（诚实声明）

| 项 | 说明 |
|---|---|
| 模板覆盖 | 内置 8 个场景，未覆盖全部行业；新增场景需加 JSON 模板 |
| 大模型自由度 | 模型只能选模板 + 填槽位；描述超出模板能力时会被明确拒绝，而不是硬凑 |
| Web 应用定位 | 本地单机工具，无用户体系 / 无数据库 / 不对外暴露；不是多租户 SaaS |
| 引擎版本 | 验证基于 Flowable 7.2.0；Camunda 方言（`camunda:` 前缀）不支持 |
| XSD 来源 | OMG 官方 schema 按需下载到 `.cache`，**不随仓库分发**（避免再分发条款问题） |

## 七、清理与回滚

```bat
clean.cmd -All -Force     :: 删除 .cache / .tools / .data / 所有 node_modules
env-guard.cmd             :: 复检，应回到基线
```

项目的全部产物都在工作区内，删掉目录即回到开工前状态。
