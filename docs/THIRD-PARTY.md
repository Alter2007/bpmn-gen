# 第三方组件与许可证清单

本清单用于开源合规审查。原则：**只用宽松许可证（Apache-2.0 / MIT / BSD / MPL-2.0），不引入 GPL / AGPL / LGPL 传染性代码。**

## 当前运行时依赖

**0 个。**

`package.json` 的 `dependencies` 与 `devDependencies` 均为空，`node_modules` 不存在。
克隆仓库后 `node bin/bpmn-gen.js` 直接可用，无需 `npm install`。

## 依赖清单（已引入 / 计划引入）

> 按 P-10 原则标注清楚：以下均为**计划**，当前代码中不存在。

| 组件 | 用途 | 许可证 | 引入阶段 | 传染性风险 |
|---|---|---|---|---|
| `bpmn-moddle`（v10.3.1） | **第三方模型校验（已引入，L2b）** | MIT | ✅ 已装入 `web/node_modules` | 无 |
| `flowable-bpmn-moddle` | Flowable 方言的 moddle 描述 | MIT | 计划 | 无 |
| Flowable Engine | S5 真实部署验证 | Apache-2.0 | S5（仅验证用，不进入交付代码） | 无 |
| H2 Database | 内存库 | MPL-2.0 或 EPL-1.0（双许可） | S5 | 无（作为独立依赖使用，不修改其源码、不静态链接进本项目代码） |
| bpmn-js | 前端渲染演示 | MIT | ✅ 已装入 `web/node_modules` | 无 |

## 运行期下载的规范文件（不随仓库分发）

| 文件 | 来源 | 说明 |
|---|---|---|
| `BPMN20.xsd`、`BPMNDI.xsd`、`Semantic.xsd`、`DC.xsd`、`DI.xsd` | [OMG BPMN 2.0 规范](https://www.omg.org/spec/BPMN/20100501/) | 由 `scripts/fetch-schema.js` 按需下载到 `.cache/schema/`，仅用于本地 XSD 校验；**不提交进仓库**（避免再分发条款问题，也符合 P-09 可归零） |

## 合规判断依据

1. **Apache-2.0 与本项目兼容**：MIT / BSD / MPL-2.0 / Apache-2.0 均可被 Apache-2.0 项目直接依赖。
2. **MPL-2.0 是文件级弱传染**：只要不修改其源文件，引用不受影响。H2 仅作为运行时依赖。
3. **引擎只用于验证**：Flowable 与 H2 只出现在 `verify/` 的验证流程中，不进入生成器本体，因此不构成"衍生作品"。
4. **不使用任何 GPL / AGPL 组件**。

## 大模型辅助代码声明

部分辅助代码由大模型生成，经人工审查、重构与测试。本项目核心逻辑（序列化器、图论校验、布局算法）配有可复现的自动化测试，测试即是最直接的人工审查证据。

## 许可

本项目本体：**Apache License 2.0**，见 [LICENSE](../LICENSE) 与 [NOTICE](../NOTICE)。
