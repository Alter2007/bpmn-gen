#!/usr/bin/env node
'use strict';

/**
 * 大模型通道 CLI：自然语言 -> 模板选择 -> BPMN
 *
 *   ai2bpmn.js --models          列出当前 Key 可用的模型（推荐第一步）
 *   ai2bpmn.js --dry-run "描述"  只打印提示词，不联网
 *   ai2bpmn.js --mock "描述"     用内置假响应跑通全链路，不联网
 *   ai2bpmn.js "描述"            真实调用
 *
 * 退出码：0 成功 / 2 失败 / 3 缺少 Key
 */

const fs = require('fs');
const path = require('path');
const { loadTemplates, buildFromTemplate } = require('../src/nl');
const { buildSystemPrompt, buildUserMessage, parseModelOutput } = require('../src/prompt');
const { runPipeline } = require('../src/pipeline');
const { callChat, listModels, resolveConfig, listProviders } = require('../src/llm');

// 产物只允许落在工作区的 .data/out（P-09）
const OUT_DIR = path.join(__dirname, '..', '..', '.data', 'out');

function defaultOutPath(name) {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  return path.join(OUT_DIR, name);
}

const MOCK_OUTPUT = [
  '```json',
  '{',
  '  "templateId": "amount_tiered",',
  '  "slots": { "subject": "报销", "tier1": 2000, "tier2": 8000 },',
  '  "confidence": 0.92,',
  '  "reason": "描述中出现金额分级条件"',
  '}',
  '```'
].join('\n');

function usage() {
  const cfg = resolveConfig({});
  console.log('用法: node bin/ai2bpmn.js "<业务描述>" [选项]');
  console.log('');
  console.log('  --models       列出当前 Key 可用模型（建议第一次先跑这个）');
  console.log('  --dry-run      只打印提示词，不联网、不需要 Key');
  console.log('  --mock         用内置假响应跑通全链路，不联网、不需要 Key');
  console.log('  -o, --out      输出文件');
  console.log('  --stdout       只打印 XML');
  console.log('  --verbose      打印模型原始输出');
  console.log('');
  console.log('当前供应商: ' + cfg.providerName + '（LLM_PROVIDER=' + cfg.providerId + '）');
  console.log('  接口: ' + cfg.baseUrl);
  console.log('  模型: ' + cfg.model + '（LLM_MODEL 可覆盖）');
  console.log('  密钥: 环境变量 ' + cfg.keyEnv + '（' + (cfg.hasKey ? '已设置' : '未设置') + '）');
  console.log('');
  console.log('切换供应商: set LLM_PROVIDER=dashscope（用通义千问）');
  console.log('安全录入 Key: dev-shell.cmd -WithKey');
  console.log('');
  console.log('退出码: 0 成功 / 2 失败 / 3 缺少 Key');
}

