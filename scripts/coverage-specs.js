#!/usr/bin/env node
'use strict';
/**
 * 分支覆盖自动化：
 *   对每个模板生成一份 BPMN（写入 .data/verify/cov-<id>.bpmn），
 *   再根据 artifacts.cases 里算好的分支样例值，生成 FlowableRun 的实例断言。
 *
 * 产出的 specs 文件每行一条：<bpmn 路径>|<变量赋值>|expectcontains=<目标节点 id>
 * 另外每个模板补一条"正常走完"的用例（不带断言，只要求流程能结束）。
 *
 * 用法：
 *   node scripts/coverage-specs.js            生成文件与 specs
 *   node scripts/coverage-specs.js --print    只打印，不写文件
 */
const fs = require('fs');
const path = require('path');
const { loadTemplates, buildFromTemplate } = require('../src/nl');
const { runPipeline } = require('../src/pipeline');
const { buildArtifacts } = require('../src/artifacts');

const OUT = path.join(__dirname, '..', '..', '.data', 'verify');
// 规格里的路径要能被 FlowableRun 解析：它按当前工作目录（项目根）相对定位
const SPEC_PREFIX = '..\\.data\\verify\\';
const SPEC_OUT = path.join(OUT, 'coverage-specs.txt');
const onlyPrint = process.argv.indexOf('--print') !== -1;

function varSpec(vars) {
  const keys = Object.keys(vars || {});
  if (keys.length === 0) return '';
  return keys.map((k) => {
    const v = vars[k];
    if (Array.isArray(v)) return k + '=' + v.join('+');
    return k + '=' + String(v);
  }).join(',');
}

/** 多实例模板需要一个 approvers 列表变量，否则引擎起不来 */
function defaultsFor(tpl, ir) {
  const miNode = (tpl.nodes || []).find((n) => n.multiInstance && n.multiInstance.collection);
  const out = { approved: true };   // 显式给"通过"，避免测到"变量缺失"的默认行为
  if (miNode) out[miNode.multiInstance.collection] = ['u1', 'u2', 'u3'];
  // 模板里声明的布尔变量（如 outbound / confidential / production）也必须给值，
  // 否则网关条件 ${x == true} 在引擎里会抛 Unknown property
  for (const v of ((ir && ir.variables) || [])) {
    if (v && v.type === 'boolean' && out[v.name] === undefined) out[v.name] = false;
  }
  return out;
}

function main() {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

  const templates = loadTemplates();
  const specs = [];
  const rows = [];

  for (const tpl of templates) {
    const built = buildFromTemplate(tpl.templateId, {}, '');
    if (!built) { rows.push([tpl.templateId, 0, '构建失败']); continue; }

    const r = runPipeline(built.ir, { repair: true });
    if (!r.ok) { rows.push([tpl.templateId, 0, '管线失败: ' + r.errors[0]]); continue; }

    const file = 'cov-' + tpl.templateId + '.bpmn';
    fs.writeFileSync(path.join(OUT, file), r.xml, 'utf8');

    const base = defaultsFor(tpl);
    const arts = buildArtifacts(r.ir, tpl);

    // 1) 正常走完：只吸收「网关分支」的样例值（驳回用例的 approved=false 不能带进来），
    //    因为网关条件变量必须有值，否则引擎会抛 Unknown property
    const branchCase = arts.cases.cases.find((c) => c.gateway !== '驳回路径');
    const branchVars = branchCase ? branchCase.variables : {};
    specs.push(SPEC_PREFIX + file + '|' + varSpec(Object.assign({}, base, branchVars)));

    // 2) 每条分支一条断言：同样带上网关变量（顺序：base -> 网关分支 -> 本用例）
    for (const c of arts.cases.cases) {
      const vars = Object.assign({}, base, branchVars, c.variables);
      if (c.targetId) {
        specs.push(SPEC_PREFIX + file + '|' + varSpec(vars) + '|expectcontains=' + c.targetId);
      }
    }

    rows.push([tpl.templateId, arts.cases.total, 'ok']);
  }

  const lines = specs.filter(Boolean);
  if (!onlyPrint) {
    fs.writeFileSync(SPEC_OUT, lines.join('\n') + '\n', 'utf8');
  }

  const withAssert = lines.filter((l) => l.indexOf('expectcontains=') !== -1).length;
  const happy = lines.length - withAssert;
  console.log('覆盖率规格：' + lines.length + ' 条（分支断言 ' + withAssert + ' 条 + 正常走完 ' + happy + ' 条）');
  console.log('模板数：' + rows.length);
  if (!onlyPrint) console.log('已写出：' + SPEC_OUT);
}

main();
