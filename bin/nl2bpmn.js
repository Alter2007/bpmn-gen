#!/usr/bin/env node
'use strict';

/**
 * 自然语言 -> BPMN 的一站式 CLI（离线，不需要任何 API Key）
 *   node bin/nl2bpmn.js "我要做一个差旅报销审批流，金额小于1000主管批，超过5000财务复核"
 * 退出码：0 成功 / 2 失败
 */

const fs = require('fs');
const path = require('path');
const { generateFromText, listTemplates } = require('../src/nl');
const { runPipeline } = require('../src/pipeline');

// 产物只允许落在工作区的 .data/out（P-09）
const OUT_DIR = path.join(__dirname, '..', '..', '.data', 'out');

function defaultOutPath(name) {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  return path.join(OUT_DIR, name);
}

function usage() {
  console.log('用法: node bin/nl2bpmn.js "<业务描述>" [-o 输出.bpmn] [选项]');
  console.log('');
  console.log('  -o, --out      输出文件（默认 <模板id>.bpmn）');
  console.log('  --template     强制指定模板，跳过自动匹配');
  console.log('  --list         列出所有可用模板');
  console.log('  --stdout       只打印 XML');
  console.log('  --json         只打印生成的 IR（调试用）');
  console.log('  --verbose      打印匹配过程与槽位填充明细');
  console.log('');
  console.log('退出码: 0 成功 / 2 失败');
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    usage();
    process.exit(argv.length === 0 ? 2 : 0);
  }

  let text = null;
  let output = null;
  let templateId = null;
  let toStdout = false;
  let jsonOnly = false;
  let verbose = false;
  let list = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o' || a === '--out') output = argv[++i];
    else if (a === '--template') templateId = argv[++i];
    else if (a === '--stdout') toStdout = true;
    else if (a === '--json') jsonOnly = true;
    else if (a === '--verbose') verbose = true;
    else if (a === '--list') list = true;
    else if (!text) text = a;
  }

  if (list) {
    const tpls = listTemplates();
    console.log('可用模板（' + tpls.length + ' 个）:');
    console.log('');
    for (const t of tpls) {
      console.log('  ' + t.templateId.padEnd(22) + t.name);
      console.log('  ' + ''.padEnd(22) + t.description);
      console.log('  ' + ''.padEnd(22) + '关键词: ' + (t.keywords || []).join(' / '));
      console.log('  ' + ''.padEnd(22) + '节点 ' + t.nodeCount + ' 个 / 连线 ' + t.flowCount + ' 条');
      console.log('');
    }
    process.exit(0);
  }

  if (!text) { usage(); process.exit(2); }

  const g = generateFromText(text, { templateId: templateId || undefined });

  if (!g.ok) {
    console.log('[ERR] ' + g.error);
    if (g.ranked && g.ranked.length > 0) {
      console.log('');
      console.log('最接近的模板：');
      for (const r of g.ranked) {
        console.log('  ' + r.templateId + '  得分 ' + r.score + (r.hits && r.hits.length ? '  命中: ' + r.hits.join(',') : ''));
      }
    }
    process.exit(2);
  }

  if (verbose) {
    console.log('[匹配] 模板 ' + g.templateId + '（' + g.templateName + '）  得分 ' + g.score);
    for (const r of g.ranked) {
      console.log('        ' + r.templateId.padEnd(22) + '得分 ' + String(r.score).padStart(3) + '   命中: ' + (r.hits.join(',') || '-'));
    }
    console.log('[槽位]');
    for (const k of Object.keys(g.filled)) {
      console.log('        ' + k.padEnd(10) + '= ' + g.filled[k]);
    }
    for (const w of g.warnings) console.log('[提示] ' + w);
    console.log('');
  }

  if (jsonOnly) {
    process.stdout.write(JSON.stringify(g.ir, null, 2) + '\n');
    process.exit(0);
  }

  const r = runPipeline(g.ir);
  if (!r.ok) {
    console.log('[ERR] 生成的 IR 未通过管线校验（这是模板的 bug）：');
    for (const e of r.errors) console.log('      - ' + e);
    process.exit(2);
  }

  if (toStdout) {
    process.stdout.write(r.xml);
    process.exit(0);
  }

  const outPath = output || defaultOutPath(g.templateId + '.bpmn');
  fs.writeFileSync(outPath, r.xml, 'utf8');

  console.log('[OK] ' + r.ir.name);
  console.log('     模板: ' + g.templateId + '（得分 ' + g.score + '）');
  console.log('     节点: ' + r.ir.nodes.length + ' 个   连线: ' + r.ir.flows.length + ' 条');
  console.log('     输出: ' + path.resolve(outPath) + ' (' + Buffer.byteLength(r.xml, 'utf8') + ' 字节)');
  if (g.filledNumeric.length > 0) {
    console.log('     从文本提取: ' + g.filledNumeric.join(', '));
  }
  if (r.warnings.length > 0) {
    console.log('     警告 ' + r.warnings.length + ' 条:');
    for (const w of r.warnings) console.log('       - ' + w);
  }

  process.exit(0);
}

main();
