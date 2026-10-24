'use strict';

/**
 * L3 图论语义校验：不依赖任何引擎，纯静态分析。
 * 这些错误一旦进了引擎，通常表现为"实例卡死"或"部署失败"，代价很高。
 */

const { isGateway } = require('./ir');

function buildIndex(ir) {
  const nodes = ir.nodes || [];
  const flows = ir.flows || [];
  const byId = new Map();
  const out = new Map();
  const inn = new Map();

  for (const n of nodes) {
    byId.set(n.id, n);
    out.set(n.id, []);
    inn.set(n.id, []);
  }
  for (const f of flows) {
    if (out.has(f.from)) out.get(f.from).push(f);
    if (inn.has(f.to)) inn.get(f.to).push(f);
  }
  return { byId, out, inn };
}

function reachableFrom(startId, adjacency) {
  const seen = new Set();
  const queue = [startId];
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const next of adjacency.get(id) || []) queue.push(next);
  }
  return seen;
}

/**
 * @returns {{errors: string[], warnings: string[]}}
 */
function analyze(ir) {
  const errors = [];
  const warnings = [];

  const nodes = ir.nodes || [];
  const flows = ir.flows || [];
  const { byId, out, inn } = buildIndex(ir);

  // 邻接表（只放 id，便于可达性计算）
  const succIds = new Map();
  const predIds = new Map();
  for (const n of nodes) {
    succIds.set(n.id, []);
    predIds.set(n.id, []);
  }
  for (const f of flows) {
    if (succIds.has(f.from)) succIds.get(f.from).push(f.to);
    if (predIds.has(f.to)) predIds.get(f.to).push(f.from);
  }

  // ---- 起止事件 ----
  const starts = nodes.filter((n) => n.type === 'startEvent');
  const ends = nodes.filter((n) => n.type === 'endEvent');

  if (starts.length !== 1) {
    errors.push(`必须且只能有 1 个开始事件，当前 ${starts.length} 个`);
  }
  if (ends.length < 1) {
    errors.push('至少需要 1 个结束事件');
  }

  // ---- 连线完整性 ----
  for (const n of nodes) {
    const outs = out.get(n.id) || [];
    const ins = inn.get(n.id) || [];
    const label = `${n.id}(${n.name || n.type})`;

    if (n.type === 'startEvent' && ins.length > 0) {
      errors.push(`开始事件 ${label} 不应有入向连线`);
    }
    if (n.type === 'endEvent' && outs.length > 0) {
      errors.push(`结束事件 ${label} 不应有出向连线`);
    }
    if (n.type !== 'endEvent' && outs.length === 0) {
      errors.push(`节点 ${label} 没有出向连线（悬挂节点）`);
    }
    if (n.type !== 'startEvent' && ins.length === 0) {
      errors.push(`节点 ${label} 没有入向连线（不可达）`);
    }

    // 同一个节点对之间重复连线，通常是模型幻觉
    const seenTargets = new Set();
    for (const f of outs) {
      if (seenTargets.has(f.to)) {
        warnings.push(`节点 ${n.id} 到 ${f.to} 存在多条连线，请确认是否有意为之`);
      }
      seenTargets.add(f.to);
    }
  }

  // ---- 网关规则 ----
  for (const n of nodes) {
    if (!isGateway(n.type)) continue;
    const outs = out.get(n.id) || [];
    if (outs.length <= 1) continue;

    if (n.type === 'exclusiveGateway') {
      const defaults = outs.filter((f) => f.default === true);
      if (defaults.length === 0) {
        errors.push(
          `排他网关 ${n.id}(${n.name || ''}) 有多条出向但没有默认流（default），条件全不满足时实例会卡死`
        );
      }
      const conditionCount = outs.filter((f) => f.condition).length;
      if (conditionCount === 0) {
        warnings.push(`排他网关 ${n.id} 的出向都没有条件表达式，实际会永远走默认流`);
      }
    }

    if (n.type === 'parallelGateway') {
      const withCondition = outs.filter((f) => f.condition);
      if (withCondition.length > 0) {
        errors.push(`并行网关 ${n.id} 的出向不应带条件表达式（并行网关是"全走"语义）`);
      }
    }

    if (n.type === 'inclusiveGateway') {
      const defaults = outs.filter((f) => f.default === true);
      if (defaults.length === 0) {
        warnings.push(`包容网关 ${n.id} 没有默认流，条件全不满足时可能卡死`);
      }
    }
  }

  // ---- 默认流不得带条件 ----
  // 这条规则是 Flowable 部署时抛的：
  //   "Default sequenceflow has a condition, which is not allowed"
  // 语义上默认流是"条件都不满足时的兜底"，所以它自己不能有判断条件。
  for (const f of flows) {
    if (f.default === true && f.condition) {
      errors.push(
        `连线 ${f.id} 同时是默认流又带条件表达式（${f.condition}），Flowable 会拒绝部署：默认流必须是兜底路径，不能带条件`
      );
    }
  }

  // ---- 可达性 ----
  if (starts.length === 1) {
    const reachable = reachableFrom(starts[0].id, succIds);
    for (const n of nodes) {
      if (!reachable.has(n.id)) {
        errors.push(`节点 ${n.id}(${n.name || n.type}) 从开始事件不可达`);
      }
    }
  }

  // ---- 能否到达结束 ----
  if (ends.length > 0) {
    const canReachEnd = new Set();
    const queue = ends.map((e) => e.id);
    while (queue.length) {
      const id = queue.shift();
      if (canReachEnd.has(id)) continue;
      canReachEnd.add(id);
      for (const prev of predIds.get(id) || []) queue.push(prev);
    }
    for (const n of nodes) {
      if (!canReachEnd.has(n.id)) {
        errors.push(`节点 ${n.id}(${n.name || n.type}) 无法到达任何结束事件（可能死循环或卡住）`);
      }
    }
  }

  // ---- 未使用变量 / 未声明变量（软提示） ----
  const declared = new Set((ir.variables || []).map((v) => v && v.name).filter(Boolean));
  const used = new Set();
  for (const f of flows) {
    if (!f.condition) continue;
    const re = /\$\{([^}]*)\}/g;
    let m;
    while ((m = re.exec(f.condition)) !== null) {
      const body = m[1];
      const ids = body.match(/[A-Za-z_][A-Za-z0-9_]*/g) || [];
      for (const id of ids) used.add(id);
    }
  }
  for (const v of declared) {
    if (!used.has(v)) warnings.push(`变量 ${v} 已声明但条件表达式中未使用`);
  }

  return { errors, warnings };
}

module.exports = { analyze, buildIndex };
