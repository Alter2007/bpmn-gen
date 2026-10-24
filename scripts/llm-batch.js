#!/usr/bin/env node
'use strict';

/**
 * 大模型批量回归：用真实模型跑 test/nl-cases.json 的全部用例，出一次通过率报告。
 *
 *   node scripts/llm-batch.js            真实调用（需要环境变量里的 Key）
 *   node scripts/llm-batch.js --mock     自检模式：用假响应验证报告逻辑，不联网
 *
 * 报告写入工作区 .data/out/llm-batch-<时间>.md（不污染项目目录，符合 P-09）。
 *
 * ⚠ 真实模式尚未验证（编写时无 Key）。自检模式已通过。
 */

const fs = require('fs');
const path = require('path');
const { loadTemplates, buildFromTemplate } = require('../src/nl');
const { buildSystemPrompt, buildUserMessage, parseModelOutput } = require('../src/prompt');
const { runPipeline } = require('../src/pipeline');
const { callChat, resolveConfig } = require('../src/llm');

const ROOT = path.join(__dirname, '..');
const CASES = path.join(ROOT, 'test', 'nl-cases.json');
const OUTDIR = path.join(ROOT, '..', '.data', 'out');

function mockReply(c) {
  if (c.expectMatch === false) {
    return '{"templateId":null,"slots":{},"confidence":0.2,"reason":"自检：判定为无关描述"}';
  }
  return JSON.stringify({
    templateId: c.expectTemplate,
    slots: {},
    confidence: 0.9,
    reason: '自检模式（非真实模型输出）'
  });
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

async function main() {
  const argv = process.argv.slice(2);
  const mock = argv.indexOf('--mock') !== -1;

  const cfg = resolveConfig({});
  const templates = loadTemplates();
  const cases = JSON.parse(fs.readFileSync(CASES, 'utf8'));
  const systemPrompt = buildSystemPrompt(templates);

  if (!mock && !cfg.hasKey) {
    console.log('[ERR] 未检测到 ' + cfg.keyEnv + '。');
    console.log('      先运行: dev-shell.cmd -WithKey');
    process.exit(3);
  }

  console.log('大模型批量回归  ' + (mock ? '[自检模式，不联网]' : '[真实调用]'));
  console.log('供应商: ' + cfg.providerName + '  模型: ' + cfg.model);
  console.log('用例数: ' + cases.length);
  console.log('='.repeat(64));

  const rows = [];
  let tokensIn = 0;
  let tokensOut = 0;

  for (const c of cases) {
    const label = c.name || 'case';
    const row = {
      label: label,
      expect: c.expectMatch === false ? '(应拒绝)' : c.expectTemplate,
      actual: '',
      parsed: false,
      pipeline: false,
      e2e: false,
      note: ''
    };

    let raw = '';
    try {
      if (mock) {
        raw = mockReply(c);
      } else {
        const r = await callChat({
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: buildUserMessage(c.text) }
          ]
        });
        raw = r.content;
        if (r.usage) {
          tokensIn += r.usage.prompt_tokens || 0;
          tokensOut += r.usage.completion_tokens || 0;
        }
      }
    } catch (e) {
      row.note = '调用失败: ' + (e && e.message ? e.message : e);
      rows.push(row);
      console.log('  [FAIL] ' + label + '  ' + row.note);
      continue;
    }

    const parsed = parseModelOutput(raw, templates);

    if (c.expectMatch === false) {
      row.actual = parsed.ok ? parsed.templateId : '(拒绝)';
      row.parsed = true;
      row.pipeline = true;
      row.e2e = parsed.ok === false;
      if (!row.e2e) row.note = '本应拒绝却匹配了 ' + row.actual;
      rows.push(row);
      console.log('  [' + (row.e2e ? 'PASS' : 'FAIL') + '] ' + label + '  -> ' + row.actual);
      continue;
    }

    if (!parsed.ok) {
      row.actual = parsed.error;
      row.note = '解析失败: ' + parsed.error;
      rows.push(row);
      console.log('  [FAIL] ' + label + '  ' + row.note);
      continue;
    }

    row.parsed = true;
    row.actual = parsed.templateId;

    const built = buildFromTemplate(parsed.templateId, parsed.slots, c.text);
    if (!built) {
      row.note = '模板渲染失败';
      rows.push(row);
      console.log('  [FAIL] ' + label + '  ' + row.note);
      continue;
    }

    const r = runPipeline(built.ir);
    row.pipeline = r.ok;
    if (!r.ok) row.note = r.errors.join('; ');

    row.e2e = r.ok && parsed.templateId === c.expectTemplate;
    if (!row.e2e && r.ok) row.note = '模板不匹配（期望 ' + c.expectTemplate + '）';

    rows.push(row);
    console.log('  [' + (row.e2e ? 'PASS' : 'FAIL') + '] ' + label + '  -> ' + row.actual);
  }

  const total = rows.length;
  const e2ePass = rows.filter((r) => r.e2e).length;
  const parsedPass = rows.filter((r) => r.parsed).length;
  const pipelinePass = rows.filter((r) => r.pipeline).length;

  const lines = [];
  lines.push('# 大模型一次通过率报告');
  lines.push('');
  lines.push('- 时间: ' + new Date().toLocaleString('zh-CN'));
  lines.push('- 模式: ' + (mock ? '**自检模式（假响应，不代表真实通过率）**' : '真实调用'));
  lines.push('- 供应商: ' + cfg.providerName + ' (' + cfg.providerId + ')');
  lines.push('- 模型: ' + cfg.model);
  lines.push('- 接口: ' + cfg.baseUrl);
  lines.push('- 用例数: ' + total);
  if (!mock) {
    lines.push('- Token 用量: 输入 ' + tokensIn + ' / 输出 ' + tokensOut);
  }
  lines.push('');
  lines.push('## 结果');
  lines.push('');
  lines.push('| 用例 | 期望 | 实际 | 解析 | 管线 | 端到端 | 备注 |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const r of rows) {
    lines.push(
      '| ' + r.label + ' | ' + r.expect + ' | ' + r.actual + ' | ' +
      (r.parsed ? 'Y' : 'N') + ' | ' + (r.pipeline ? 'Y' : 'N') + ' | ' +
      (r.e2e ? '**PASS**' : 'FAIL') + ' | ' + (r.note || '') + ' |'
    );
  }
  lines.push('');
  lines.push('## 汇总');
  lines.push('');
  lines.push('- 端到端通过: **' + e2ePass + ' / ' + total + '**（' + Math.round((e2ePass / total) * 100) + '%）');
  lines.push('- 输出可解析: ' + parsedPass + ' / ' + total);
  lines.push('- 管线校验通过: ' + pipelinePass + ' / ' + total);
  lines.push('');
  if (mock) {
    lines.push('> 注意：本报告为自检模式生成，用于验证报告与统计逻辑，**不能**作为模型能力的证据。');
  }

  if (!fs.existsSync(OUTDIR)) fs.mkdirSync(OUTDIR, { recursive: true });
  const reportPath = path.join(OUTDIR, 'llm-batch-' + stamp() + '.md');
  fs.writeFileSync(reportPath, lines.join('\r\n'), 'utf8');

  console.log('='.repeat(64));
  console.log('端到端通过: ' + e2ePass + ' / ' + total + '（' + Math.round((e2ePass / total) * 100) + '%）');
  console.log('输出可解析: ' + parsedPass + ' / ' + total + '    管线通过: ' + pipelinePass + ' / ' + total);
  if (!mock) console.log('Token 用量: 输入 ' + tokensIn + ' / 输出 ' + tokensOut);
  console.log('报告: ' + path.resolve(reportPath));

  process.exit(e2ePass === total ? 0 : 1);
}

main().catch((e) => {
  console.log('[ERR] 批量回归异常: ' + (e && e.message ? e.message : e));
  process.exit(2);
});