function printProviders() {
  console.log('支持的供应商:');
  for (const p of listProviders()) {
    console.log('  ' + p.id.padEnd(10) + p.name);
    console.log('  ' + ''.padEnd(10) + '接口 ' + p.baseUrl);
    console.log('  ' + ''.padEnd(10) + '模型 ' + p.model + '   密钥变量 ' + p.keyEnv);
    console.log('  ' + ''.padEnd(10) + '控制台 ' + p.console);
  }
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    usage();
    process.exit(argv.length === 0 ? 2 : 0);
  }

  let text = null;
  let output = null;
  let dryRun = false;
  let mock = false;
  let toStdout = false;
  let verbose = false;
  let showModels = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o' || a === '--out') output = argv[++i];
    else if (a === '--dry-run') dryRun = true;
    else if (a === '--mock') mock = true;
    else if (a === '--stdout') toStdout = true;
    else if (a === '--verbose') verbose = true;
    else if (a === '--models') showModels = true;
    else if (a === '--providers') { printProviders(); process.exit(0); }
    else if (!text) text = a;
  }

  const cfg = resolveConfig({});

  // ---- 列出可用模型 ----
  if (showModels) {
    if (!cfg.hasKey) {
      console.log('[ERR] 未检测到 ' + cfg.keyEnv + '。');
      console.log('      最简单：双击工作区里的 start-here.cmd');
      console.log('      或在受控窗口里：dev-shell.cmd -WithKey');
      process.exit(3);
    }
    console.log('[查询] ' + cfg.providerName + ' ' + cfg.baseUrl + ' ...');
    listModels()
      .then((ids) => {
        if (ids.length === 0) {
          console.log('[提示] 接口没有返回模型列表，请到控制台查看：' + cfg.console);
          process.exit(0);
        }
        console.log('');
        console.log('可用模型（' + ids.length + ' 个）:');
        for (const id of ids) console.log('  - ' + id);
        console.log('');
        console.log('用其中一个模型运行：');
        console.log('  PowerShell: $env:LLM_MODEL=' + ids[0]);
        console.log('  cmd:        set LLM_MODEL=' + ids[0]);
        console.log('  .\\ai2bpmn.cmd "你的业务描述"');
        process.exit(0);
      })
      .catch((e) => {
        console.log('[ERR] 查询失败: ' + (e && e.message ? e.message : e));
        console.log('      控制台: ' + cfg.console);
        process.exit(2);
      });
    return;
  }

  if (!text) { usage(); process.exit(2); }

  const templates = loadTemplates();
  const systemPrompt = buildSystemPrompt(templates);
  const userMessage = buildUserMessage(text);

  if (dryRun) {
    console.log('=== SYSTEM PROMPT ===');
    console.log(systemPrompt);
    console.log('');
    console.log('=== USER MESSAGE ===');
    console.log(userMessage);
    console.log('');
    console.log('=== 体积 ===');
    console.log('  系统: ' + Buffer.byteLength(systemPrompt, 'utf8') + ' 字节');
    console.log('  用户: ' + Buffer.byteLength(userMessage, 'utf8') + ' 字节');
    process.exit(0);
  }

  if (!cfg.hasKey && !mock) {
    console.log('[ERR] 未检测到环境变量 ' + cfg.keyEnv + '（当前供应商 ' + cfg.providerName + '）。');
    console.log('');
    console.log('安全设置方式（Key 不落盘、不回显、不进命令历史）：');
    console.log('  1) dev-shell.cmd -WithKey');
    console.log('  2) 在该窗口运行 ai2bpmn.cmd "你的业务描述"');
    console.log('');
    console.log('Key 在哪拿：' + cfg.console);
    console.log('想看效果不花额度：ai2bpmn.cmd --dry-run "描述"   或   --mock "描述"');
    process.exit(3);
  }

  const go = async () => {
    let raw;
    if (mock) {
      raw = MOCK_OUTPUT;
      console.log('[mock] 使用内置假响应，不联网。');
    } else {
      console.log('[调用] ' + cfg.providerName + ' / ' + cfg.model + ' / ' + cfg.baseUrl);
      const r = await callChat({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage }
        ]
      });
      raw = r.content;
      if (r.usage) {
        console.log('[用量] prompt=' + r.usage.prompt_tokens + ' completion=' + r.usage.completion_tokens);
      }
    }

    if (verbose) {
      console.log('--- 模型原始输出 ---');
      console.log(raw);
      console.log('--------------------');
    }

    const parsed = parseModelOutput(raw, templates);
    if (!parsed.ok) {
      console.log('[ERR] 模型输出不可用：' + parsed.error);
      if (parsed.reason) console.log('      模型理由: ' + parsed.reason);
      if (String(parsed.error).indexOf('不存在') !== -1) {
        console.log('      提示: 可能是模型不在模板清单内；先看 ai2bpmn.cmd --dry-run 的模板列表');
      }
      process.exit(2);
    }

    for (const w of parsed.warnings) console.log('[提示] ' + w);

    const built = buildFromTemplate(parsed.templateId, parsed.slots, text);
    if (!built) {
      console.log('[ERR] 模板渲染失败: ' + parsed.templateId);
      process.exit(2);
    }

    const result = runPipeline(built.ir);
    if (!result.ok) {
      console.log('[ERR] 生成的 IR 未通过管线校验：');
      for (const e of result.errors) console.log('      - ' + e);
      process.exit(2);
    }

    if (toStdout) {
      process.stdout.write(result.xml);
      process.exit(0);
    }

    const outPath = output || defaultOutPath(parsed.templateId + '.bpmn');
    fs.writeFileSync(outPath, result.xml, 'utf8');

    console.log('[OK] ' + result.ir.name);
    console.log('     模板: ' + parsed.templateId + (parsed.confidence !== null ? '（置信度 ' + parsed.confidence + '）' : ''));
    if (parsed.reason) console.log('     理由: ' + parsed.reason);
    console.log('     节点: ' + result.ir.nodes.length + ' 个   连线: ' + result.ir.flows.length + ' 条');
    console.log('     输出: ' + path.resolve(outPath) + ' (' + Buffer.byteLength(result.xml, 'utf8') + ' 字节)');
    process.exit(0);
  };

  go().catch((e) => {
    console.log('[ERR] 调用失败: ' + (e && e.message ? e.message : e));
    console.log('      若提示模型不存在，先跑: ai2bpmn.cmd --models');
    process.exit(2);
  });
}

main();
