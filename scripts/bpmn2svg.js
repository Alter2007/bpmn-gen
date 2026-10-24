#!/usr/bin/env node
'use strict';
/**
 * 零依赖 BPMN → SVG 渲染器。
 *
 * 直接读取 BPMN 自带的 DI（BPMNShape / BPMNEdge / waypoint）画图，
 * 不需要浏览器、不需要 bpmn-js、不需要任何依赖。
 *
 * 用途：
 *   1) 给文档出配图（README / PDF）
 *   2) 命令行直接产出矢量图，方便贴进设计稿或邮件
 *
 * 用法：
 *   node scripts/bpmn2svg.js <in.bpmn> [out.svg]
 *   node scripts/bpmn2svg.js --batch <目录> <输出目录>
 */
const fs = require('fs');
const path = require('path');

const PALETTE = {
  bg: '#ffffff',
  taskFill: '#ffffff',
  taskStroke: '#1d2129',
  eventStroke: '#1d2129',
  gatewayStroke: '#1d2129',
  flow: '#4e5969',
  label: '#1d2129',
  gatewayText: '#86909c',
  font: 'Microsoft YaHei, Segoe UI, sans-serif'
};

function unesc(s) {
  return String(s == null ? '' : s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 从 process 段取元素类型与名字：<bpmn:userTask id="x" name="y"> */
function readElements(xml) {
  const map = new Map();
  const re = /<bpmn:(userTask|serviceTask|startEvent|endEvent|exclusiveGateway|parallelGateway|inclusiveGateway)\b([^>]*)>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const type = m[1];
    const attrs = m[2];
    const id = (attrs.match(/\bid="([^"]+)"/) || [])[1];
    const name = (attrs.match(/\bname="([^"]+)"/) || [])[1] || '';
    const isDefault = /\bdefault="([^"]+)"/.test(attrs);
    if (id) map.set(id, { type, name, isDefault });
  }
  return map;
}

/** DI 图形：<bpmndi:BPMNShape ... bpmnElement="x"> <dc:Bounds x= y= width= height= /> */
function readShapes(xml) {
  const out = new Map();
  const re = /<bpmndi:BPMNShape\b[^>]*bpmnElement="([^"]+)"[^>]*>[\s\S]*?<dc:Bounds x="([-\d.]+)" y="([-\d.]+)" width="([-\d.]+)" height="([-\d.]+)"/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    out.set(m[1], {
      x: +m[2], y: +m[3], w: +m[4], h: +m[5]
    });
  }
  return out;
}

/** 连线：<bpmndi:BPMNEdge ... bpmnElement="f"> <di:waypoint x= y= /> ... */
function readEdges(xml) {
  const out = [];
  const re = /<bpmndi:BPMNEdge\b[^>]*bpmnElement="([^"]+)"[^>]*>([\s\S]*?)<\/bpmndi:BPMNEdge>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const id = m[1];
    const body = m[2];
    const pts = [];
    const pre = /<di:waypoint x="([-\d.]+)" y="([-\d.]+)"/g;
    let p;
    while ((p = pre.exec(body)) !== null) pts.push({ x: +p[1], y: +p[2] });
    const label = (body.match(/<bpmndi:BPMNLabel>[\s\S]*?<dc:Bounds x="([-\d.]+)" y="([-\d.]+)" width="([-\d.]+)" height="([-\d.]+)"/) || null);
    out.push({
      id,
      pts,
      labelBox: label ? { x: +label[1], y: +label[2], w: +label[3], h: +label[4] } : null
    });
  }
  return out;
}

/** 连线名称在 process 段：<bpmn:sequenceFlow id="f" name="驳回" ...> */
function readFlowNames(xml) {
  const out = new Map();
  const re = /<bpmn:sequenceFlow\b([^>]*)>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1];
    const id = (attrs.match(/\bid="([^"]+)"/) || [])[1];
    const name = (attrs.match(/\bname="([^"]+)"/) || [])[1] || '';
    if (id) out.set(id, name);
  }
  return out;
}

