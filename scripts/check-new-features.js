#!/usr/bin/env node
'use strict';
/**
 * 新能力自检：把"这轮做的四件事"变成可重复执行的断言。
 *
 * 为什么单独一个脚本：六层验证只看 BPMN 本身合不合法，
 * 而"角色组表一致 / 交付包齐不齐 / formKey 挂没挂 / 台账写没写"这些
 * 是我们自己的工程约束，必须单独盯住。CI 与 verify-all.cmd 都会跑它。
 *
 * 退出码：0 全过；1 有失败（CI 会红）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const P = (rel) => path.join(ROOT, rel);
const { loadTemplates, generateFromText, buildFromTemplate } = require(P('src/nl'));
const { runPipeline } = require(P('src/pipeline'));
const { buildArtifacts } = require(P('src/artifacts'));
const { buildBundle } = require(P('src/bundle'));
const { appendLedger, buildEntry } = require(P('src/ledger'));
const { zip, unzip } = require(P('src/zip'));

let pass = 0;
const fails = [];
function ok(cond, label, detail) {
  if (cond) {
    pass++;
  } else {
    fails.push(label + (detail ? ' -> ' + detail : ''));
    console.log('  [FAIL] ' + label + (detail ? ' -> ' + detail : ''));
  }
}

// ---------- 1) 角色组：生成物里的组必须在映射表里 ----------
// 注意要检查"生成物"而不是模板原文：模板里 simple_approval 用的是槽位 @approver@，
// 渲染后才是 role_manager 这样的真实组名。
console.log('== 1/5 角色组映射表 ==');
const rolesDoc = JSON.parse(fs.readFileSync(P('src/org-roles.json'), 'utf8'));
const known = new Set((rolesDoc.roles || []).map((r) => r.group));
const tpls = loadTemplates();

const missing = [];
const assigneeVars = new Set();
let groupTasks = 0;
let taskCount = 0;

for (const t of tpls) {
  const built = buildFromTemplate(t.templateId, {}, '');
  if (!built || !built.ir) continue;
  const pipe = runPipeline(built.ir);
  if (!pipe.ok) { missing.push(t.templateId + ' 管线失败'); continue; }
  const declared = new Set((pipe.ir.variables || []).map((v) => v.name));
  declared.add('initiator');
  for (const tag of pipe.xml.match(/<bpmn:userTask[^>]*>/g) || []) {
    taskCount++;
    const cg = /flowable:candidateGroups="([^"]+)"/.exec(tag);
    if (cg) {
      groupTasks++;
      for (const g of cg[1].split(',')) {
        const k = g.trim();
        if (k && !known.has(k)) missing.push(t.templateId + ':' + k);
      }
    }
    const as = /flowable:assignee="\$\{([^}]+)\}"/.exec(tag);
    if (as) assigneeVars.add(as[1]);
  }
}

ok(groupTasks > 50, '生成物里大部分任务用角色组', groupTasks + '/' + taskCount);
ok(missing.length === 0, '角色组都在 org-roles.json 里', missing.slice(0, 5).join(', '));
ok(assigneeVars.size === 1 && assigneeVars.has('initiator'),
  'assignee 只剩发起人一个变量', [...assigneeVars].join(','));

// ---------- 2) formKey：挂在提交任务上且与表单一致 ----------
console.log('== 2/5 表单与 formKey ==');
const b = buildFromTemplate('amount_tiered', {}, '');
const r = runPipeline(b.ir);
ok(r.ok, '模板能跑通管线', (r.errors || []).join(';'));
const art = buildArtifacts(r.ir, b.template || null);
const xmlKey = (/flowable:formKey="([^"]+)"/.exec(r.xml) || [])[1];
ok(!!xmlKey, 'bpmn 里挂上了 formKey', xmlKey || '无');
ok(xmlKey === art.form.formKey, 'formKey 与表单一致', xmlKey + ' vs ' + art.form.formKey);
ok(art.form.fields.length >= 5, '表单字段不少于 5 个', String(art.form.fields.length));
const types = new Set(art.form.fields.map((f) => f.type));
ok(types.has('date') && types.has('attachment') && types.has('select'),
  '表单类型含 date/attachment/select', [...types].join(','));

// ---------- 3) 交付包：7 个文件 + 关键内容 ----------
console.log('== 3/5 交付包 ==');
const bundle = buildBundle({
  ir: r.ir, xml: r.xml, artifacts: art,
  meta: { templateId: 'amount_tiered', sourceText: '自检', generatedAt: '2026-01-01 00:00' },
  pipeline: { warnings: r.warnings || [] }
});
ok(bundle.files.length === 7, '交付包恰好 7 个文件', String(bundle.files.length));
const byName = new Map(bundle.files.map((f) => [f.name, f.content]));
const deploy = byName.get('部署说明.md') || '';
ok(deploy.indexOf(r.ir.processKey) >= 0, '部署说明含 processKey');
ok(deploy.indexOf('role_manager') >= 0, '部署说明列出角色组');
ok(deploy.indexOf('导入') >= 0, '部署说明含导入步骤');
const summary = byName.get('校验摘要.txt') || '';
ok(summary.indexOf('[外部]') >= 0, '校验摘要区分了本地与外部检查');
ok(summary.indexOf('错误 0 条') >= 0, '校验摘要记录了错误数');

// ---------- 4) zip：能被打包并原样解开 ----------
console.log('== 4/5 交付包打包 ==');
const zipBuf = zip(bundle.files.map((f) => ({ name: bundle.dirName + '/' + f.name, content: f.content })));
const entries = unzip(zipBuf);
ok(entries.length === 7, 'zip 里 7 个条目', String(entries.length));
const zipped = new Map(entries.map((e) => [e.name.split('/').pop(), e.content.toString()]));
ok(zipped.get('部署说明.md') === deploy, 'zip 内的部署说明与原件一致');

// ---------- 5) 台账 + 命名/版本 ----------
console.log('== 5/5 台账与命名 ==');
const tmp = path.join(os.tmpdir(), 'bpmn-selfcheck-' + process.pid + '.jsonl');
if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
const named = generateFromText('差旅报销，金额小于1000主管批', { keyPrefix: 'chk_', versionTag: '9' });
const rn = runPipeline(named.ir);
ok(named.ir.processKey === 'chk_amountTiered', 'processKey 前缀生效', named.ir.processKey);
ok(/flowable:versionTag="9"/.test(rn.xml), 'versionTag 进入 XML');
appendLedger(buildEntry({
  ir: rn.ir, xml: rn.xml,
  meta: { templateId: 'amount_tiered', sourceText: '自检', generatedAt: '2026-01-01 00:00', mode: 'selfcheck' },
  pipeline: { warnings: [] }, output: 'x.bpmn'
}), tmp);
const lines = fs.readFileSync(tmp, 'utf8').trim().split('\n');
ok(lines.length === 1, '台账写入一行', String(lines.length));
const entry = JSON.parse(lines[0]);
ok(entry.processKey === 'chk_amountTiered' && entry.versionTag === '9', '台账记录了 key/版本');
ok(/^[0-9a-f]{16}$/.test(entry.xmlSha256 || ''), '台账记录了 XML 指纹');
fs.unlinkSync(tmp);

// ---------- 汇总 ----------
console.log('');
console.log('新能力自检：通过 ' + pass + ' / 失败 ' + fails.length);
if (fails.length > 0) {
  console.log('失败明细：');
  for (const f of fails) console.log('  - ' + f);
  process.exit(1);
}
console.log('OK');
process.exit(0);
