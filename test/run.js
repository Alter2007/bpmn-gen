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
const OUT = path.join(__dirname, '..', '..', '.data', 'out');

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

  const condCount = r.ir.flows.filter((f) => f.condition).length;
  check(name + ' / 条件表达式 CDATA', countOccurrences(xml, '<![CDATA[') === condCount,
    '期望 ' + condCount + ' 实际 ' + countOccurrences(xml, '<![CDATA['));

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

  for (const c of cases) {
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
    fs.writeFileSync(path.join(OUT, 'nl-' + label + '.bpmn'), r.xml, 'utf8');
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
  for (const f of fs.readdirSync(ws)) {
    const p = path.join(ws, f);
    if (!fs.statSync(p).isFile()) continue;
    if (f.endsWith('.cmd')) cmdFiles.push(p);
    if (f.endsWith('.ps1')) ps1Files.push(p);
  }
  walk(root);
  walk(path.join(ws, '_env'));

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

function main() {
  console.log('BPMN 生成器测试套件');
  console.log('='.repeat(52));

  for (const f of listJson(CASES)) runPositive(f);
  for (const f of listJson(BAD)) runNegative(f);
  for (const f of listJson(REPAIRABLE)) runRepairable(f);
  runRepairUnit();
  runNlCases();
  runPromptUnit();
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

main();
