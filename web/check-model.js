#!/usr/bin/env node
'use strict';

/**
 * L2b：用第三方标准模型库 bpmn-moddle 解析 BPMN，做独立于我们自己的校验。
 *
 * 为什么它有价值：
 *   XSD 只检查"语法符不符合 schema"，bpmn-moddle 检查的是"模型能不能被建出来"——
 *   它和 bpmn-js（演示渲染）、Camunda/Flowable 周边工具用的是同一套 moddle 描述。
 *   我们自己的 lint 给自己打分不算数，这个算第三方意见。
 *
 * 用法: node check-model.js <file.bpmn> [more.bpmn ...]
 * 退出码: 0 全部通过 / 1 有失败 / 2 用法错误
 */

const fs = require('fs');
const path = require('path');

// bpmn-moddle v10+ 以 { BpmnModdle } 形式导出，老版本是默认导出，两种都兼容
const moddleMod = require('bpmn-moddle');
const BpmnModdle = moddleMod.BpmnModdle || moddleMod.default || moddleMod;

function parse(moddle, xml) {
  // v10: fromXML 返回 Promise；老版本走回调
  const maybe = moddle.fromXML(xml);
  if (maybe && typeof maybe.then === 'function') {
    return maybe.then((res) => ({ definitions: res.rootElement, parseContext: res }));
  }
  return new Promise((resolve, reject) => {
    moddle.fromXML(xml, (err, definitions, parseContext) => {
      if (err) reject(err);
      else resolve({ definitions, parseContext });
    });
  });
}

function countTypes(process) {
  const out = {};
  const walk = (el) => {
    if (!el || !el.$type) return;
    const t = el.$type.replace(/^bpmn:/, '');
    out[t] = (out[t] || 0) + 1;
    for (const child of el.flowElements || []) walk(child);
    for (const child of el.children || []) walk(child);
  };
  walk(process);
  return out;
}

async function checkFile(moddle, file) {
  const xml = fs.readFileSync(file, 'utf8');
  try {
    const { definitions, parseContext } = await parse(moddle, xml);
    const roots = definitions.rootElements || [];
    const processes = roots.filter((e) => e.$type === 'bpmn:Process');
    // BPMNDiagram 不在 rootElements 里，而是在 definitions.diagrams 上
    const diagrams = definitions.diagrams || [];
    const warnings = (parseContext && parseContext.warnings) || [];

    if (processes.length !== 1) {
      console.log('[FAIL] ' + path.basename(file) + '  期望 1 个 process，实际 ' + processes.length);
      return false;
    }

    const p = processes[0];
    const counts = countTypes(p);
    // moddle 的 $type 是驼峰：bpmn:SequenceFlow -> SequenceFlow
    const flows = counts.SequenceFlow || 0;
    const gatewayDefault = (p.flowElements || []).filter(
      (e) => e.default && e.default.id
    ).length;

    console.log('[OK] ' + path.basename(file));
    console.log('     process: ' + p.id + '  isExecutable=' + p.isExecutable);
    console.log('     元素: ' + Object.keys(counts).length + ' 类 / 共 ' +
      Object.keys(counts).reduce((a, k) => a + counts[k], 0) + ' 个  连线 ' + flows + ' 条');
    console.log('     DI 图: ' + diagrams.length + ' 个   default 属性: ' + gatewayDefault + ' 处');
    if (warnings.length > 0) {
      console.log('     bpmn-moddle 警告 ' + warnings.length + ' 条:');
      for (const w of warnings.slice(0, 5)) console.log('       - ' + (w.message || w));
    }
    return true;
  } catch (e) {
    console.log('[FAIL] ' + path.basename(file) + '  解析失败: ' + (e.message || e));
    return false;
  }
}

async function main() {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.log('用法: node check-model.js <file.bpmn> [...]');
    process.exit(2);
  }

  const moddle = new BpmnModdle();
  let ok = 0;
  for (const f of files) {
    if (!fs.existsSync(f)) {
      console.log('[FAIL] 文件不存在: ' + f);
      continue;
    }
    if (await checkFile(moddle, f)) ok++;
    console.log('');
  }

  console.log('通过 ' + ok + ' / ' + files.length);
  process.exit(ok === files.length ? 0 : 1);
}

main().catch((e) => {
  console.log('[ERR] ' + (e && e.message ? e.message : e));
  process.exit(2);
});
