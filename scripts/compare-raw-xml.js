#!/usr/bin/env node
'use strict';
/**
 * 对照实验：本方案（模板 + 确定性序列化） vs 大模型直出 BPMN XML
 *
 * 为什么做这个：项目的核心主张是「不让模型写 XML」。
 * 光讲道理没有说服力，需要一份数据：同一批业务描述，
 * 两条路线各自生成的 XML 有多少能通过真实校验。
 *
 * 两条路线的校验口径完全相同（都只用与具体路线无关的检查）：
 *   1) 良构 XML
 *   2) OMG 官方 BPMN 2.0 XSD
 *   3) Flowable 引擎解析 + 流程校验
 *
 * 用法：
 *   set DEEPSEEK_API_KEY=sk-xxxx
 *   node scripts/compare-raw-xml.js                 # 默认 10 条
 *   node scripts/compare-raw-xml.js --n 20          # 指定条数
 *   node scripts/compare-raw-xml.js --dry-run       # 不调模型，只跑本方案那一侧（CI 用）
 *
 * 产物：.data/compare-report.json + 控制台表格
 *
 * 注意：这是一个"研究/评测"脚本，会调用 java 命令行做 XSD 与引擎校验；
 *      产品本体的 web 服务不会 spawn 任何子进程（见 PRINCIPLES P-04）。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { generateFromText } = require('../src/nl');
const { runPipeline } = require('../src/pipeline');
const { lintXml } = require('../src/xml-lint');
const llm = require('../src/llm');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, '..', '.data');
const TMP = path.join(OUT, 'compare-tmp');
const XSD_DIR = path.join(ROOT, '..', '.cache', 'schema', 'bpmn20');
const ENGINE_JARS = path.join(ROOT, '..', '.cache', 'flowable-engine');

const SENTENCES = [
  '差旅报销，金额小于1000主管批，超过5000需要财务复核',
  '请假3天以内主管批，超过7天人事批',
  '采购申请超过10万需要副总批',
  '采购合同需要法务、财务一起会签',
  '多人会签，全部签完才通过',
  '或签，任意一人处理即可',
  '审批超时3天没处理就自动升级',
  '我要用章盖章',
  '员工离职审批',
  '申请系统权限',
  '重要会议审批',
  '投诉信访处理'
];

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function javaVersionOk() {
  try {
    execFileSync('java', ['-version'], { stdio: 'ignore' });
    return true;
  } catch (e) {
    return false;
  }
}

/** 用官方 XSD 校验一个文件 */
function checkXsd(file) {
  try {
    execFileSync('java', ['-Dfile.encoding=UTF-8', path.join(ROOT, 'tools', 'xsd-validate', 'Validate.java'), file, XSD_DIR], { stdio: 'ignore' });
    return true;
  } catch (e) {
    return false;
  }
}

/** 用 Flowable 引擎校验一个文件（解析 + 流程校验） */
function checkEngine(file) {
  try {
    execFileSync('java', ['-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-cp', path.join(ENGINE_JARS, '*'), path.join(ROOT, 'tools', 'flowable-check', 'FlowableCheck.java'), file], { stdio: 'ignore' });
    return true;
  } catch (e) {
    return false;
  }
}

function totalCheck(xml, file) {
  const lint = lintXml(xml);
  const wellFormed = !!(lint && lint.ok);
  let xsd = false;
  let engine = false;
  if (wellFormed) {
    fs.writeFileSync(file, xml, 'utf8');
    xsd = checkXsd(file);
    if (xsd) engine = checkEngine(file);
  }
  return { wellFormed, xsd, engine };
}

const RAW_XML_SYSTEM = [
  '你是一个 BPMN 2.0 建模助手。根据用户的中文业务描述，直接输出一份完整的 BPMN 2.0 XML。',
  '要求：',
  '1) 只输出 XML 本体，不要解释，不要 markdown 代码块；',
  '2) 必须含 <bpmn:definitions> 根元素，命名空间齐全，并带 bpmndi:BPMNDiagram 图形信息；',
  '3) 审批节点用 bpmn:userTask，人员用 flowable:assignee；',
  '4) 结束事件必须可达。'
].join('\n');

