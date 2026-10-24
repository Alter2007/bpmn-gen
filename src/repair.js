'use strict';

/**
 * S2：确定性修复器。
 *
 * 定位：模型产出的 IR 经常有"低级脏数据"，这些错误 100% 能用代码修，不该浪费一次
 * LLM 重试，更不该让它们流进引擎。
 *
 * 修复边界（严格遵守 P-08：修不了不许猜）：
 *   可修：缺 id / 重复 id / 自环 / 端点不存在的连线 / 多余默认流 / 非网关上的默认流
 *   不修：缺 type、悬挂节点、不可达节点、排他网关没有默认流 —— 这些需要业务判断，
 *         必须报错交回上游，绝不能替用户瞎连一条线。
 */

const { isGateway } = require('./ir');

const TYPE_PREFIX = {
  startEvent: 'StartEvent',
  endEvent: 'EndEvent',
  userTask: 'Task',
  serviceTask: 'ServiceTask',
  scriptTask: 'ScriptTask',
  exclusiveGateway: 'Gateway',
  parallelGateway: 'ParallelGateway',
  inclusiveGateway: 'InclusiveGateway'
};

function nextId(prefix, used) {
  let i = 1;
  let candidate = prefix + '_' + i;
  while (used.has(candidate)) {
    i += 1;
    candidate = prefix + '_' + i;
  }
  used.add(candidate);
  return candidate;
}

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * @param {object} input 原始 IR（可能很脏）
 * @returns {{ir: object, actions: string[]}} 修复后的 IR 与已执行动作清单
 */
function repairIR(input) {
  const actions = [];
  const ir = input && typeof input === 'object' && !Array.isArray(input) ? clone(input) : {};

  if (!Array.isArray(ir.nodes)) {
    ir.nodes = [];
    actions.push('补齐缺失的 nodes 数组');
  }
  if (!Array.isArray(ir.flows)) {
    ir.flows = [];
    actions.push('补齐缺失的 flows 数组');
  }
  if (!ir.id || typeof ir.id !== 'string') {
    ir.id = 'process';
    actions.push('补齐流程 id: process');
  }
  if (!ir.name || typeof ir.name !== 'string') {
    ir.name = ir.id;
    actions.push('补齐流程 name: ' + ir.name);
  }

  // ---- 收集全部已占用的 id（节点 + 连线），避免新旧 id 撞车 ----
  const used = new Set();
  for (const n of ir.nodes) {
    if (n && typeof n.id === 'string' && n.id.trim() !== '') used.add(n.id.trim());
  }
  for (const f of ir.flows) {
    if (f && typeof f.id === 'string' && f.id.trim() !== '') used.add(f.id.trim());
  }

  // ---- 节点：补 id / 重命名重复 id ----
  const seenNodeIds = new Set();
  for (const n of ir.nodes) {
    if (!n || typeof n !== 'object') continue;
    const prefix = TYPE_PREFIX[n.type] || 'Node';
    const raw = typeof n.id === 'string' ? n.id.trim() : '';

    if (raw === '') {
      n.id = nextId(prefix, used);
      actions.push('补齐节点 id: ' + n.id + '（类型 ' + (n.type || '?') + '）');
      seenNodeIds.add(n.id);
    } else if (seenNodeIds.has(raw)) {
      const fresh = nextId(prefix, used);
      actions.push('节点 id 重复，重命名: ' + raw + ' -> ' + fresh);
      n.id = fresh;
      seenNodeIds.add(fresh);
    } else {
      n.id = raw;
      seenNodeIds.add(raw);
    }
  }

  const nodeIds = new Set(ir.nodes.filter((n) => n && n.id).map((n) => n.id));
  const gatewayIds = new Set(
    ir.nodes.filter((n) => n && n.id && isGateway(n.type)).map((n) => n.id)
  );

  // ---- 连线：补 id / 删自环 / 删悬空端点 / 清理非法默认流 ----
  const kept = [];
  const seenFlowIds = new Set();

  for (const f of ir.flows) {
    if (!f || typeof f !== 'object') continue;

    if (!nodeIds.has(f.from) || !nodeIds.has(f.to)) {
      actions.push('移除连线（端点不存在）: ' + (f.id || '(无id)') + '  ' + f.from + ' -> ' + f.to);
      continue;
    }
    if (f.from === f.to) {
      actions.push('移除自环连线: ' + (f.id || '(无id)') + '  @' + f.from);
      continue;
    }

    let id = typeof f.id === 'string' ? f.id.trim() : '';
    if (id === '') {
      id = nextId('Flow', used);
      actions.push('补齐连线 id: ' + id + '（' + f.from + ' -> ' + f.to + '）');
    } else if (seenFlowIds.has(id)) {
      const fresh = nextId('Flow', used);
      actions.push('连线 id 重复，重命名: ' + id + ' -> ' + fresh);
      id = fresh;
    }
    seenFlowIds.add(id);
    f.id = id;

    // 默认流只能挂在网关的出向上
    if (f.default === true && !gatewayIds.has(f.from)) {
      f.default = false;
      actions.push('移除非法默认流（源节点不是网关）: ' + f.id);
    }

    // 默认流不行带条件（Flowable 会拒绝部署）——保留条件、去掉默认标记，
    // 因为条件表达式承载的是明确的业务意图，默认标记只是兜底声明
    if (f.default === true && f.condition) {
      f.default = false;
      actions.push('移除矛盾的默认标记（该连线带条件）: ' + f.id);
    }

    kept.push(f);
  }
  ir.flows = kept;

  // ---- 同一源节点只保留一条默认流（保留最先出现的那条）----
  const defaultOwner = new Map();
  for (const f of ir.flows) {
    if (f.default !== true) continue;
    if (defaultOwner.has(f.from)) {
      f.default = false;
      actions.push('移除多余默认流: ' + f.id + '（' + f.from + ' 已有默认流 ' + defaultOwner.get(f.from) + '）');
    } else {
      defaultOwner.set(f.from, f.id);
    }
  }

  return { ir, actions };
}

module.exports = { repairIR, TYPE_PREFIX };
