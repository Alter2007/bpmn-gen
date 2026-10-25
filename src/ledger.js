'use strict';
/**
 * 生成台账：每次生成追加一行 JSONL。
 *
 * 为什么真实单位需要它：审计会问"这版流程是谁、按什么要求、什么时候生成的"。
 * 台账回答的就是这个问题，且是纯文本、可 git diff、可归档。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** 本地时间戳（台账给人看，必须和文件名一致；toISOString 是 UTC，会差 8 小时） */
function localStamp(d) {
  const x = d || new Date();
  const p = (n) => String(n).padStart(2, '0');
  return x.getFullYear() + '-' + p(x.getMonth() + 1) + '-' + p(x.getDate()) + ' ' +
    p(x.getHours()) + ':' + p(x.getMinutes()) + ':' + p(x.getSeconds());
}
/** 默认台账位置：与生成物同一个目录，便于一起归档 */
function defaultLedgerPath() {
  return path.join(__dirname, '..', '..', '.data', 'out', '生成台账.jsonl');
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

/**
 * 追加一条生成记录
 * @param {object} entry 记录内容（时间、原话、模板、参数、产物、校验）
 * @param {string} [file] 台账路径
 * @returns {{path:string, line:string}}
 */
function appendLedger(entry, file) {
  const target = file || defaultLedgerPath();
  const dir = path.dirname(target);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const line = JSON.stringify(entry) + '\n';
  fs.appendFileSync(target, line, 'utf8');
  return { path: target, line: line };
}

/**
 * 由一次生成的结果组装台账条目
 * @param {{ir:object, xml:string, meta:object, pipeline?:object, output?:string}} ctx
 */
function buildEntry(ctx) {
  const ir = ctx.ir || {};
  const meta = ctx.meta || {};
  return {
    time: meta.generatedAt || localStamp(),
    sourceText: meta.sourceText || '',
    templateId: meta.templateId || '',
    processKey: ir.processKey || ir.id || '',
    versionTag: ir.versionTag || '',
    name: ir.name || '',
    nodes: (ir.nodes || []).length,
    flows: (ir.flows || []).length,
    warnings: ((ctx.pipeline && ctx.pipeline.warnings) || []).length,
    xmlSha256: sha256(ctx.xml || ''),
    output: ctx.output || '',
    formKey: ir.formKey || '',
    mode: meta.mode || 'cli'
  };
}

module.exports = { appendLedger, buildEntry, defaultLedgerPath, sha256, localStamp };
