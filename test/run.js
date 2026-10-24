#!/usr/bin/env node
'use strict';

/**
 * 测试套件：无测试框架依赖，纯自研断言。
 *
 *   正向用例  test/cases/            IR -> XML 必须全绿，并产出 DI
 *   反向用例  test/cases-bad/        坏 IR 必须被拒绝（证明守卫不是摆设）
 *   可修用例  test/cases-repairable/ 不修必须失败，修完必须通过
 *   修复单测  内联                   id 生成/重命名/自环/非法默认流
 */

const fs = require('fs');
const path = require('path');
const { runPipeline } = require('../src/pipeline');
const { repairIR } = require('../src/repair');
const { generateFromText, loadTemplates, buildFromTemplate } = require('../src/nl');

const CASES = path.join(__dirname, 'cases');
const BAD = path.join(__dirname, 'cases-bad');
const REPAIRABLE = path.join(__dirname, 'cases-repairable');
// 验证产物单独放 .data\verify：不要和用户自己的流程混在 .data\out 里
const OUT = path.join(__dirname, '..', '..', '.data', 'verify');

let pass = 0;
let fail = 0;
const failures = [];

function check(label, cond, detail) {
  if (cond) {
    pass++;
  } else {
    fail++;
    failures.push(label + (detail ? ' -> ' + detail : ''));
    console.log('  [FAIL] ' + label + (detail ? ' -> ' + detail : ''));
  }
}

function countOccurrences(hay, needle) {
  let n = 0;
  let i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}

