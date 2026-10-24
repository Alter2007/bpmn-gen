'use strict';

/**
 * 确定性自动布局：把图排成从左到右的分层图，并产出 DI 坐标。
 * 没有 DI 段的 BPMN 引擎能跑，但 bpmn-js 打开是一片空白 —— 演示必翻车。
 */

const SIZES = {
  startEvent: [36, 36],
  endEvent: [36, 36],
  userTask: [100, 80],
  serviceTask: [100, 80],
  scriptTask: [100, 80],
  exclusiveGateway: [50, 50],
  parallelGateway: [50, 50],
  inclusiveGateway: [50, 50]
};

const GAP_X = 220;
const GAP_Y = 140;
const PAD_X = 160;
const PAD_Y = 100;

function sizeOf(type) {
  const s = SIZES[type];
  return s ? { w: s[0], h: s[1] } : { w: 100, h: 80 };
}

/**
 * 用最长路径法分层（对环形图做迭代上限保护）。
 * @returns {{pos: Map<string, object>, depth: Map<string, number>, layers: Map<number, string[]>}}
 */
function computeLayout(ir) {
  const nodes = ir.nodes || [];
  const flows = ir.flows || [];

  const succs = new Map();
  const preds = new Map();
  for (const n of nodes) {
    succs.set(n.id, []);
    preds.set(n.id, []);
  }
  for (const f of flows) {
    if (succs.has(f.from)) succs.get(f.from).push(f.to);
    if (preds.has(f.to)) preds.get(f.to).push(f.from);
  }

  const starts = nodes.filter((n) => n.type === 'startEvent');
  const depth = new Map();

  // 最长路径分层（BFS + 松弛），对环做上限保护
  const queue = [];
  for (const s of starts) {
    depth.set(s.id, 0);
    queue.push(s.id);
  }
  if (queue.length === 0 && nodes.length > 0) {
    depth.set(nodes[0].id, 0);
    queue.push(nodes[0].id);
  }

  let guard = 0;
  while (queue.length > 0 && guard < 20000) {
    guard++;
    const id = queue.shift();
    const d = depth.get(id) || 0;
    for (const next of succs.get(id) || []) {
      const nd = d + 1;
      if (!depth.has(next) || depth.get(next) < nd) {
        depth.set(next, nd);
        queue.push(next);
      }
    }
  }

  let maxDepth = 0;
  for (const v of depth.values()) maxDepth = Math.max(maxDepth, v);
  for (const n of nodes) {
    if (!depth.has(n.id)) depth.set(n.id, maxDepth + 1);
  }

  // 分层
  const layers = new Map();
  for (const n of nodes) {
    const d = depth.get(n.id);
    if (!layers.has(d)) layers.set(d, []);
    layers.get(d).push(n);
  }

  // 计算每层最大高度，用于垂直居中
  const pos = new Map();
  const orderedDepths = [...layers.keys()].sort((a, b) => a - b);
  const layerHeights = new Map();
  let tallest = 0;
  for (const d of orderedDepths) {
    const arr = layers.get(d);
    let h = 0;
    arr.forEach((n, i) => {
      const { h: nh } = sizeOf(n.type);
      h = i * GAP_Y + nh;
    });
    layerHeights.set(d, h);
    tallest = Math.max(tallest, h);
  }

  for (const d of orderedDepths) {
    const arr = layers.get(d);
    const ownHeight = layerHeights.get(d);
    const yOffset = PAD_Y + Math.max(0, (tallest - ownHeight) / 2);
    arr.forEach((n, i) => {
      const { w, h } = sizeOf(n.type);
      const x = PAD_X + d * GAP_X;
      const y = Math.round(yOffset + i * GAP_Y);
      pos.set(n.id, {
        x,
        y,
        w,
        h,
        cx: x + w / 2,
        cy: y + h / 2,
        depth: d
      });
    });
  }

  return { pos, depth, layers };
}

/**
 * 计算一条连线在 DI 中的折点。
 * 正向（左->右）：源右中 -> 目标左中。
 * 回边（目标在源左侧）：源下中 -> 目标上中，绕行避免穿透节点。
 */
function computeWaypoints(flow, pos) {
  const s = pos.get(flow.from);
  const t = pos.get(flow.to);
  if (!s || !t) return [];

  const forward = t.x >= s.x + s.w - 1;

  if (forward) {
    const sx = s.x + s.w;
    const sy = s.cy;
    const tx = t.x;
    const ty = t.cy;
    if (Math.abs(sy - ty) < 1) {
      return [{ x: Math.round(sx), y: Math.round(sy) }, { x: Math.round(tx), y: Math.round(ty) }];
    }
    const midX = Math.round((sx + tx) / 2);
    return [
      { x: Math.round(sx), y: Math.round(sy) },
      { x: midX, y: Math.round(sy) },
      { x: midX, y: Math.round(ty) },
      { x: Math.round(tx), y: Math.round(ty) }
    ];
  }

  // 回边
  const sx = s.cx;
  const sy = s.y + s.h;
  const tx = t.cx;
  const ty = t.y;
  const midY = Math.round(Math.max(sy, ty) + 60);
  return [
    { x: Math.round(sx), y: Math.round(sy) },
    { x: Math.round(sx), y: midY },
    { x: Math.round(tx), y: midY },
    { x: Math.round(tx), y: Math.round(ty) }
  ];
}

module.exports = { computeLayout, computeWaypoints, sizeOf, SIZES };
