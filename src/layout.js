'use strict';

/**
 * 确定性自动布局：把图排成从左到右的分层图，并产出 DI 坐标。
 * 没有 DI 段的 BPMN 引擎能跑，但 bpmn-js 打开是一片空白 —— 演示必翻车。
 */

const SIZES = {
  startEvent: [36, 36],
  endEvent: [36, 36],
  boundaryEvent: [36, 36],
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
 * 找出回边（DFS 中指向当前递归栈上节点的边）。
 * 最长路径分层必须在"去掉回边的 DAG"上做：否则环上会无限松弛，
 * 层深一路涨到保护上限，节点被推到百万像素外（实测踩过）。
 * @returns {Set<string>} "from>to" 形式的回边集合
 */
function findBackEdges(nodes, succs) {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map();
  for (const n of nodes) color.set(n.id, WHITE);
  const back = new Set();

  for (const n of nodes) {
    if (color.get(n.id) !== WHITE) continue;
    const stack = [{ id: n.id, i: 0 }];
    color.set(n.id, GRAY);
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const nexts = succs.get(top.id) || [];
      if (top.i < nexts.length) {
        const to = nexts[top.i++];
        const c = color.get(to);
        if (c === GRAY) {
          back.add(top.id + '>' + to);        // 指回栈上的点 = 回边
        } else if (c === WHITE) {
          color.set(to, GRAY);
          stack.push({ id: to, i: 0 });
        }
      } else {
        color.set(top.id, BLACK);
        stack.pop();
      }
    }
  }
  return back;
}

/**
 * 用最长路径法分层。
 * 先在去掉回边的 DAG 上分层，再让回边的目标沿用原有层级——
 * 这样驳回线既不会破坏分层，也不会把节点甩到画布外。
 * @returns {{pos: Map<string, object>, depth: Map<string, number>, layers: Map<number, string[]>}}
 */