function ensureOut() {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// ---------------- 正向 ----------------
function runPositive(file) {
  const name = path.basename(file, '.json');
  console.log('');
  console.log('== 正向用例: ' + name + ' ==');

  const ir = readJson(file);
  const r = runPipeline(ir);

  check(name + ' / 管线成功', r.ok, r.errors.join('; '));
  if (!r.ok) return;

  const xml = r.xml;

  check(name + ' / XML 良构', r.errors.length === 0);
  check(name + ' / DI Shape 数量', countOccurrences(xml, '<bpmndi:BPMNShape ') === ir.nodes.length,
    '期望 ' + ir.nodes.length + ' 实际 ' + countOccurrences(xml, '<bpmndi:BPMNShape '));
  check(name + ' / DI Edge 数量', countOccurrences(xml, '<bpmndi:BPMNEdge ') === r.ir.flows.length,
    '期望 ' + r.ir.flows.length + ' 实际 ' + countOccurrences(xml, '<bpmndi:BPMNEdge '));
  check(name + ' / flowable 命名空间', xml.indexOf('xmlns:flowable="http://flowable.org/bpmn"') !== -1);
  check(name + ' / isExecutable', xml.indexOf('isExecutable="true"') !== -1);

  // CDATA 的合法来源有两处：连线条件 与 多实例的 completionCondition
  const condCount = r.ir.flows.filter((f) => f.condition).length;
  const miCondCount = r.ir.nodes.filter((n) => n.multiInstance && n.multiInstance.completionCondition).length;
  const timerCount = r.ir.nodes.filter((n) => n.type === 'boundaryEvent' && n.timer).length;
  const expectCdata = condCount + miCondCount + timerCount;
  check(name + ' / 条件表达式 CDATA', countOccurrences(xml, '<![CDATA[') === expectCdata,
    '期望 ' + expectCdata + ' 实际 ' + countOccurrences(xml, '<![CDATA['));

  for (const n of r.ir.nodes) {
    if (n.type !== 'exclusiveGateway') continue;
    const outs = r.ir.flows.filter((f) => f.from === n.id);
    if (outs.length <= 1) continue;
    const def = outs.find((f) => f.default === true);
    check(name + ' / 网关 ' + n.id + ' 带 default 属性',
      Boolean(def) && xml.indexOf('default="' + (def ? def.id : '') + '"') !== -1);
  }

  // 管线阶段齐全（P-07 的机械证据）
  const stageNames = r.stages.map((s) => s.name);
  check(name + ' / 管线阶段顺序', JSON.stringify(stageNames) === JSON.stringify(['validate(IR)', 'analyze(graph)', 'serialize', 'lint(XML)']),
    stageNames.join(' -> '));

  ensureOut();
  const outFile = path.join(OUT, name + '.bpmn');
  fs.writeFileSync(outFile, xml, 'utf8');
  console.log('  已输出: ' + path.resolve(outFile));
  console.log('  节点 ' + r.ir.nodes.length + ' / 连线 ' + r.ir.flows.length + ' / XML ' + r.elements + ' 元素');
}

// ---------------- 反向 ----------------
function runNegative(file) {
  const name = path.basename(file, '.json');
  console.log('');
  console.log('== 反向用例: ' + name + ' ==');

  const r = runPipeline(readJson(file));
  check(name + ' / 必须被拒绝', !r.ok, '居然通过了校验');
  check(name + ' / 不得产出 XML', r.xml === null, '不应生成 XML');

  if (!r.ok) {
    console.log('  正确拒绝，报错 ' + r.errors.length + ' 条:');
    for (const e of r.errors) console.log('    - ' + e);
  }
}

// ---------------- 可修复 ----------------
function runRepairable(file) {
  const name = path.basename(file, '.json');
  console.log('');
  console.log('== 可修复用例: ' + name + ' ==');

  const raw = readJson(file);

  const before = runPipeline(raw);
  check(name + ' / 不修复必须失败', !before.ok, '脏数据居然直接通过了');
  check(name + ' / 不修复不得产出 XML', before.xml === null);

  const after = runPipeline(raw, { repair: true });
  check(name + ' / 修复后必须通过', after.ok, after.errors.join('; '));
  check(name + ' / 必须执行过修复动作', after.actions.length >= 4, '动作数 ' + after.actions.length);

  if (!after.ok) return;

  check(name + ' / 修复后 DI 完整',
    countOccurrences(after.xml, '<bpmndi:BPMNShape ') === after.ir.nodes.length &&
    countOccurrences(after.xml, '<bpmndi:BPMNEdge ') === after.ir.flows.length);

  ensureOut();
  fs.writeFileSync(path.join(OUT, name + '.repaired.bpmn'), after.xml, 'utf8');

  console.log('  修复 ' + after.actions.length + ' 项:');
  for (const a of after.actions) console.log('    · ' + a);
  console.log('  修复后: 节点 ' + after.ir.nodes.length + ' / 连线 ' + after.ir.flows.length);
}

// ---------------- 修复单测 ----------------
function runRepairUnit() {
  console.log('');
  console.log('== 修复器单元测试 ==');

  const r1 = repairIR({ id: 'x', nodes: [{ type: 'userTask' }, { type: 'startEvent' }], flows: [] });
  check('补齐节点 id（userTask -> Task_1）', r1.ir.nodes[0].id === 'Task_1', String(r1.ir.nodes[0].id));

  const r2 = repairIR({ id: 'y', nodes: [{ id: 'A', type: 'startEvent' }, { id: 'A', type: 'endEvent' }], flows: [] });
  check('重复 id 自动重命名', r2.ir.nodes[1].id !== 'A', String(r2.ir.nodes[1].id));

  const r3 = repairIR({
    id: 'z',
    nodes: [{ id: 'S', type: 'startEvent' }, { id: 'E', type: 'endEvent' }],
    flows: [{ id: 'F1', from: 'S', to: 'S' }, { id: 'F2', from: 'S', to: 'E' }]
  });
  check('自环连线被移除', r3.ir.flows.length === 1, '剩余 ' + r3.ir.flows.length);

  const r4 = repairIR({
    id: 'w',
    nodes: [{ id: 'S', type: 'startEvent' }, { id: 'T', type: 'userTask' }, { id: 'E', type: 'endEvent' }],
    flows: [{ id: 'F1', from: 'S', to: 'T', default: true }, { id: 'F2', from: 'T', to: 'E' }]
  });
  check('非网关上的默认流被清除', r4.ir.flows[0].default === false, String(r4.ir.flows[0].default));

  const r5 = repairIR({
    id: 'v',
    nodes: [{ id: 'S', type: 'startEvent' }, { id: 'G', type: 'exclusiveGateway' },
      { id: 'A', type: 'userTask' }, { id: 'B', type: 'userTask' }, { id: 'E', type: 'endEvent' }],
    flows: [
      { id: 'F1', from: 'S', to: 'G' },
      { id: 'F2', from: 'G', to: 'A', default: true },
      { id: 'F3', from: 'G', to: 'B', default: true },
      { id: 'F4', from: 'A', to: 'E' },
      { id: 'F5', from: 'B', to: 'E' }
    ]
  });
  const keptDefaults = r5.ir.flows.filter((f) => f.default === true).length;
  check('同一网关多余默认流被清理', keptDefaults === 1, '剩余默认流 ' + keptDefaults);

  // 关键：修复器不得凭空造节点（P-08）
  const r6 = repairIR({
    id: 'u',
    nodes: [{ id: 'S', type: 'startEvent' }, { id: 'T', type: 'userTask' }],
    flows: [{ id: 'F1', from: 'S', to: 'T' }]
  });
  check('修复器不凭空补结束事件', r6.ir.nodes.length === 2, '节点数 ' + r6.ir.nodes.length);
}

// ---------------- 自然语言用例 ----------------
function runNlCases() {
  const file = path.join(__dirname, 'nl-cases.json');
  if (!fs.existsSync(file)) return;
  const cases = JSON.parse(fs.readFileSync(file, 'utf8'));

  console.log('');
  console.log('== 自然语言用例（' + cases.length + ' 条）==');

  const tpls = loadTemplates();
  check('模板库可用（>= 8 个）', tpls.length >= 8, '当前 ' + tpls.length + ' 个');

  for (let seq = 0; seq < cases.length; seq++) {
    const c = cases[seq];
    const label = c.name || 'case';
    const g = generateFromText(c.text);

    if (c.expectMatch === false) {
      check(label + ' / 必须匹配失败', !g.ok, '居然匹配到 ' + g.templateId);
      if (!g.ok) console.log('  · ' + label + ' -> 正确拒绝（' + g.error + '）');
      continue;
    }

    check(label + ' / 匹配模板', g.ok && g.templateId === c.expectTemplate,
      g.ok ? ('匹配到 ' + g.templateId) : g.error);
    if (!g.ok) continue;

    const r = runPipeline(g.ir);
    check(label + ' / 生成的 IR 通过管线', r.ok, r.errors.join('; '));
    if (!r.ok) continue;

    for (const cond of (c.expectConditions || [])) {
      check(label + ' / 条件 ' + cond, r.xml.indexOf(cond) !== -1);
    }
    for (const nm of (c.expectNames || [])) {
      check(label + ' / 节点 ' + nm, r.xml.indexOf('name="' + nm + '"') !== -1);
    }

    ensureOut();
    // 文件名必须纯 ASCII：中文名经 cmd 传给 Java 时会被 console 码页转成 "?"，
    // 而 "?" 是 Windows 非法路径字符，CI 上会直接抛 InvalidPathException。
    fs.writeFileSync(path.join(OUT, 'nl-' + seq + '-' + g.templateId + '.bpmn'), r.xml, 'utf8');
    console.log('  · ' + label + ' -> ' + g.templateId + '（得分 ' + g.score + '，' + r.elements + ' 元素）');
  }
}

// ---------------- 提示词与模型输出解析 ----------------
function runPromptUnit() {
  console.log('');
  console.log('== 提示词 / 模型输出解析 ==');

  const { buildSystemPrompt, buildUserMessage, parseModelOutput } = require('../src/prompt');
  const tpls = loadTemplates();
  const sys = buildSystemPrompt(tpls);

  for (const t of tpls) {
    check('系统提示词含模板 ' + t.templateId, sys.indexOf(t.templateId) !== -1);
  }
  check('提示词禁止编造模板', sys.indexOf('禁止编造') !== -1);
  check('提示词要求只输出 JSON', sys.indexOf('只输出一个 JSON 对象') !== -1);

  const user = buildUserMessage('测试描述');
  check('用户消息包含描述', user.indexOf('测试描述') !== -1);

  const p1 = parseModelOutput(
    '{"templateId":"amount_tiered","slots":{"tier1":"2000","tier2":8000},"confidence":0.9}',
    tpls
  );
  check('解析：正常 JSON', p1.ok === true, p1.error);
  check('解析：数字字符串被强转', p1.ok && p1.slots.tier1 === 2000, JSON.stringify(p1.slots));

  const p2 = parseModelOutput(
    '说明文字\n```json\n{"templateId":"leave_days","slots":{"tier1":5}}\n```\n尾巴',
    tpls
  );
  check('解析：Markdown 围栏自动剥离', p2.ok === true && p2.slots.tier1 === 5, p2.error);

  const p3 = parseModelOutput('{"templateId":"not_exist","slots":{}}', tpls);
  check('解析：未知模板被拒绝', p3.ok === false, '居然接受了');

  const p4 = parseModelOutput('{"templateId":null,"reason":"看不懂"}', tpls);
  check('解析：null 模板被拒绝', p4.ok === false, '居然接受了');

  const p5 = parseModelOutput("模型觉得：{'templateId': }", tpls);
  check('解析：非法 JSON 被拒绝', p5.ok === false, '居然接受了');

  const p6 = parseModelOutput('{"templateId":"amount_tiered","slots":{"tier1":100,"bogus":1}}', tpls);
  check('解析：未知槽位产生告警', p6.ok === true && p6.warnings.length >= 1, JSON.stringify(p6.warnings));

  const built = buildFromTemplate(p1.templateId, p1.slots, '测试');
  check('按模型槽位渲染模板', Boolean(built));
  if (built) {
    const r = runPipeline(built.ir);
    check('模型槽位驱动的 IR 通过管线', r.ok, r.errors.join('; '));
    if (r.ok) {
      check('模型给的阈值确实生效', r.xml.indexOf('${amount <= 2000}') !== -1);
      ensureOut();
      fs.writeFileSync(path.join(OUT, 'prompt-unit.bpmn'), r.xml, 'utf8');
    }
  }

  // 供应商与端点解析（防止切换供应商/地域时拼错）
  const llm = require('../src/llm');
  const c1 = llm.resolveConfig({ provider: 'deepseek', apiKey: 'dummy' });
  check('默认供应商 DeepSeek', c1.providerId === 'deepseek', c1.providerId);
  check('DeepSeek 端点拼接', c1.endpoint.hostname === 'api.deepseek.com' && c1.endpoint.path === '/chat/completions', c1.endpoint.path);
  check('DeepSeek 默认模型', c1.model === 'deepseek-flash', c1.model);
  check('DeepSeek 密钥变量名', c1.keyEnv === 'DEEPSEEK_API_KEY', c1.keyEnv);

  const c2 = llm.resolveConfig({ provider: 'dashscope', apiKey: 'dummy' });
  check('百炼端点拼接', c2.endpoint.path === '/compatible-mode/v1/chat/completions', c2.endpoint.path);
  check('百炼默认模型', c2.model === 'qwen-plus', c2.model);

  const c3 = llm.resolveConfig({ provider: 'nope', apiKey: 'dummy' });
  check('未知供应商回退默认', c3.providerId === 'deepseek', c3.providerId);

  const c4 = llm.resolveConfig({ provider: 'deepseek', apiKey: 'dummy', baseUrl: 'https://api.deepseek.com/v1/' });
  check('自定义 baseUrl 去尾斜杠', c4.endpoint.path === '/v1/chat/completions', c4.endpoint.path);

  check('无 Key 时 hasKey=false', llm.resolveConfig({ provider: 'deepseek', apiKey: '' }).hasKey === false);
}

// ---------------- 脚本卫生 ----------------
// 踩过两次的坑，必须自动盯住：
//   1) .cmd 里出现中文 -> cmd 在 chcp 生效前按 GBK 解析，把注释当命令执行
//   2) .ps1 没有 BOM   -> Windows PowerShell 5.1 会把中文当 ANSI 读，输出乱码
function runScriptHygiene() {
  console.log('');
  console.log('== 脚本卫生（.cmd 只许 ASCII / .ps1 必须有 BOM）==');

  const root = path.join(__dirname, '..');
  const ws = path.join(root, '..');
  const SKIP = new Set(['node_modules', '.cache', '.tools', '.data', '.git']);

  const cmdFiles = [];
  const ps1Files = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (e.name.endsWith('.cmd')) cmdFiles.push(p);
      if (e.name.endsWith('.ps1')) ps1Files.push(p);
    }
  };

  // 只检查本项目的脚本：工作区根启动器 + bpmn-gen + _env
  // （工作区里还有别的目录，不属于本项目，不能一起判罚）
  // 注意：ws（仓库上一级）在 CI 上只是 github runner 的临时目录，
  //       既没有 _env 也没有根启动器 —— 这些是本地工作区才有的东西，必须容忍缺失。
  const topFiles = (() => {
    try { return fs.readdirSync(ws); } catch (e) { return []; }
  })();
  for (const f of topFiles) {
    const p = path.join(ws, f);
    try {
      if (!fs.statSync(p).isFile()) continue;
    } catch (e) {
      continue;
    }
    if (f.endsWith('.cmd')) cmdFiles.push(p);
    if (f.endsWith('.ps1')) ps1Files.push(p);
  }
  walk(root);
  const envDir = path.join(ws, '_env');
  if (fs.existsSync(envDir)) walk(envDir);

  check('扫描到 .cmd 文件', cmdFiles.length > 0, '数量 ' + cmdFiles.length);
  for (const f of cmdFiles) {
    const bytes = fs.readFileSync(f);
    let firstHigh = -1;
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] > 127) { firstHigh = i; break; }
    }
    check('.cmd 纯 ASCII: ' + path.basename(f), firstHigh === -1,
      firstHigh === -1 ? '' : ('偏移 ' + firstHigh + ' 处有非 ASCII 字节，cmd 会解析成命令'));

    // LF-only 的 .cmd 会让 cmd 在 ^ 续行处解析错乱（实测踩过）
    let lfOnly = 0;
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] === 10 && (i === 0 || bytes[i - 1] !== 13)) lfOnly++;
    }
    check('.cmd 使用 CRLF: ' + path.basename(f), lfOnly === 0,
      lfOnly === 0 ? '' : (lfOnly + ' 行是纯 LF，需转成 CRLF'));
  }

  for (const f of ps1Files) {
    const b = fs.readFileSync(f);
    const hasBom = b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF;
    check('.ps1 带 UTF-8 BOM: ' + path.basename(f), hasBom, '缺少 BOM，PowerShell 5.1 会误读中文');
  }
}

