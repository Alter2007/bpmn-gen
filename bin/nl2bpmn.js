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
  console.log('  --artifacts    额外输出配套产物：说明(.md) / 表单(.json) / 分支用例(.json)');
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
  let artifacts = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o' || a === '--out') output = argv[++i];
    else if (a === '--template') templateId = argv[++i];
    else if (a === '--stdout') toStdout = true;
    else if (a === '--json') jsonOnly = true;
    else if (a === '--verbose') verbose = true;
    else if (a === '--artifacts') artifacts = true;
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

  // 与界面版一致的"把握不大"判断：不阻塞生成，但把候选和目标模板摆出来
  if (!templateId) {
    const ranked = g.ranked || [];
    const top = ranked[0];
    const second = ranked[1];
    const MIN_SCORE = 4;
    const MARGIN = 2;
    const unsure = !top || top.score < MIN_SCORE || (second && second.score > 0 && top.score - second.score < MARGIN);
    if (unsure && ranked.length > 0) {
      console.log('[提示] 这句话把握不大（第一名仅 ' + top.score + ' 分）。如果生成结果不对，可以指定模板重跑：');
      for (const r of ranked.slice(0, 3)) {
        const nm = (r.template && r.template.name) || r.name || '';
        console.log('       --template ' + r.templateId.padEnd(20) + nm +
          (r.hits && r.hits.length ? '   命中: ' + r.hits.join(',') : ''));
      }
      console.log('');
    }
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

  // 配套产物：与界面版「下载说明 / 下载表单」同源，都是 src/artifacts.js
  if (artifacts) {
    const { buildArtifacts } = require('../src/artifacts');
    const a = buildArtifacts(r.ir, g.template || null);
    const base = outPath.replace(/\.bpmn$/i, '');
    fs.writeFileSync(base + '-说明.md', a.doc.markdown, 'utf8');
    fs.writeFileSync(base + '-表单.json', JSON.stringify(a.form, null, 2) + '\n', 'utf8');
    fs.writeFileSync(base + '-用例.json', JSON.stringify(a.cases, null, 2) + '\n', 'utf8');
    console.log('     配套: ' + path.basename(base) + '-说明.md / -表单.json / -用例.json' +
      '（' + a.cases.total + ' 条分支用例）');
  }
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