function stripFence(s) {
  return String(s || '')
    .replace(/^\s*```(?:xml)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
}

async function main() {
  const n = Number(arg('n', 10));
  const dryRun = !!arg('dry-run', false);
  ensureDir(OUT);
  ensureDir(TMP);

  if (!javaVersionOk()) {
    console.error('[ERR] 找不到 java，无法做 XSD / 引擎校验');
    process.exit(2);
  }

  const sentences = SENTENCES.slice(0, n);
  const rows = [];

  console.log('对照实验：模板方案 vs 大模型直出 XML');
  console.log('='.repeat(64));
  console.log('用例数: ' + sentences.length + (dryRun ? '（dry-run，不调用模型）' : ''));

  for (let i = 0; i < sentences.length; i++) {
    const text = sentences[i];
    const row = { index: i + 1, text };

    // ---- 路线 A：本方案（模板 + 确定性序列化） ----
    const g = generateFromText(text);
    if (!g.ok) {
      row.template = { ok: false, reason: g.error };
    } else {
      const r = runPipeline(g.ir);
      if (!r.ok) {
        row.template = { ok: false, reason: (r.errors || []).slice(0, 2).join('; ') };
      } else {
        const file = path.join(TMP, 'tpl-' + i + '-' + g.templateId + '.bpmn');
        const chk = totalCheck(r.xml, file);
        row.template = {
          ok: chk.wellFormed && chk.xsd && chk.engine,
          templateId: g.templateId,
          score: g.score,
          wellFormed: chk.wellFormed,
          xsd: chk.xsd,
          engine: chk.engine,
          bytes: r.xml.length
        };
      }
    }

    // ---- 路线 B：大模型直出 XML ----
    if (dryRun) {
      row.raw = { skipped: true };
    } else {
      const t0 = Date.now();
      try {
        const res = await llm.callChat({
          messages: [{ role: 'system', content: RAW_XML_SYSTEM }, { role: 'user', content: text }]
        });
        const xml = stripFence(res && res.content);
        if (!xml || xml.indexOf('<') === -1) {
          row.raw = { ok: false, reason: '模型没有返回 XML' };
        } else {
          const file = path.join(TMP, 'raw-' + i + '.bpmn');
          const chk = totalCheck(xml, file);
          row.raw = {
            ok: chk.wellFormed && chk.xsd && chk.engine,
            wellFormed: chk.wellFormed,
            xsd: chk.xsd,
            engine: chk.engine,
            bytes: xml.length,
            ms: Date.now() - t0
          };
        }
      } catch (e) {
        row.raw = { ok: false, reason: e.message };
      }
    }

    rows.push(row);

    const A = row.template.ok ? 'PASS' : 'FAIL';
    const B = row.raw && row.raw.skipped ? ' —  ' : (row.raw && row.raw.ok ? 'PASS' : 'FAIL');
    console.log(
      '  ' + String(i + 1).padStart(2) + '. ' +
      text.slice(0, 26).padEnd(28) +
      ' 模板:' + A + (row.template.templateId ? '(' + row.template.templateId + ')' : '') +
      '  直出:' + B
    );
  }

  const cnt = (side) => rows.filter((r) => r[side] && r[side].ok).length;
  const total = rows.length;
  const summary = {
    total: total,
    dryRun: dryRun,
    template: {
      pass: cnt('template'),
      rate: +(cnt('template') / total * 100).toFixed(1)
    },
    raw: dryRun ? null : {
      pass: cnt('raw'),
      rate: +(cnt('raw') / total * 100).toFixed(1)
    },
    generatedAt: new Date().toISOString(),
    rows: rows
  };

  const file = path.join(OUT, 'compare-report.json');
  fs.writeFileSync(file, JSON.stringify(summary, null, 2) + '\n', 'utf8');

  console.log('');
  console.log('='.repeat(64));
  console.log('模板方案：' + summary.template.pass + '/' + total + '（' + summary.template.rate + '%）');
  if (summary.raw) {
    console.log('模型直出：' + summary.raw.pass + '/' + total + '（' + summary.raw.rate + '%）');
  }
  console.log('明细：' + file);

  if (!dryRun && summary.template.pass < total) {
    console.log('注意：模板方案没有全过，说明有模板本身的问题，先修模板再看对照数据。');
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('[ERR] ' + e.message);
  process.exit(2);
});