// ---------------- 主流程 ----------------
function listJson(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => path.join(dir, f));
}

// ---------------- 数值解析与"不静默"提示 ----------------
function runNumericUnit() {
  console.log('');
  console.log('== 数值解析（中文数字 / 单位 / 提示）==');

  function condsOf(text) {
    const g = generateFromText(text);
    if (!g.ok) return { g, conds: [] };
    const r = runPipeline(g.ir);
    const out = [];
    const re = /CDATA\[(\$\{[^\]]*?\})\]/g;
    let m;
    while ((m = re.exec(r.xml)) !== null) {
      const c = m[1];
      if (c.indexOf('amount') !== -1 || c.indexOf('days') !== -1) out.push(c);
    }
    return { g, conds: out };
  }

  // 中文数字：五千 / 两万 / 一万五
  let x = condsOf('差旅报销超过五千块钱要财务复核');
  check('中文数字 五千 => 5000', x.conds.join(' ').indexOf('amount <= 5000') !== -1, x.conds.join(' | '));

  x = condsOf('采购超过两万要总监批');
  check('中文数字 两万 => 20000', x.conds.join(' ').indexOf('amount <= 20000') !== -1, x.conds.join(' | '));

  x = condsOf('报销超过一万五要财务复核');
  check('中文数字 一万五 => 15000', x.conds.join(' ').indexOf('amount <= 15000') !== -1, x.conds.join(' | '));

  // "10万" 只能算一个数，不能因为里面有个"万"再多算出一个 10000
  x = condsOf('采购申请超过10万需要副总批');
  check('阿拉伯+万 => 100000', x.conds.join(' ').indexOf('amount <= 100000') !== -1, x.conds.join(' | '));
  check('阿拉伯+万 不重复计数', x.conds.join(' ').indexOf('amount > 10000 ') === -1, x.conds.join(' | '));

  // 序数不能被当成数字
  x = condsOf('三级审批，主管批');
  check('三级审批不当作数字', x.conds.join(' ').indexOf('amount <=') === -1 || !x.g.ok, x.conds.join(' | '));

  // 只给一个阈值：必须提示"第二档是估算的"
  x = condsOf('差旅报销超过五千块钱要财务复核');
  check('单阈值时提示第二档为估算',
    (x.g.warnings || []).some(function (w) { return w.indexOf('第二档') !== -1 && w.indexOf('估算') !== -1; }),
    JSON.stringify(x.g.warnings || []));

  // 说的档数超过模板能力：必须点名"多出的没生成"
  x = condsOf('请假3天以内主管批，超过7天人事批');
  check('档数超纲时明确告知',
    (x.g.warnings || []).some(function (w) { return w.indexOf('只支持') !== -1 && w.indexOf('没有生成') !== -1; }),
    JSON.stringify(x.g.warnings || []));

  // 完全认不出数值：也要说清楚
  x = condsOf('采购申请走个审批');
  const handled = !x.g.ok || (x.g.warnings || []).length > 0 || x.conds.length === 0;
  check('没有阈值时不静默（有提示或本就不需要阈值）', handled, JSON.stringify(x.g.warnings || []));
}
// ---------------- 帮助页与前端资源自检 ----------------
// 帮助页是纯静态 HTML，很容易在改别的功能时被改坏，这里锁住几条不变量。
function runHelpPageUnit() {
  console.log('');
  console.log('== 帮助页与前端资源 ==');

  const htmlPath = path.join(__dirname, '..', 'web', 'index.html');
  const jsPath = path.join(__dirname, '..', 'web', 'app.js');
  if (!fs.existsSync(htmlPath)) {
    check('web/index.html 存在', false, htmlPath);
    return;
  }
  const html = fs.readFileSync(htmlPath, 'utf8');
  const app = fs.readFileSync(jsPath, 'utf8');

  const articles = html.match(/<article class="help-page[^>]*>/g) || [];
  check('帮助页文章数 >= 10', articles.length >= 10, '实际 ' + articles.length);

  const titles = [];
  const re = /<article class="help-page[^>]*data-title="([^"]*)"/g;
  let m;
  while ((m = re.exec(html)) !== null) titles.push(m[1]);
  check('每页都有标题', titles.length === articles.length, titles.length + ' / ' + articles.length);
  check('标题非空', titles.every((t) => t.trim() !== ''), JSON.stringify(titles));
  check('标题不重复', new Set(titles).size === titles.length, titles.join(','));

  // 目录与翻页元素
  for (const id of ['help-toc-list', 'help-pages', 'help-prev', 'help-next', 'help-num', 'gen-warn']) {
    check('页面含 #' + id, html.indexOf('id="' + id + '"') !== -1);
  }

  // "填入这句试试"按钮必须带内容
  const tryBtns = html.match(/data-try="[^"]*"/g) || [];
  const emptyTry = html.match(/data-try="\s*"/g) || [];
  check('示例按钮都带示例文本', tryBtns.length > 0 && emptyTry.length === 0,
    tryBtns.length + ' 个，空 ' + emptyTry.length);

  // 静态页码要和真实页数一致（没有 JS 时也不该显示错的）
  const numMatch = html.match(/id="help-num"[^>]*>\s*1\s*\/\s*(\d+)\s*</);
  check('静态页码与页数一致', !!numMatch && Number(numMatch[1]) === articles.length,
    numMatch ? ('页面写 1/' + numMatch[1] + '，实际 ' + articles.length + ' 页') : '未找到页码');

  // 验证报告页不能漏层（之前这页曾长期停在 27/27 的旧数字）
  const verifySeg = (html.match(/<section class="view" id="view-verify">[\s\S]*?<\/section>/) || [''])[0];
  for (const layer of ['L1', 'L0', 'L3', 'L2', 'L2b', 'L4-lite', 'L4', '分支覆盖', '端到端']) {
    check('验证报告页含 ' + layer + ' 层', verifySeg.indexOf(layer) !== -1);
  }
  check('验证报告页未残留旧数字 27/27', verifySeg.indexOf('27 / 27') === -1, '仍是 27/27');
  // app.js 里的帮助逻辑
  check('app.js 有目录构建逻辑', app.indexOf('buildHelpToc') !== -1);
  check('app.js 有页码翻页逻辑', app.indexOf('helpShow') !== -1);
  check('app.js 有生成提示渲染', app.indexOf('renderGenWarnings') !== -1);
}
// ---------------- 模板契约：驳回覆盖 ----------------
// 真实审批系统里每个待办都有"退回"按钮。之前 28 个模板里只有 11 个做到，
// 7 个模板的审批任务完全不能退回——这里把"除提交任务外全可驳回"锁成不变量。
function runTemplateInvariants() {
  console.log('');
  console.log('== 模板契约（驳回覆盖 / 分支完整性）==');

  const tpls = loadTemplates();
  check('模板数量 >= 28', tpls.length >= 28, '当前 ' + tpls.length);

  let fullCoverage = 0;
  const bad = [];
  for (const t of tpls) {
    const nodes = t.nodes || [];
    const flows = t.flows || [];
    const tasks = nodes.filter((n) => n.type === 'userTask');
    const rejects = flows.filter((f) => f.name === '驳回');
    const rejectFrom = new Set(rejects.map((f) => f.from));

    // 提交任务（从开始事件走到的第一个 userTask）本来就不需要驳回
    const start = nodes.filter((n) => n.type === 'startEvent')[0];
    let submitId = null;
    if (start) {
      const byFrom = new Map();
      for (const f of flows) {
        if (!byFrom.has(f.from)) byFrom.set(f.from, []);
        byFrom.get(f.from).push(f);
      }
      let cur = start.id;
      for (let i = 0; i < 20 && cur; i++) {
        const outs = (byFrom.get(cur) || []).filter((f) => f.name !== '驳回');
        if (outs.length !== 1) break;
        const nx = nodes.filter((n) => n.id === outs[0].to)[0];
        if (!nx) break;
        if (nx.type === 'userTask') { submitId = nx.id; break; }
        if (nx.type === 'endEvent') break;
        cur = nx.id;
      }
    }

    const needReject = tasks.filter((n) => n.id !== submitId);
    const missing = needReject.filter((n) => !rejectFrom.has(n.id)).map((n) => n.name);
    if (missing.length === 0) fullCoverage++;
    else bad.push(t.templateId + '：' + missing.join('/'));

    // 同一任务不允许有多条驳回
    const dup = [];
    const seen = new Set();
    for (const f of rejects) {
      if (seen.has(f.from)) dup.push(f.from);
      seen.add(f.from);
    }
    check(t.templateId + ' / 驳回不重复', dup.length === 0, dup.join(','));
  }

  check('每个模板的审批任务都能驳回', fullCoverage === tpls.length,
    '完整 ' + fullCoverage + ' / ' + tpls.length + '；缺: ' + bad.join(' | '));
}
// ---------------- 布局质量：连线不许穿框 ----------------
// 之前回边从目标"上边"进入，竖线会直接穿过整个方框；而且多条回边挤在同一条
// 水平通道上，叠成一片看不清。这里把两条不变量锁住。
function runLayoutUnit() {
  console.log('');
  console.log('== 布局质量（连线不穿框 / 回边分道）==');

  const { computeLayout, computeWaypoints } = require('../src/layout');
  const tpls = loadTemplates();
  const sample = tpls.filter((t) => t.templateId === 'amount_tiered')[0];
  if (!sample) { check('找到 amount_tiered 模板', false); return; }

  const built = buildFromTemplate('amount_tiered', {}, '');
  const ir = built.ir;
  const layout = computeLayout(ir);
  const pos = layout.pos;

  // 节点矩形（留 2px 余量，避免端点贴边误判）
  const rects = [];
  for (const item of pos.values()) {
    rects.push({ id: item.id, x: item.x + 2, y: item.y + 2, w: item.w - 4, h: item.h - 4 });
  }

  const crosses = [];
  const backLanes = [];
  let backSeq = 0;
  for (const f of ir.flows) {
    const s = pos.get(f.from);
    const t = pos.get(f.to);
    if (!s || !t) continue;
    const isBack = !(t.x >= s.x + s.w - 1);
    const wps = computeWaypoints(f, pos, isBack ? backSeq : undefined);
    if (isBack) {
      backSeq++;
      // 回边的水平通道（第二段之后的水平线）
      for (let i = 1; i < wps.length; i++) {
        if (Math.abs(wps[i - 1].y - wps[i].y) < 1 && Math.abs(wps[i - 1].x - wps[i].x) > 40) {
          backLanes.push(wps[i].y);
        }
      }
      // 回边必须从目标下边进入，不能从上方"穿"进来
      const last = wps[wps.length - 1];
      check('回边从目标下边进入：' + f.id, Math.abs(last.y - (t.y + t.h)) < 2,
        '落点 y=' + last.y + ' 目标下边 y=' + (t.y + t.h));
    }
    // 逐段检查是否穿过其它节点
    for (let i = 1; i < wps.length; i++) {
      const a = wps[i - 1];
      const b = wps[i];
      const x1 = Math.min(a.x, b.x);
      const x2 = Math.max(a.x, b.x);
      const y1 = Math.min(a.y, b.y);
      const y2 = Math.max(a.y, b.y);
      for (const r of rects) {
        if (r.id === f.from || r.id === f.to) continue;
        const hit = x1 < r.x + r.w && x2 > r.x && y1 < r.y + r.h && y2 > r.y;
        if (hit) crosses.push(f.id + ' 穿过 ' + r.id);
      }
    }
  }

  check('连线不穿过任何节点框', crosses.length === 0, crosses.slice(0, 4).join(' | '));
  check('多条回边使用不同的水平通道', new Set(backLanes).size === backLanes.length,
    JSON.stringify(backLanes));
}
function main() {
  console.log('BPMN 生成器测试套件');
  console.log('='.repeat(52));

  for (const f of listJson(CASES)) runPositive(f);
  for (const f of listJson(BAD)) runNegative(f);
  for (const f of listJson(REPAIRABLE)) runRepairable(f);
  runRepairUnit();
  runNlCases();
  runNumericUnit();
  runTemplateInvariants();
  runLayoutUnit();
  runPromptUnit();
  runArtifactsUnit();
  runHelpPageUnit();
  runScriptHygiene();

  console.log('');
  console.log('='.repeat(52));
  console.log('通过 ' + pass + ' / 失败 ' + fail);
  if (failures.length > 0) {
    console.log('');
    console.log('失败明细:');
    for (const x of failures) console.log('  - ' + x);
    process.exit(1);
  }
  console.log('全部通过。');
  process.exit(0);
}

// ---------------- 配套产物（表单 / 说明 / 分支用例） ----------------
function runArtifactsUnit() {
  console.log('');
  console.log('== 配套产物：表单 / 说明 / 分支用例 ==');

  const { buildArtifacts, sampleValueFor } = require('../src/artifacts');
  const { generateFromText } = require('../src/nl');

  const g = generateFromText('差旅报销，金额小于1000主管批，超过5000财务复核');
  check('产物：能按文本生成 IR', g.ok === true, g.error || '');
  const a = buildArtifacts(g.ir, g.template || null);

  const ids = a.form.fields.map((f) => f.id);
  check('产物：表单字段用渲染后的变量名', ids.indexOf('amount') >= 0, ids.join(','));
  check('产物：表单必含 approved 决策字段', ids.indexOf('approved') >= 0, ids.join(','));
  check('产物：表单无未替换占位符', ids.join(',').indexOf('@') === -1, ids.join(','));

  check('产物：说明含节点清单', a.doc.markdown.indexOf('## 节点') >= 0);
  check('产物：说明含分支条件表', a.doc.markdown.indexOf('## 分支与条件') >= 0);
  check('产物：说明含驳回路径段', a.doc.markdown.indexOf('## 驳回 / 退回路径') >= 0);

  check('产物：分支用例数正确', a.cases.total === 4, String(a.cases.total));
  const vals = a.cases.cases.map((c) => JSON.stringify(c.variables)).join(' ');
  check('产物：第一档样例满足 <=1000', vals.indexOf('"amount":999') >= 0, vals);
  check('产物：中间档样例满足区间', vals.indexOf('"amount":1001') >= 0, vals);
  check('产物：默认档样例超过最大阈值', vals.indexOf('"amount":5001') >= 0, vals);
  check('产物：驳回样例带 approved=false', vals.indexOf('"approved":false') >= 0, vals);

  const s1 = sampleValueFor('${amount <= 1000}');
  check('产物：上界条件取阈值-1', s1 && s1.value === 999, JSON.stringify(s1));
  const s2 = sampleValueFor("${execution.getVariable('approved') == false}");
  check('产物：布尔条件取 false', s2 && s2.value === false, JSON.stringify(s2));
}
main();
