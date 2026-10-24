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
  'inclusiveGateway',
  // 边界事件：挂在任务边框上，用于「超时催办 / 超时升级」
  'boundaryEvent'
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
  const boundaryIds = new Set();
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
      if (n.type === 'boundaryEvent') boundaryIds.add(n.id);
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

    // 多实例（会签 / 或签）：只允许挂在 userTask / serviceTask 上
    if (n.multiInstance !== undefined && n.multiInstance !== null) {
      if (n.type !== 'userTask' && n.type !== 'serviceTask') {
        errors.push(`${at}(${n.id || '?'}) 只有任务才能配置 multiInstance（会签/或签）`);
      } else if (typeof n.multiInstance !== 'object') {
        errors.push(`${at}(${n.id || '?'}) multiInstance 应为对象`);
      } else {
        const mi = n.multiInstance;
        if (!mi.collection || typeof mi.collection !== 'string') {
          errors.push(`${at}(${n.id || '?'}) multiInstance.collection 必填，例如 "approvers"`);
        }
        if (!mi.elementVariable || typeof mi.elementVariable !== 'string') {
          errors.push(`${at}(${n.id || '?'}) multiInstance.elementVariable 必填，例如 "approver"`);
        }
        if (mi.completionCondition !== undefined && typeof mi.completionCondition !== 'string') {
          errors.push(`${at}(${n.id || '?'}) multiInstance.completionCondition 应为字符串表达式`);
        }
        if (mi.completionCondition && !/\$\{.*\}/.test(mi.completionCondition)) {
          warnings.push(`${at}(${n.id || '?'}) completionCondition 不像 Flowable 表达式（建议 ${'${...}'} 包裹）`);
        }
      }
    }

    // 边界事件（超时催办）：必须挂在任务上，且必须有定时器
    if (n.type === 'boundaryEvent') {
      if (!n.attachedTo || typeof n.attachedTo !== 'string') {
        errors.push(`${at}(${n.id || '?'}) 边界事件必须用 attachedTo 指定挂载的任务 id`);
      }
      if (!n.timer || typeof n.timer !== 'object') {
        errors.push(`${at}(${n.id || '?'}) 边界事件必须有 timer（如 {"type":"duration","value":"P3D"}）`);
      } else {
        const tv = n.timer.value;
        if (!tv || typeof tv !== 'string') {
          errors.push(`${at}(${n.id || '?'}) timer.value 必填，ISO-8601 时长如 P3D / PT8H`);
        } else if (!/^P(T)?[\dA-Z.]+$/i.test(tv)) {
          warnings.push(`${at}(${n.id || '?'}) timer.value "${tv}" 不像 ISO-8601 时长（P3D / PT8H / P1DT12H）`);
        }
        if (n.timer.type && n.timer.type !== 'duration' && n.timer.type !== 'cycle' && n.timer.type !== 'date') {
          errors.push(`${at}(${n.id || '?'}) timer.type 只能是 duration / cycle / date`);
        }
      }
      if (!n.name) warnings.push(`边界事件 ${n.id || at} 建议给 name（例如"超时"），便于业务方阅读`);
    }
  });

  // 边界事件的挂载目标必须在节点表里，而且必须是任务
  for (const n of nodes) {
    if (!n || n.type !== 'boundaryEvent' || !n.attachedTo) continue;
    if (!nodeIds.has(n.attachedTo)) {
      errors.push(`边界事件 ${n.id} 的 attachedTo 指向不存在的节点: ${n.attachedTo}`);
    } else {
      const owner = nodes.filter((x) => x && x.id === n.attachedTo)[0];
      if (owner && owner.type !== 'userTask' && owner.type !== 'serviceTask') {
        errors.push(`边界事件 ${n.id} 只能挂在任务上，不能挂在 ${owner.type}`);
      }
    }
  }

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
    // 边界事件靠"挂载到任务"触发，不允许有入向连线
    if (boundaryIds.has(f.to)) {
      errors.push(`${at}(${f.id || '?'}) 边界事件 ${f.to} 不能有入向连线（它由挂载关系触发）`);
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
