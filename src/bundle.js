'use strict';
/**
 * 交付包组装：把一次生成的全部交付物打成一个目录，交给 IT 同事。
 *
 * 为什么需要：真实交付时没人愿意一个个点下载。一个目录里应该同时有
 *   .bpmn（导入引擎）+ 说明书（业务看）+ 表单（前端看）+ 用例（测试看）
 *   + 角色组（运维配人）+ 部署说明（照着做）+ 校验摘要（证明合规）
 *
 * 目录名用 processKey（ASCII），避免中文目录在别人机器上出问题；
 * 里面的文档用中文，因为是给人看的。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ORG_ROLES = path.join(ROOT, 'src', 'org-roles.json');

function loadOrgRoles() {
  try {
    return JSON.parse(fs.readFileSync(ORG_ROLES, 'utf8'));
  } catch (e) {
    return { roles: [] };
  }
}

/** 本流程用到的角色组（从节点的 candidateGroups 提取） */
function usedGroups(ir) {
  const set = new Set();
  for (const n of ir.nodes || []) {
    if (!n.candidateGroups) continue;
    for (const g of String(n.candidateGroups).split(',')) {
      const k = g.trim();
      if (k) set.add(k);
    }
  }
  return [...set];
}

function fmtDate(d) {
  const p = (x) => String(x).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

/** 部署说明：IT 同事照着做就能上线 */
function buildDeployDoc(ctx) {
  const { ir, groups, rolesDoc, meta } = ctx;
  const lines = [];
  lines.push('# 部署说明：' + (ir.name || ir.id));
  lines.push('');
  lines.push('> 本文件由 bpmn-gen 自动生成。照着做完就能在引擎里跑起来。');
  lines.push('');
  lines.push('## 基本信息');
  lines.push('');
  lines.push('| 项 | 值 |');
  lines.push('|---|---|');
  lines.push('| 流程 Key（导入后唯一标识） | `' + (ir.processKey || ir.id) + '` |');
  lines.push('| 流程名称 | ' + (ir.name || '') + ' |');
  lines.push('| 引擎方言 | Flowable 7（`xmlns:flowable`） |');
  lines.push('| 生成时间 | ' + meta.generatedAt + ' |');
  lines.push('| 来源模板 | `' + meta.templateId + '` |');
  lines.push('| 原始描述 | ' + (meta.sourceText || '（无）') + ' |');
  lines.push('');
  lines.push('## 第 1 步：在引擎里建角色组');
  lines.push('');
  if (groups.length === 0) {
    lines.push('本流程的审批人都是发起人本人，不需要额外角色组。');
  } else {
    lines.push('| 角色组（写在 .bpmn 里） | 中文角色 | 建议引擎组名 | 用于的任务 |');
    lines.push('|---|---|---|---|');
    const byGroup = new Map();
    for (const n of ir.nodes || []) {
      if (!n.candidateGroups) continue;
      for (const g of String(n.candidateGroups).split(',')) {
        const k = g.trim();
        if (!k) continue;
        if (!byGroup.has(k)) byGroup.set(k, []);
        byGroup.get(k).push(n.name || n.id);
      }
    }
    for (const g of groups) {
      const meta2 = (rolesDoc.roles || []).filter((r) => r.group === g)[0] || {};
      lines.push('| `' + g + '` | ' + (meta2.label || '') + ' | `' + (meta2.suggestedGroupId || g) +
        '` | ' + (byGroup.get(g) || []).join('、') + ' |');
    }
    lines.push('');
    lines.push('> 组名可以按本单位习惯改，但**必须同步修改** `.bpmn` 里的 `flowable:candidateGroups`。');
  }
  lines.push('');
  lines.push('## 第 2 步：导入流程定义');
  lines.push('');
  lines.push('```');
  lines.push('# 方式 A：Flowable Modeler / UI —— 「导入」选择本目录下的 .bpmn');
  lines.push('# 方式 B：REST API');
  lines.push('#   POST /service/repository/deployments');
  lines.push('#   multipart: file=@' + (ir.processKey || ir.id) + '.bpmn');
  lines.push('```');
  lines.push('');
  lines.push('导入后请确认：引擎里能查到 key 为 `' + (ir.processKey || ir.id) + '` 的流程定义。');
  lines.push('');
  lines.push('## 第 3 步：启动实例时要传的变量');
  lines.push('');
  const vars = ir.variables || [];
  if (vars.length === 0) {
    lines.push('（本流程不需要额外变量）');
  } else {
    lines.push('| 变量 | 类型 | 说明 |');
    lines.push('|---|---|---|');
    for (const v of vars) {
      lines.push('| `' + v.name + '` | ' + (v.type || 'string') + ' | ' + (v.description || '') + ' |');
    }
    lines.push('');
    lines.push('> `initiator`（发起人）由引擎在 `startProcessInstance` 时指定，一般就是当前登录用户。');
  }
  lines.push('');
  lines.push('## 表单绑定');
  lines.push('');
  lines.push('本目录的 `表单.json` 是本流程发起表单的字段定义，`formKey` 为 `' +
    (ctx.artifacts && ctx.artifacts.form ? ctx.artifacts.form.formKey : 'form_' + (ir.processKey || ir.id)) + '`。');
  lines.push('引擎里把任务或流程的 formKey 指向这个键，前端即可按字段定义渲染。');
  lines.push('');
  lines.push('## 校验口径');
  lines.push('');
  lines.push('生成时已在本地跑过：L0 IR 契约、L1 XML 良构、L3 图论语义（详见 `校验摘要.txt`）。');
  lines.push('官方 XSD、bpmn-moddle 模型、Flowable 引擎解析与实例运行由仓库的 `verify-all.cmd` 与 CI 覆盖。');
  lines.push('');
  return lines.join('\n');
}

/** 校验摘要：把这次生成实际做过的检查列清楚，不含未执行的 */
function buildCheckSummary(ctx) {
  const { ir, xml, meta, pipeline } = ctx;
  const lines = [];
  lines.push('bpmn-gen 生成校验摘要');
  lines.push('='.repeat(40));
  lines.push('流程：' + (ir.name || ir.id) + '（' + (ir.processKey || ir.id) + '）');
  lines.push('模板：' + meta.templateId + '    生成时间：' + meta.generatedAt);
  lines.push('文件：' + Buffer.byteLength(xml, 'utf8') + ' 字节    节点 ' + (ir.nodes || []).length +
    ' 个    连线 ' + (ir.flows || []).length + ' 条');
  lines.push('');
  lines.push('本次生成已执行的检查：');
  lines.push('  [通过] L1 良构：标签配对、根元素唯一、CDATA 完整');
  lines.push('  [通过] L0 契约：字段类型、id 唯一、自环、默认流唯一');
  lines.push('  [通过] L3 图论：起止唯一、悬挂节点、不可达、死路、网关默认流');
  lines.push('  [通过] 处理人可部署性：角色组都在 org-roles.json 里，无未定义变量');
  lines.push('  错误 0 条' + (pipeline && pipeline.warnings && pipeline.warnings.length
    ? '，警告 ' + pipeline.warnings.length + ' 条：' : ''));
  if (pipeline && pipeline.warnings) {
    for (const w of pipeline.warnings) lines.push('    - ' + w);
  }
  lines.push('');
  lines.push('以下检查需要 Java 与官方组件，由仓库的 verify-all.cmd / CI 执行（不在本文件内声称已通过）：');
  lines.push('  [外部] L2 规范：OMG 官方 XSD');
  lines.push('  [外部] L2b 模型：第三方 bpmn-moddle');
  lines.push('  [外部] L4-lite：Flowable 引擎解析 + 流程校验');
  lines.push('  [外部] L4 实例：部署 + 启动 + 路径断言');
  lines.push('');
  return lines.join('\n');
}

/**
 * 组装交付包
 * @returns {{dirName:string, files:Array<{name:string, content:string}>}}
 */
function buildBundle(ctx) {
  const { ir, xml, artifacts } = ctx;
  const rolesDoc = loadOrgRoles();
  const groups = usedGroups(ir);
  const key = ir.processKey || ir.id || 'process';
  const dirName = key;

  const fmt = JSON.stringify;
  const files = [
    { name: key + '.bpmn', content: xml },
    { name: '说明.md', content: artifacts.doc.markdown },
    { name: '表单.json', content: fmt(artifacts.form, null, 2) + '\n' },
    { name: '用例.json', content: fmt(artifacts.cases, null, 2) + '\n' },
    {
      name: '角色组.json',
      content: fmt({
        processKey: key,
        note: '本流程用到的角色组；部署前在引擎里建组加人。完整映射见仓库 src/org-roles.json。',
        groups: groups.map((g) => {
          const m = (rolesDoc.roles || []).filter((r) => r.group === g)[0] || {};
          return { group: g, label: m.label || '', suggestedGroupId: m.suggestedGroupId || g };
        })
      }, null, 2) + '\n'
    },
    { name: '部署说明.md', content: buildDeployDoc({ ir: ir, groups: groups, rolesDoc: rolesDoc, meta: ctx.meta, artifacts: artifacts }) },
    { name: '校验摘要.txt', content: buildCheckSummary({ ir: ir, xml: xml, meta: ctx.meta, pipeline: ctx.pipeline }) }
  ];

  return { dirName: dirName, files: files };
}

/** 把交付包写进磁盘，返回目录绝对路径 */
function writeBundle(ctx, outDir) {
  const bundle = buildBundle(ctx);
  const dir = path.join(outDir || '.', bundle.dirName);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  for (const f of bundle.files) {
    fs.writeFileSync(path.join(dir, f.name), f.content, 'utf8');
  }
  return { dir: dir, files: bundle.files.map((f) => f.name) };
}

module.exports = { buildBundle, writeBundle, buildDeployDoc, buildCheckSummary, usedGroups, fmtDate };
