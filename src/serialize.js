'use strict';

/**
 * 确定性序列化器：IR -> BPMN 2.0 XML（Flowable 方言）。
 * 关键点：
 *  1. 命名空间、id、incoming/outgoing 全部由代码保证，模型碰不到；
 *  2. 同时产出 DI（BPMNDiagram），否则 bpmn-js 打开是白屏；
 *  3. 排他网关的 default 属性自动指向标了 default:true 的连线。
 */

const { computeLayout, computeWaypoints } = require('./layout');
const { isGateway } = require('./ir');

function sanitizeId(raw, fallback) {
  let s = String(raw == null ? '' : raw).trim();
  s = s.replace(/[^A-Za-z0-9_.-]/g, '_');
  if (!/^[A-Za-z_]/.test(s)) s = '_' + s;
  return s || fallback;
}

function escText(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escAttr(s) {
  return escText(s).replace(/"/g, '&quot;');
}

function cdata(s) {
  return '<![CDATA[' + String(s).replace(/\]\]>/g, ']]]]><![CDATA[>') + ']]>';
}

function buildIdMap(ir) {
  const map = new Map();
  const used = new Set();
  const all = [];
  for (const n of ir.nodes || []) all.push(n.id);
  for (const f of ir.flows || []) all.push(f.id);

  for (const raw of all) {
    if (map.has(raw)) continue;
    const base = sanitizeId(raw, 'id');
    let candidate = base;
    let i = 2;
    while (used.has(candidate)) {
      candidate = base + '_' + i;
      i++;
    }
    used.add(candidate);
    map.set(raw, candidate);
  }
  return map;
}

/**
 * @param {object} ir 已通过校验的 IR
 * @param {object} [opts]
 * @returns {string} BPMN 2.0 XML
 */
function serialize(ir, opts) {
  const options = opts || {};
  const idMap = buildIdMap(ir);
  const { pos } = computeLayout(ir);
  const nodes = ir.nodes || [];
  const flows = ir.flows || [];

  const processId = 'Process_' + sanitizeId(ir.processKey || ir.id, 'Process');
  const processName = ir.name || ir.id || 'Process';
  const exporter = options.exporter || 'bpmn-gen';
  const exporterVersion = options.exporterVersion || '0.1.0';

  // 建入向/出向索引（用原始 id，输出时再映射）
  const incoming = new Map();
  const outgoing = new Map();
  const defaultFlowBySource = new Map();
  for (const n of nodes) {
    incoming.set(n.id, []);
    outgoing.set(n.id, []);
  }
  for (const f of flows) {
    if (outgoing.has(f.from)) outgoing.get(f.from).push(f.id);
    if (incoming.has(f.to)) incoming.get(f.to).push(f.id);
    if (f.default === true) defaultFlowBySource.set(f.from, f.id);
  }

  const out = [];

  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push(
    '<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"' +
      ' xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"' +
      ' xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"' +
      ' xmlns:di="http://www.omg.org/spec/DD/20100524/DI"' +
      ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"' +
      ' xmlns:flowable="http://flowable.org/bpmn"' +
      ' id="Definitions_1"' +
      ' targetNamespace="http://bpmn.io/schema/bpmn"' +
      ' exporter="' + escAttr(exporter) + '"' +
      ' exporterVersion="' + escAttr(exporterVersion) + '">'
  );

  out.push('  <bpmn:process id="' + escAttr(processId) + '" name="' + escAttr(processName) + '" isExecutable="true">');

  // ---- 流程元素 ----
  for (const n of nodes) {
    const id = idMap.get(n.id);
    const attrs = ['id="' + escAttr(id) + '"'];
    if (n.name) attrs.push('name="' + escAttr(n.name) + '"');

    if (n.type === 'userTask') {
      if (n.assignee) attrs.push('flowable:assignee="' + escAttr(n.assignee) + '"');
      if (n.candidateGroups) attrs.push('flowable:candidateGroups="' + escAttr(n.candidateGroups) + '"');
      if (n.formKey) attrs.push('flowable:formKey="' + escAttr(n.formKey) + '"');
    }
    if (n.type === 'serviceTask') {
      if (n.expression) attrs.push('flowable:expression="' + escAttr(n.expression) + '"');
      if (n.delegateExpression) attrs.push('flowable:delegateExpression="' + escAttr(n.delegateExpression) + '"');
    }
    if (isGateway(n.type) && defaultFlowBySource.has(n.id)) {
      attrs.push('default="' + escAttr(idMap.get(defaultFlowBySource.get(n.id))) + '"');
    }

    const tag = 'bpmn:' + n.type;
    const kids = [];
    for (const fid of incoming.get(n.id) || []) {
      kids.push('      <bpmn:incoming>' + escText(idMap.get(fid)) + '</bpmn:incoming>');
    }
    for (const fid of outgoing.get(n.id) || []) {
      kids.push('      <bpmn:outgoing>' + escText(idMap.get(fid)) + '</bpmn:outgoing>');
    }

    if (kids.length === 0) {
      out.push('    <' + tag + ' ' + attrs.join(' ') + ' />');
    } else {
      out.push('    <' + tag + ' ' + attrs.join(' ') + '>');
      for (const k of kids) out.push(k);
      out.push('    </' + tag + '>');
    }
  }

  // ---- 连线 ----
  for (const f of flows) {
    const attrs = [
      'id="' + escAttr(idMap.get(f.id)) + '"'
    ];
    if (f.name) attrs.push('name="' + escAttr(f.name) + '"');
    attrs.push('sourceRef="' + escAttr(idMap.get(f.from)) + '"');
    attrs.push('targetRef="' + escAttr(idMap.get(f.to)) + '"');

    if (f.condition) {
      out.push('    <bpmn:sequenceFlow ' + attrs.join(' ') + '>');
      out.push('      <bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">' + cdata(f.condition) + '</bpmn:conditionExpression>');
      out.push('    </bpmn:sequenceFlow>');
    } else {
      out.push('    <bpmn:sequenceFlow ' + attrs.join(' ') + ' />');
    }
  }

  out.push('  </bpmn:process>');

  // ---- DI（图形坐标）----
  out.push('  <bpmndi:BPMNDiagram id="BPMNDiagram_1">');
  out.push('    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="' + escAttr(processId) + '">');

  for (const n of nodes) {
    const p = pos.get(n.id);
    if (!p) continue;
    out.push(
      '      <bpmndi:BPMNShape id="' + escAttr(idMap.get(n.id) + '_di') + '" bpmnElement="' + escAttr(idMap.get(n.id)) + '">'
    );
    out.push('        <dc:Bounds x="' + p.x + '" y="' + p.y + '" width="' + p.w + '" height="' + p.h + '" />');
    out.push('      </bpmndi:BPMNShape>');
  }

  for (const f of flows) {
    const wps = computeWaypoints(f, pos);
    if (wps.length === 0) continue;
    out.push(
      '      <bpmndi:BPMNEdge id="' + escAttr(idMap.get(f.id) + '_di') + '" bpmnElement="' + escAttr(idMap.get(f.id)) + '">'
    );
    for (const wp of wps) {
      out.push('        <di:waypoint x="' + wp.x + '" y="' + wp.y + '" />');
    }
    out.push('      </bpmndi:BPMNEdge>');
  }

  out.push('    </bpmndi:BPMNPlane>');
  out.push('  </bpmndi:BPMNDiagram>');
  out.push('</bpmn:definitions>');

  return out.join('\n') + '\n';
}

module.exports = { serialize, sanitizeId, escText, escAttr };
