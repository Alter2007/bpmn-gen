#!/usr/bin/env node
'use strict';

/**
 * CLI：IR JSON -> BPMN 2.0 XML
 *   node bin/bpmn-gen.js <input.json> [-o out.bpmn] [--repair] [--stdout] [--verbose]
 * 退出码：0 成功 / 2 校验失败
 */

const fs = require('fs');
const path = require('path');
const { runPipeline } = require('../src/pipeline');

function usage() {
  console.log('用法: node bin/bpmn-gen.js <input.json> [-o 输出.bpmn] [选项]');
  console.log('');
  console.log('  -o, --out     指定输出文件（默认 <流程id>.bpmn）');
  console.log('  --repair      先做确定性修复，再校验（缺 id/自环/悬空端点/多余默认流）');
  console.log('  --stdout      只打印 XML，不写文件');
  console.log('  --verbose     打印管线各阶段耗时与结果');
  console.log('  --quiet       只打印结论');
  console.log('');
  console.log('退出码: 0 成功 / 2 校验失败');
}

function printErrors(list) {
  console.log('[ERR] 管线中止，共 ' + list.length + ' 项错误：');
  for (const e of list) console.log('      - ' + e);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    usage();
    process.exit(argv.length === 0 ? 2 : 0);
  }

  let input = null;
  let output = null;
  let toStdout = false;
  let quiet = false;
  let verbose = false;
  let repair = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o' || a === '--out') { output = argv[++i]; }
    else if (a === '--stdout') { toStdout = true; }
    else if (a === '--quiet') { quiet = true; }
    else if (a === '--verbose') { verbose = true; }
    else if (a === '--repair') { repair = true; }
    else if (!input) { input = a; }
  }

  if (!input) { usage(); process.exit(2); }
  if (!fs.existsSync(input)) {
    console.log('[ERR] 输入文件不存在: ' + input);
    process.exit(2);
  }

  let ir;
  try {
    ir = JSON.parse(fs.readFileSync(input, 'utf8'));
  } catch (e) {
    console.log('[ERR] JSON 解析失败: ' + e.message);
    process.exit(2);
  }

  const startedAt = process.hrtime.bigint();
  const result = runPipeline(ir, { repair });
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

  if (!result.ok) {
    printErrors(result.errors);
    if (result.actions.length > 0) {
      console.log('');
      console.log('[提示] 已执行 ' + result.actions.length + ' 项修复，但仍有未修复错误：');
      for (const a of result.actions) console.log('      · ' + a);
    }
    process.exit(2);
  }

  if (toStdout) {
    process.stdout.write(result.xml);
    process.exit(0);
  }

  const outPath = output || (String(result.ir.id || 'process') + '.bpmn');
  fs.writeFileSync(outPath, result.xml, 'utf8');

  if (!quiet) {
    console.log('[OK] ' + (result.ir.name || result.ir.id));
    console.log('     节点: ' + (result.ir.nodes || []).length + ' 个');
    console.log('     连线: ' + (result.ir.flows || []).length + ' 条');
    console.log('     XML 元素: ' + result.elements + ' 个');
    console.log('     输出: ' + path.resolve(outPath) + ' (' + Buffer.byteLength(result.xml, 'utf8') + ' 字节)');
    console.log('     耗时: ' + elapsedMs.toFixed(1) + ' ms');

    if (result.actions.length > 0) {
      console.log('     已自动修复 ' + result.actions.length + ' 项:');
      for (const a of result.actions) console.log('       · ' + a);
    }

    if (verbose) {
      console.log('     管线:');
      for (const s of result.stages) {
        console.log('       ' + (s.ok ? '[OK]  ' : '[FAIL]') + ' ' + s.name + '  (' + s.detail + ')');
      }
    }

    if (result.warnings.length > 0) {
      console.log('     警告 ' + result.warnings.length + ' 条:');
      for (const w of result.warnings) console.log('       - ' + w);
    }
  }

  process.exit(0);
}

main();
