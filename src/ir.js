'use strict';

/**
 * IR（中间表示）契约与校验。
 * 设计原则：LLM 只产出这个结构的 JSON，绝不直接产出 XML。
 */

const NODE_TYPES = new Set([
  'startEvent',
  'endEvent',
  'userTask',
  'serviceTask',
  'scriptTask',
  'exclusiveGateway',
  'parallelGateway',
  'inclusiveGateway'
]);

const GATEWAY_TYPES = new Set(['exclusiveGateway', 'parallelGateway', 'inclusiveGateway']);

function isGateway(type) {
  return GATEWAY_TYPES.has(type);
}

function isEvent(type) {
  return type === 'startEvent' || type === 'endEvent';
}

/**
 * 校验 IR 的结构合法性（L0，不涉及图论）。
 * @returns {{errors: string[], warnings: string[]}}
 */
function validateIR(ir) {
  const errors = [];
  const warnings = [];

  if (!ir || typeof ir !== 'object' || Array.isArray(ir)) {
    return { errors: ['IR 必须是对象'], warnings };
  }

  const nodes = Array.isArray(ir.nodes) ? ir.nodes : [];
  const flows = Array.isArray(ir.flows) ? ir.flows : [];

  if (!ir.id || typeof ir.id !== 'string') {
    errors.push('缺少 id（流程标识）');
  }
  if (!ir.name || typeof ir.name !== 'string') {
    warnings.push('缺少 name（流程名称），将使用 id 作为名称');
  }
  if (nodes.length === 0) {
    errors.push('nodes 不能为空');
  }

  // ---- 节点 ----
  const nodeIds = new Set();
  nodes.forEach((n, i) => {
    const at = `nodes[${i}]`;
    if (!n || typeof n !== 'object') {
      errors.push(`${at} 不是对象`);
      return;
    }
    if (!n.id || typeof n.id !== 'string') {
      errors.push(`${at} 缺少 id`);
    } else if (nodeIds.has(n.id)) {
      errors.push(`节点 id 重复: ${n.id}`);
    } else {
      nodeIds.add(n.id);
    }
    if (!NODE_TYPES.has(n.type)) {
      errors.push(`${at}(${n.id || '?'}) 节点类型不支持: ${n.type}`);
    }
    if (n.name !== undefined && typeof n.name !== 'string') {
      warnings.push(`${at}(${n.id || '?'}) name 应为字符串`);
    }
    if (isGateway(n.type) && typeof n.name !== 'string') {
      warnings.push(`网关 ${n.id || at} 建议给 name，便于业务方阅读`);
    }
  });

  // ---- 连线 ----
  const flowIds = new Set();
  const defaultsBySource = new Map();

  flows.forEach((f, i) => {
    const at = `flows[${i}]`;
    if (!f || typeof f !== 'object') {
      errors.push(`${at} 不是对象`);
      return;
    }
    if (!f.id || typeof f.id !== 'string') {
      errors.push(`${at} 缺少 id`);
    } else if (flowIds.has(f.id)) {
      errors.push(`连线 id 重复: ${f.id}`);
    } else {
      flowIds.add(f.id);
    }
    if (!nodeIds.has(f.from)) {
      errors.push(`${at}(${f.id || '?'}) 起点不存在: ${f.from}`);
    }
    if (!nodeIds.has(f.to)) {
      errors.push(`${at}(${f.id || '?'}) 终点不存在: ${f.to}`);
    }
    if (f.from && f.to && f.from === f.to) {
      errors.push(`${at}(${f.id || '?'}) 不允许自环`);
    }
    if (f.condition !== undefined && typeof f.condition !== 'string') {
      errors.push(`${at}(${f.id || '?'}) condition 应为字符串`);
    }
    if (f.condition && !/\$\{.*\}/.test(f.condition)) {
      warnings.push(`${at}(${f.id || '?'}) condition 不像 Flowable 表达式（建议 ${'${...}'} 包裹）`);
    }
    if (f.default === true) {
      if (!defaultsBySource.has(f.from)) defaultsBySource.set(f.from, []);
      defaultsBySource.get(f.from).push(f.id || at);
    }
  });

  for (const [source, list] of defaultsBySource.entries()) {
    if (list.length > 1) {
      errors.push(`节点 ${source} 有 ${list.length} 条默认流，最多只能 1 条: ${list.join(', ')}`);
    }
  }

  // ---- 变量 ----
  if (ir.variables !== undefined && !Array.isArray(ir.variables)) {
    errors.push('variables 必须是数组');
  }

  return { errors, warnings };
}

module.exports = { validateIR, NODE_TYPES, GATEWAY_TYPES, isGateway, isEvent };