function pathMid(pts) {
  if (pts.length < 2) return pts[0] || { x: 0, y: 0 };
  let total = 0;
  const segs = [];
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    segs.push(d);
    total += d;
  }
  if (total === 0) return pts[0];
  let acc = 0;
  const half = total / 2;
  for (let i = 0; i < segs.length; i++) {
    const d = segs[i];
    if (acc + d >= half) {
      const t = d ? (half - acc) / d : 0;
      return { x: pts[i].x + (pts[i + 1].x - pts[i].x) * t, y: pts[i].y + (pts[i + 1].y - pts[i].y) * t };
    }
    acc += d;
  }
  return pts[pts.length - 1];
}
function arrowHead(pts) {
  if (pts.length < 2) return '';
  const a = pts[pts.length - 2];
  const b = pts[pts.length - 1];
  const ang = Math.atan2(b.y - a.y, b.x - a.x);
  const len = 9;
  const w = 4.5;
  const p1 = { x: b.x - len * Math.cos(ang) + w * Math.sin(ang), y: b.y - len * Math.sin(ang) - w * Math.cos(ang) };
  const p2 = { x: b.x - len * Math.cos(ang) - w * Math.sin(ang), y: b.y - len * Math.sin(ang) + w * Math.cos(ang) };
  return '<polygon points="' + b.x + ',' + b.y + ' ' + p1.x.toFixed(1) + ',' + p1.y.toFixed(1) + ' ' +
    p2.x.toFixed(1) + ',' + p2.y.toFixed(1) + '" fill="' + PALETTE.flow + '"/>';
}

