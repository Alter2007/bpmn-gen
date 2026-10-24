'use strict';

/**
 * 生成管线：把"修 -> 校验 -> 序列化 -> 良构检查"串成一个不可跳过的流程。
 *
 * 抽这一层的原因：
 *  1. CLI 与测试共用同一条路径，不存在"测试跑的是另一套逻辑"；
 *  2. 每一层的顺序被写死在这里，符合 P-07（必须是 IR 进、XML 出）；
 *  3. 任何一层失败立即返回错误，符合 P-08（不许静默降级、不许输出半成品）。
 */

const { validateIR } = require('./ir');
const { analyze } = require('./graph');
const { serialize } = require('./serialize');
const { lintXml } = require('./xml-lint');
const { repairIR } = require('./repair');

/**
 * @param {object} rawIR 原始 IR
 * @param {object} [opts] { repair: boolean }
 * @returns {{ok, ir, xml, errors, warnings, actions, elements, stages}}
 */
function runPipeline(rawIR, opts) {
  const options = opts || {};
  const errors = [];
  const warnings = [];
  const actions = [];
  const stages = [];

  let working = rawIR;

  // ---- 阶段 1（可选）：确定性修复 ----
  if (options.repair) {
    const r = repairIR(rawIR);
    working = r.ir;
    actions.push.apply(actions, r.actions);
    stages.push({ name: 'repair', ok: true, detail: r.actions.length + ' 项修复' });
  }

  // ---- 阶段 2：L0 契约 ----
  const v = validateIR(working);
  errors.push.apply(errors, v.errors);
  warnings.push.apply(warnings, v.warnings);
  stages.push({ name: 'validate(IR)', ok: v.errors.length === 0, detail: v.errors.length + ' 错误' });
  if (errors.length > 0) return { ok: false, ir: working, xml: null, errors, warnings, actions, elements: 0, stages };

  // ---- 阶段 3：L3 图论语义 ----
  const g = analyze(working);
  errors.push.apply(errors, g.errors);
  warnings.push.apply(warnings, g.warnings);
  stages.push({ name: 'analyze(graph)', ok: g.errors.length === 0, detail: g.errors.length + ' 错误' });
  if (errors.length > 0) return { ok: false, ir: working, xml: null, errors, warnings, actions, elements: 0, stages };

  // ---- 阶段 4：序列化 ----
  const xml = serialize(working);
  stages.push({ name: 'serialize', ok: true, detail: Buffer.byteLength(xml, 'utf8') + ' 字节' });

  // ---- 阶段 5：L1 良构 ----
  const lint = lintXml(xml);
  if (!lint.ok) {
    errors.push.apply(errors, lint.errors);
    stages.push({ name: 'lint(XML)', ok: false, detail: lint.errors.length + ' 错误' });
    return { ok: false, ir: working, xml: null, errors, warnings, actions, elements: 0, stages };
  }
  stages.push({ name: 'lint(XML)', ok: true, detail: lint.elements + ' 元素' });

  return { ok: true, ir: working, xml, errors, warnings, actions, elements: lint.elements, stages };
}

module.exports = { runPipeline };