function computeLayout(ir) {
  const allNodes = ir.nodes || [];
  // 边界事件不参与分层：它是压在任务边框上的小圆，位置由挂载对象决定
  const nodes = allNodes.filter((n) => n.type !== 'boundaryEvent');
  const boundaryNodes = allNodes.filter((n) => n.type === 'boundaryEvent');
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

  // 分层用的邻接表：剔除回边（渲染时仍走 computeWaypoints 的回边分支）
  const back = findBackEdges(nodes, succs);
  // 模板里的节点是按流程顺序写的，所以"目标在源之前"就是回边。
  // 光靠 DFS 的"指回栈上"会漏判：目标节点已经出栈时（如 上级审批→提交 的驳回）识别不出来。
  const orderIndex = new Map();
  allNodes.forEach((n, i) => orderIndex.set(n.id, i));
  const isBackEdge = (f) =>
    back.has(f.from + '>' + f.to) ||
    (orderIndex.has(f.from) && orderIndex.has(f.to) && orderIndex.get(f.to) <= orderIndex.get(f.from));

  const dagSuccs = new Map();
  for (const [from, list] of succs) {
    dagSuccs.set(from, list.filter((to) => !isBackEdge({ from: from, to: to })));
  }

  const starts = nodes.filter((n) => n.type === 'startEvent');
  const depth = new Map();

  // 最长路径分层（BFS + 松弛），DAG 上必然收敛
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
    for (const next of dagSuccs.get(id) || []) {
      const nd = d + 1;
      if (!depth.has(next) || depth.get(next) < nd) {
        depth.set(next, nd);
        queue.push(next);
      }
    }
  }

  // 边界事件不占层：跟它的宿主任务同层（它是压在任务边框上的小圆）
  for (const n of (ir.nodes || [])) {
    if (n.type !== 'boundaryEvent' || !n.attachedTo) continue;
    const ownerDepth = depth.get(n.attachedTo);
    if (ownerDepth !== undefined) depth.set(n.id, ownerDepth);
  }

  // 兜底：没被 BFS 走到的节点（典型是"边界事件的下游"，边界事件本身不是流程步骤）
  // 取"前驱最大深度 + 1"，而不是直接给最大值+1——后者会在中间空出一层。
  for (let pass = 0; pass < 6; pass++) {
    let progressed = false;
    for (const n of nodes) {
      if (depth.has(n.id)) continue;
      let best = -1;
      for (const predId of (preds.get(n.id) || [])) {
        const d = depth.get(predId);
        if (d !== undefined && d > best) best = d;
      }
      if (best >= 0) {
        depth.set(n.id, best + 1);
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  let maxDepth = 0;
  for (const v of depth.values()) maxDepth = Math.max(maxDepth, v);
  for (const n of nodes) {
    if (!depth.has(n.id)) depth.set(n.id, maxDepth + 1);
  }

  // 固定点松弛：上面兜底/边界事件补的层可能让后继需要更深的层，
  // 否则会出现"结束事件排在有前驱的节点左边"这种错位（End 深度算成 3、前驱却是 4）。
  let changed = true;
  let iter = 0;
  while (changed && iter++ < 200) {
    changed = false;
    for (const f of flows) {
      if (isBackEdge(f)) continue;
      const fd = depth.get(f.from);
      if (fd === undefined) continue;
      const want = fd + 1;
      if (want > nodes.length + 2) continue;   // 安全阀：DAG 最长路径不会超过节点数
      if ((depth.get(f.to) || 0) < want) {
        depth.set(f.to, want);
        changed = true;
      }
    }
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

  // 边界事件贴在被挂载任务的右下角（BPMN 惯例：圆压在边框上）
  for (const b of boundaryNodes) {
    const owner = pos.get(b.attachedTo);
    if (!owner) continue;
    const { w, h } = sizeOf('boundaryEvent');
    const bx = Math.round(owner.x + owner.w * 0.72 - w / 2);
    const by = Math.round(owner.y + owner.h - h / 2);
    pos.set(b.id, {
      x: bx,
      y: by,
      w,
      h,
      cx: bx + w / 2,
      cy: by + h / 2,
      depth: owner.depth
    });
  }

  // 记录整张图的底部：回边的水平"走廊"要排在所有节点下面
  let bottom = 0;
  for (const item of pos.values()) bottom = Math.max(bottom, item.y + item.h);
  pos.__bottom = bottom;

  return { pos, depth, layers };
}

/** 轴对齐线段是否与矩形相交 */
function hitRect(x1, y1, x2, y2, r) {
  const minX = Math.min(x1, x2);
  const maxX = Math.max(x1, x2);
  const minY = Math.min(y1, y2);
  const maxY = Math.max(y1, y2);
  return minX < r.x + r.w && maxX > r.x && minY < r.y + r.h && maxY > r.y;
}

/** 除两端节点外的所有节点矩形 */
function otherRects(pos, aId, bId) {
  const out = [];
  for (const [id, p] of pos) {
    if (id === aId || id === bId) continue;
    out.push({ id: id, x: p.x, y: p.y, w: p.w, h: p.h });
  }
  return out;
}

function pathClean(wps, rects) {
  for (let i = 1; i < wps.length; i++) {
    const a = wps[i - 1];
    const b = wps[i];
    for (const r of rects) {
      if (hitRect(a.x, a.y, b.x, b.y, r)) return false;
    }
  }
  return true;
}

function dedupe(wps) {
  const out = [];
  for (const p of wps) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 1 && Math.abs(last.y - p.y) < 1) continue;
    out.push({ x: Math.round(p.x), y: Math.round(p.y) });
  }
  return out;
}

/**
 * 计算一条连线在 DI 中的折点。
 *
 * 正向（左->右）：优先"源右中 -> 目标左中"直连；如果这条横线会穿过中间列的节点
 *   （典型：网关直接连到隔层节点，中间那一列还有个"运维总监审批"），
 *   就试若干条候选通道（直连高度 / 阻挡节点的上方或下方），取偏移最小的那条。
 *
 * 回边（目标在源左侧）：走"外侧走廊"——从源右下角拐出到列间空隙，向下走到独立 lane，
 *   再向左到目标正下方，最后从目标【下边】进入。
 *   绝不再从目标"上边"进（那样竖线会直接穿过整个方框）。
 */
function computeWaypoints(flow, pos, laneIndex) {
  const s = pos.get(flow.from);
  const t = pos.get(flow.to);
  if (!s || !t) return [];

  const forward = t.x >= s.x + s.w - 1;

  if (forward) {
    const sx = s.x + s.w;
    const sy = s.cy;
    const tx = t.x;
    const ty = t.cy;
    const rects = otherRects(pos, flow.from, flow.to);

    // 1) 直连（同一高度时就是一条横线）
    const direct = [{ x: sx, y: sy }, { x: tx, y: ty }];
    if (Math.abs(sy - ty) < 1 && pathClean(direct, rects)) return dedupe(direct);

    // 2) 候选通道：自己的高度、以及每个"挡在中间"的节点的上/下方
    const cands = [Math.round(sy)];
    for (const r of rects) {
      if (r.x + r.w < sx - 5 || r.x > tx + 5) continue; // 不在两列之间
      cands.push(Math.round(r.y - 28));
      cands.push(Math.round(r.y + r.h + 28));
    }
    cands.sort((a, b) => Math.abs(a - sy) - Math.abs(b - sy));

    for (const y of cands) {
      if (y < 0) continue;
      const p = [{ x: sx, y: sy }];
      if (Math.abs(y - sy) > 1) {
        p.push({ x: sx + 16, y: sy });
        p.push({ x: sx + 16, y: y });
      }
      p.push({ x: tx - 16, y: y });
      if (Math.abs(y - ty) > 1) p.push({ x: tx - 16, y: ty });
      p.push({ x: tx, y: ty });
      if (pathClean(p, rects)) return dedupe(p);
    }

    // 3) 兜底：原来的折中走法
    const midX = Math.round((sx + tx) / 2);
    return dedupe([
      { x: sx, y: sy },
      { x: midX, y: sy },
      { x: midX, y: ty },
      { x: tx, y: ty }
    ]);
  }

  // ---- 回边：外侧走廊 + 独立 lane ----
  const lane = typeof laneIndex === 'number' ? laneIndex : 0;
  const bottom = pos.__bottom || 0;
  const laneY = Math.round(bottom + 50 + lane * 30);   // 每条回边一条独立水平线
  const gutterX = Math.round(s.x + s.w + 26);          // 源右侧的列间空隙，不压任何框

  const startY = Math.round(s.y + s.h - 10);           // 从源右下角附近离开
  const endY = Math.round(t.y + t.h);                  // 从目标【下边】进入
  return dedupe([
    { x: s.x + s.w, y: startY },
    { x: gutterX, y: startY },
    { x: gutterX, y: laneY },
    { x: t.cx, y: laneY },
    { x: t.cx, y: endY }
  ]);
}

module.exports = { computeLayout, computeWaypoints, sizeOf, SIZES };