function render(xml, opts) {
  const o = opts || {};
  const elements = readElements(xml);
  const shapes = readShapes(xml);
  const edges = readEdges(xml);
  const flowNames = readFlowNames(xml);

  // 画布范围
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of shapes.values()) {
    minX = Math.min(minX, s.x); minY = Math.min(minY, s.y);
    maxX = Math.max(maxX, s.x + s.w); maxY = Math.max(maxY, s.y + s.h);
  }
  for (const e of edges) for (const p of e.pts) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 400; maxY = 200; }
  const pad = 24;
  const vbX = Math.floor(minX - pad), vbY = Math.floor(minY - pad);
  const vbW = Math.ceil(maxX - minX + pad * 2), vbH = Math.ceil(maxY - minY + pad * 2);

  const parts = [];
  parts.push('<?xml version="1.0" encoding="UTF-8"?>');
  parts.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + vbW + '" height="' + vbH +
    '" viewBox="' + vbX + ' ' + vbY + ' ' + vbW + ' ' + vbH + '" font-family="' + PALETTE.font + '">');
  parts.push('<rect x="' + vbX + '" y="' + vbY + '" width="' + vbW + '" height="' + vbH + '" fill="' + PALETTE.bg + '"/>');

  // 连线先画（在节点下面）
  for (const e of edges) {
    if (e.pts.length < 2) continue;
    const d = e.pts.map((p, i) => (i === 0 ? 'M' : 'L') + p.x + ',' + p.y).join(' ');
    parts.push('<path d="' + d + '" fill="none" stroke="' + PALETTE.flow + '" stroke-width="1.4"/>');
    parts.push(arrowHead(e.pts));
    const nm = flowNames.get(e.id) || '';
    if (nm) {
      const lb = e.labelBox;
      const mid = lb ? null : pathMid(e.pts);
      const tx = lb ? lb.x + lb.w / 2 : mid.x;
      const ty = lb ? lb.y + lb.h / 2 + 4 : mid.y - 8;
      parts.push('<text x="' + tx.toFixed(1) + '" y="' + ty.toFixed(1) +
        '" font-size="11" fill="' + PALETTE.gatewayText + '" text-anchor="middle">' + esc(nm) + '</text>');
    }
  }

  // 节点
  for (const [id, s] of shapes) {
    const el = elements.get(id) || {};
    const cx = s.x + s.w / 2, cy = s.y + s.h / 2;
    if (el.type === 'startEvent' || el.type === 'endEvent') {
      parts.push('<circle cx="' + cx + '" cy="' + cy + '" r="' + (s.w / 2) +
        '" fill="#ffffff" stroke="' + PALETTE.eventStroke + '" stroke-width="' + (el.type === 'endEvent' ? 3.5 : 2) + '"/>');
      if (el.name) {
        parts.push('<text x="' + cx + '" y="' + (s.y + s.h + 14) +
          '" font-size="11" fill="' + PALETTE.gatewayText + '" text-anchor="middle">' + esc(el.name) + '</text>');
      }
    } else if (/Gateway$/.test(el.type || '')) {
      const pts = [[cx, s.y], [s.x + s.w, cy], [cx, s.y + s.h], [s.x, cy]]
        .map((p) => p.join(',')).join(' ');
      parts.push('<polygon points="' + pts + '" fill="#ffffff" stroke="' + PALETTE.gatewayStroke + '" stroke-width="1.6"/>');
      if (el.type === 'parallelGateway') {
        parts.push('<path d="M' + (cx - 7) + ',' + cy + ' L' + (cx + 7) + ',' + cy +
          ' M' + cx + ',' + (cy - 7) + ' L' + cx + ',' + (cy + 7) + '" stroke="' + PALETTE.gatewayStroke + '" stroke-width="2.2"/>');
      } else {
        parts.push('<path d="M' + (cx - 7) + ',' + cy + ' L' + (cx + 7) + ',' + cy +
          ' M' + cx + ',' + (cy - 7) + ' L' + cx + ',' + (cy + 7) + '" stroke="' + PALETTE.gatewayStroke + '" stroke-width="2.2"/>');
      }
      if (el.name) {
        parts.push('<text x="' + cx + '" y="' + (s.y + s.h + 14) +
          '" font-size="11" fill="' + PALETTE.gatewayText + '" text-anchor="middle">' + esc(el.name) + '</text>');
      }
    } else {
      parts.push('<rect x="' + s.x + '" y="' + s.y + '" width="' + s.w + '" height="' + s.h +
        '" rx="8" fill="' + PALETTE.taskFill + '" stroke="' + PALETTE.taskStroke + '" stroke-width="1.4"/>');
      if (el.name) {
        parts.push('<text x="' + cx + '" y="' + (cy + 4) +
          '" font-size="12" fill="' + PALETTE.label + '" text-anchor="middle">' + esc(el.name) + '</text>');
      }
    }
  }

  parts.push('</svg>');
  return parts.join('\n');
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    console.log('用法: node scripts/bpmn2svg.js <in.bpmn> [out.svg]');
    console.log('      node scripts/bpmn2svg.js --batch <输入目录> <输出目录>');
    process.exit(2);
  }

  if (argv[0] === '--batch') {
    const dir = argv[1];
    const outDir = argv[2] || dir;
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const files = fs.readdirSync(dir).filter((f) => /\.bpmn$/i.test(f));
    let n = 0;
    for (const f of files) {
      const xml = fs.readFileSync(path.join(dir, f), 'utf8');
      const svg = render(xml);
      const out = path.join(outDir, f.replace(/\.bpmn$/i, '.svg'));
      fs.writeFileSync(out, svg, 'utf8');
      n++;
    }
    console.log('已渲染 ' + n + ' 个 SVG -> ' + outDir);
    return;
  }

  const inFile = argv[0];
  const outFile = argv[1] || inFile.replace(/\.bpmn$/i, '.svg');
  if (!fs.existsSync(inFile)) { console.log('[ERR] 文件不存在: ' + inFile); process.exit(2); }
  const svg = render(fs.readFileSync(inFile, 'utf8'));
  const outDir = path.dirname(outFile);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outFile, svg, 'utf8');
  console.log('已输出: ' + outFile + '  (' + svg.length + ' 字符)');
}

if (require.main === module) main();
module.exports = { render };
