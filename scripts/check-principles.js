#!/usr/bin/env node
'use strict';

/**
 * 原则自动检查器（P-01 ~ P-09）。
 * 用法: node scripts/check-principles.js
 * 退出码: 0 全绿 / 1 有红灯
 *
 * P-10（诚实原则）无法机械化，属人工守则。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SELF = path.basename(__filename);
const results = [];

function record(id, title, ok, detail) {
  results.push({ id, title, ok, detail: detail || '' });
}

function walk(dir, acc) {
  const out = acc || [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      walk(p, out);
    } else {
      out.push(p);
    }
  }
  return out;
}

const jsFiles = []
  .concat(walk(path.join(ROOT, 'src')))
  .concat(walk(path.join(ROOT, 'bin')))
  .concat(walk(path.join(ROOT, 'scripts')))
  .filter((p) => p.endsWith('.js') && path.basename(p) !== SELF);

const cmdFiles = walk(ROOT).filter((p) => p.endsWith('.cmd'));

function scan(files, patterns) {
  const hits = [];
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch (e) { continue; }
    for (const p of patterns) {
      if (p.re.test(text)) hits.push(path.relative(ROOT, f) + ' :: ' + p.label);
    }
  }
  return hits;
}

// ---------- P-01 磁盘边界 ----------
{
  const hits = scan(jsFiles, [
    { re: /\bAPPDATA\b/, label: '引用 APPDATA' },
    { re: /\bLOCALAPPDATA\b/, label: '引用 LOCALAPPDATA' },
    { re: /Program Files/i, label: '引用 Program Files' },
    { re: /os\.tmpdir|process\.env\.TEMP/i, label: '使用系统临时目录' }
  ]);
  record('P-01', '磁盘边界：产物不出工作区', hits.length === 0, hits.join(' | '));
}

// ---------- P-02 分层零依赖 ----------
{
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const coreDeps = Object.keys(pkg.dependencies || {}).length + Object.keys(pkg.devDependencies || {}).length;
  const rootNm = fs.existsSync(path.join(ROOT, 'node_modules'));

  const tpPath = path.join(ROOT, 'docs', 'THIRD-PARTY.md');
  const tp = fs.existsSync(tpPath) ? fs.readFileSync(tpPath, 'utf8') : '';

  const webPkgPath = path.join(ROOT, 'web', 'package.json');
  const hasWeb = fs.existsSync(webPkgPath);
  const unregistered = [];
  if (hasWeb) {
    const wpkg = JSON.parse(fs.readFileSync(webPkgPath, 'utf8'));
    const names = Object.keys(wpkg.dependencies || {}).concat(Object.keys(wpkg.devDependencies || {}));
    for (const n of names) {
      if (tp.indexOf(n) === -1) unregistered.push(n);
    }
  }

  const ok = coreDeps === 0 && !rootNm && unregistered.length === 0;
  record('P-02', '分层零依赖：核心 0 依赖，前端依赖须登记', ok,
    '核心deps=' + coreDeps +
    ' 根node_modules=' + (rootNm ? '存在(违规)' : '不存在') +
    ' 前端=' + (hasWeb ? '已引入' : '未引入') +
    ' 未登记=' + (unregistered.length ? unregistered.join(',') : '无'));
}

// ---------- P-03 不碰系统层 ----------
{
  const hits = scan(jsFiles.concat(cmdFiles), [
    { re: /\breg\s+add\b/i, label: '写注册表' },
    { re: /\bsc\s+create\b/i, label: '注册服务' },
    { re: /\bsetx\b/i, label: '改系统环境变量' },
    { re: /New-Service|Start-Service|Set-ItemProperty/i, label: 'PowerShell 系统层改动' }
  ]);
  record('P-03', '不碰系统层：无服务/注册表/PATH/管理员', hits.length === 0, hits.join(' | '));
}

// ---------- P-04 进程边界 ----------
{
  const hits = scan(jsFiles, [
    { re: /require\(\s*['"]child_process['"]\s*\)/, label: '调用子进程' },
    { re: /require\(\s*['"]node:child_process['"]\s*\)/, label: '调用子进程(node:)' }
  ]);
  record('P-04', '进程边界：前台运行，不起常驻进程', hits.length === 0, hits.join(' | '));
}

// ---------- P-05 密钥不落地 ----------
{
  const hits = scan(jsFiles, [
    { re: /sk-[A-Za-z0-9]{10,}/, label: '疑似硬编码密钥' },
    { re: /Bearer\s+[A-Za-z0-9._-]{8,}/, label: '硬编码 Bearer token' },
    { re: /api[_-]?key\s*[:=]\s*['"][^'"]{8,}['"]/i, label: '硬编码 apiKey' },
    { re: /password\s*[:=]\s*['"][^'"]+['"]/i, label: '硬编码密码' }
  ]);
  record('P-05', '密钥不落地：只从环境变量读', hits.length === 0, hits.join(' | '));
}

// ---------- P-06 确定性 ----------
let determinism = { ok: false, detail: '' };
{
  const { serialize } = require(path.join(ROOT, 'src', 'serialize.js'));
  const caseFile = path.join(ROOT, 'test', 'cases', 'travel-expense.json');
  const ir = JSON.parse(fs.readFileSync(caseFile, 'utf8'));
  const a = serialize(ir);
  const b = serialize(ir);
  const sameBytes = a === b;
  const hasTimestamp = /20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}/.test(a);
  const ok = sameBytes && !hasTimestamp;
  determinism = { ok, detail: '两次输出' + (sameBytes ? '逐字节相同' : '不一致') + '，时间戳=' + (hasTimestamp ? '有' : '无') };
  record('P-06', '生成物确定性：同输入同字节', ok, determinism.detail);
}

// ---------- P-07 模型不直接产出 XML ----------
{
  const { validateIR } = require(path.join(ROOT, 'src', 'ir.js'));
  // 顺序契约现在由 pipeline.js 统一持有（CLI 只是调用方）
  const pipeSrc = fs.readFileSync(path.join(ROOT, 'src', 'pipeline.js'), 'utf8');
  const binSrc = fs.readFileSync(path.join(ROOT, 'bin', 'bpmn-gen.js'), 'utf8');

  const iV = pipeSrc.indexOf('validateIR(');
  const iA = pipeSrc.indexOf('analyze(');
  const iS = pipeSrc.indexOf('serialize(');
  const iL = pipeSrc.indexOf('lintXml(');
  const ordered = iV > -1 && iA > iV && iS > iA && iL > iS;

  // CLI 必须走管线，不得自己直连序列化器
  const binUsesPipeline =
    /require\(\s*['"]\.\.\/src\/pipeline['"]\s*\)/.test(binSrc) &&
    binSrc.indexOf('runPipeline(') > -1 &&
    binSrc.indexOf('serialize(') === -1;

  const rejectsRaw = validateIR('<bpmn:definitions/>').errors.length > 0;
  const rejectsEmpty = validateIR({ nodes: [] }).errors.length > 0;

  const ok = ordered && binUsesPipeline && rejectsRaw && rejectsEmpty;
  record('P-07', '模型不直接产出 XML：必须是 IR 入、XML 出', ok,
    '管线顺序=' + (ordered ? 'OK(validate→analyze→serialize→lint)' : '异常') +
    ' CLI只走管线=' + binUsesPipeline +
    ' 拒绝裸XML=' + rejectsRaw + ' 拒绝空IR=' + rejectsEmpty);
}

// ---------- P-08 校验不可跳过 ----------
{
  const { analyze } = require(path.join(ROOT, 'src', 'graph.js'));
  const good = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'cases', 'travel-expense.json'), 'utf8'));
  const bad = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'cases-bad', 'gateway-no-default.json'), 'utf8'));
  const goodErrors = analyze(good).errors.length;
  const badErrors = analyze(bad).errors.length;
  const ok = goodErrors === 0 && badErrors > 0;
  record('P-08', '校验不可跳过：坏图必须显式失败', ok,
    '好用例错误=' + goodErrors + ' 坏用例错误=' + badErrors);
}

// ---------- P-09 可归零 ----------
{
  const giPath = path.join(ROOT, '.gitignore');
  let gi = '';
  if (fs.existsSync(giPath)) gi = fs.readFileSync(giPath, 'utf8');
  const need = ['node_modules/', '.data/', '*.bpmn'];
  const missing = need.filter((n) => gi.indexOf(n) === -1);
  const strayBpmn = walk(ROOT).filter((p) => p.endsWith('.bpmn'));
  const ok = missing.length === 0 && strayBpmn.length === 0;
  record('P-09', '可归零：产物不入库、项目内无残留产物', ok,
    'gitignore缺失=' + (missing.length ? missing.join(',') : '无') +
    ' 项目内bpmn文件=' + strayBpmn.length);
}

// ---------- P-11 开源合规 ----------
{
  const licPath = path.join(ROOT, 'LICENSE');
  const lic = fs.existsSync(licPath) ? fs.readFileSync(licPath, 'utf8') : '';
  const isApache = /Apache License/.test(lic) && /Version 2\.0/.test(lic);
  const hasNotice = fs.existsSync(path.join(ROOT, 'NOTICE'));
  const hasThirdParty = fs.existsSync(path.join(ROOT, 'docs', 'THIRD-PARTY.md'));
  const gplHits = scan(jsFiles, [
    { re: /GNU (Lesser |Affero )?General Public License/i, label: 'GPL 字样' }
  ]);
  const ok = isApache && hasNotice && hasThirdParty && gplHits.length === 0;
  record('P-11', '开源合规：LICENSE 齐全、无 GPL 污染', ok,
    'LICENSE=' + (isApache ? 'Apache-2.0' : '缺失或异常') +
    ' NOTICE=' + hasNotice + ' THIRD-PARTY=' + hasThirdParty + ' GPL命中=' + gplHits.length);
}

// ---------- 输出 ----------
const W = 62;
function line(ch) { return ch.repeat(W); }

console.log('');
console.log('项目环境原则检查  v1.2');
console.log(line('='));
let fail = 0;
for (const r of results) {
  const tag = r.ok ? '[PASS]' : '[FAIL]';
  if (!r.ok) fail++;
  console.log(tag + ' ' + r.id + '  ' + r.title);
  if (r.detail) console.log('        ' + r.detail);
}
console.log(line('-'));
console.log('自动检查: ' + (results.length - fail) + '/' + results.length + ' 通过');
console.log('P-10 诚实原则：人工守则（未验证的动作不得声称已验证）');
console.log(line('='));

if (fail > 0) {
  console.log('');
  console.log('有 ' + fail + ' 条原则红灯，按 PRINCIPLES.md 要求不得产出。');
  process.exit(1);
}
console.log('');
console.log('全部通过。');
process.exit(0);
