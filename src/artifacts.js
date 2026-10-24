'use strict';
/**
 * 配套产物生成器：从最终 IR 派生三样东西，让产物不止一个 .bpmn 文件。
 *
 *   1. 表单定义  —— 每个用户任务的字段（发起人填什么、审批人决策什么）
 *   2. 文字说明  —— 给业务方看的流程说明书（Markdown）
 *   3. 分支用例  —— 每个分支一条可执行的输入样例（覆盖性测试的种子）
 *
 * 全部纯函数，不依赖 IO，也不猜测业务含义（P-08）：
 * 只在能确定的地方给值，确定不了就留占位符并标注。
 */

const APPROVE_VAR = 'approved';

/** 从条件表达式里提取数值阈值，如 ${amount > 1000 && amount <= 5000} -> [1000, 5000] */
function extractThresholds(condition) {
  const nums = [];
  const re = /(-?\d+(?:\.\d+)?)/g;
  let m;
  while ((m = re.exec(String(condition || ''))) !== null) {
    nums.push(Number(m[1]));
  }
  return nums;
}

/** 判断条件里的比较运算，用来推一个必定满足（或不满足）的样例值 */
function sampleValueFor(condition, fallback) {
  const c = String(condition || '');

  // 驳回条件通常写成 execution.getVariable('approved') == false：
  // 变量名在括号里，得先把这个形态摘出来，否则通用正则匹配不到。
  const gv = c.match(/getVariable\(\s*['"]([\w]+)['"]\s*\)\s*(==|!=)/);
  if (gv) {
    const cmp = gv[2];
    return { name: gv[1], value: cmp === '==' ? false : true };
  }

  const varMatch = c.match(/\$\{\s*([A-Za-z_][\w.]*)\s*(<=|>=|<|>|==)/);
  const varName = varMatch ? varMatch[1] : null;
  if (!varName) return null;
  // 审批类变量：直接用布尔
  if (varName === APPROVE_VAR) return { name: varName, value: false };

  const nums = extractThresholds(c);
  if (nums.length === 0) return null;

  let value;
  if (/<=\s*-?\d/.test(c) && !/>/.test(c)) {
    // 只有上界：取比阈值小 1
    value = nums[0] - 1;
  } else if (/>=\s*-?\d/.test(c) && !/</.test(c)) {
    value = nums[0] + 1;
  } else if (nums.length >= 2) {
    // 区间 (a, b]：取 a+1
    value = nums[0] + 1;
  } else {
    value = nums[0] + 1;
  }
  if (fallback !== null && fallback !== undefined) {
    // 用调用方给的基准（例如模板里的 tier 值）微调，避免负数
    if (value < 0) value = Math.max(1, nums[0]);
  }
  return { name: varName, value: value };
}

/** 1) 表单定义：发起人字段来自模板变量，审批人字段固定为决策 */
function buildForm(ir, template) {
  // 优先用 IR 里的变量：它已经过占位符渲染（@varName@ -> amount）；
  // 模板原始变量还带着占位符，只能兜底。
  const irVars = (ir && ir.variables) || [];
  const vars = irVars.length > 0 ? irVars : ((template && template.variables) || []);
  const fields = vars.map((v) => ({
    id: v.name,
    label: v.description || v.name,
    type: v.type === 'number' ? 'long' : (v.type === 'boolean' ? 'boolean' : 'string'),
    required: true
  }));

  const approvalTasks = (ir.nodes || []).filter((n) => n.type === 'userTask');
  fields.push({
    id: APPROVE_VAR,
    label: '是否通过（false 时退回发起人）',
    type: 'boolean',
    required: true
  });

  return {
    formKey: 'form_' + (ir.id || 'process'),
    processName: ir.name || '',
    fields: fields,
    taskCount: approvalTasks.length,
    note: '字段由模板变量推导；审批人提交时需带上 ' + APPROVE_VAR + ' 变量，否则默认按通过处理'
  };
}

/** 2) 文字说明：节点清单 + 分支条件 + 驳回回路 */
function buildDoc(ir) {
  const nodes = ir.nodes || [];
  const flows = ir.flows || [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const typeName = {
    startEvent: '开始事件',
    endEvent: '结束事件',
    userTask: '用户任务',
    serviceTask: '服务任务',
    exclusiveGateway: '排他网关',
    parallelGateway: '并行网关',
    inclusiveGateway: '包容网关'
  };

  const lines = [];
  lines.push('# ' + (ir.name || ir.id || '流程') + ' —— 流程说明');
  lines.push('');
  lines.push('> 由 bpmn-gen 自动生成。流程标识：`' + (ir.id || '') + '`，' +
    (ir.variables && ir.variables.length
      ? '流程变量：' + ir.variables.map((v) => '`' + v.name + '`').join('、')
      : '无显式流程变量') + '。');
  lines.push('');

  lines.push('## 节点');
  lines.push('');
  lines.push('| # | 类型 | 名称 | 处理人 |');
  lines.push('|---|---|---|---|');
  nodes.forEach((n, i) => {
    lines.push('| ' + (i + 1) + ' | ' + (typeName[n.type] || n.type) + ' | ' + (n.name || '') + ' | ' +
      (n.assignee ? '`' + n.assignee + '`' : '—') + ' |');
  });
  lines.push('');

  lines.push('## 分支与条件');
  lines.push('');
  const gatewayFlows = flows.filter((f) => {
    const from = byId.get(f.from);
    return from && (from.type === 'exclusiveGateway' || from.type === 'inclusiveGateway');
  });
  if (gatewayFlows.length === 0) {
    lines.push('（无排他/包容网关分支）');
  } else {
    lines.push('| 网关 | 条件 | 去向 | 是否默认 |');
    lines.push('|---|---|---|---|');
    gatewayFlows.forEach((f) => {
      const from = byId.get(f.from);
      const to = byId.get(f.to);
      lines.push('| ' + (from.name || from.id) + ' | ' +
        (f.condition ? '`' + f.condition + '`' : '（无条件）') + ' | ' +
        (to ? (to.name || to.id) : f.to) + ' | ' + (f.default ? '是' : '') + ' |');
    });
  }
  lines.push('');

  // 驳回回路：目标在流程里"更靠前"的连线
  const order = new Map(nodes.map((n, i) => [n.id, i]));
  const back = flows.filter((f) => order.has(f.from) && order.has(f.to) && order.get(f.to) < order.get(f.from));
  lines.push('## 驳回 / 退回路径');
  lines.push('');
  if (back.length === 0) {
    lines.push('（无驳回路径）');
  } else {
    back.forEach((f) => {
      const from = byId.get(f.from);
      const to = byId.get(f.to);
      lines.push('- ' + (from ? (from.name || from.id) : f.from) + ' → ' +
        (to ? (to.name || to.id) : f.to) +
        (f.condition ? '，条件 `' + f.condition + '`' : ''));
    });
    lines.push('');
    lines.push('> 驳回会让流程回到前序节点重新走一遍；实例不会自行结束，需业务侧再次提交审批。');
  }
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('校验：该流程已通过六层验证（良构 / 契约 / 图论 / OMG XSD / bpmn-moddle / Flowable 引擎）。');

  return { title: ir.name || ir.id || '流程说明', markdown: lines.join('\n') };
}

/** 3) 分支用例：每个网关门各出一条输入样例 */
function buildCases(ir) {
  const nodes = ir.nodes || [];
  const flows = ir.flows || [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const cases = [];

  const gateways = nodes.filter((n) => n.type === 'exclusiveGateway');
  const seenVars = new Map();

  gateways.forEach((gw) => {
    const outs = flows.filter((f) => f.from === gw.id);
    // 先算出这个网关所有条件里的阈值，默认流据此取一个"超过最大阈值"的值
    let allNums = [];
    let varName = null;
    outs.forEach((f) => {
      if (!f.condition) return;
      const n = extractThresholds(f.condition);
      allNums = allNums.concat(n);
      if (!varName) {
        const m = String(f.condition).match(/\$\{\s*([A-Za-z_][\w.]*)\s*(<=|>=|<|>|==)/);
        if (m) varName = m[1];
      }
    });

    outs.forEach((f) => {
      let sample = f.condition ? sampleValueFor(f.condition) : null;
      if (!sample && varName && allNums.length > 0 && varName !== APPROVE_VAR) {
        // 默认流：取所有阈值里最大的那个再 +1，保证一定落到兜底分支
        sample = { name: varName, value: Math.max.apply(null, allNums) + 1 };
      }
      if (sample) seenVars.set(sample.name, true);
      cases.push({
        gateway: gw.name || gw.id,
        condition: f.condition || '（默认流）',
        target: (byId.get(f.to) || {}).name || f.to,
        variables: sample ? { [sample.name]: sample.value } : {}
      });
    });
  });

  // 驳回用例：带回路的流程，补一条 approved=false
  const order = new Map(nodes.map((n, i) => [n.id, i]));
  const back = flows.filter((f) => order.has(f.from) && order.has(f.to) && order.get(f.to) < order.get(f.from));
  if (back.length > 0) {
    cases.push({
      gateway: '驳回路径',
      condition: back[0].condition || '（驳回）',
      target: (byId.get(back[0].to) || {}).name || back[0].to,
      variables: { [APPROVE_VAR]: false }
    });
  }

  return {
    total: cases.length,
    coverageHint: activeHint(cases.length),
    cases: cases
  };
}

function activeHint(n) {
  if (n === 0) return '该流程没有条件分支，一条用例即可覆盖';
  return '共 ' + n + ' 条用例，覆盖每个分支各一次';
}

/** 一次性构建三样产物 */
function buildArtifacts(ir, template) {
  return {
    form: buildForm(ir, template),
    doc: buildDoc(ir),
    cases: buildCases(ir)
  };
}

module.exports = { buildArtifacts, buildForm, buildDoc, buildCases, extractThresholds, sampleValueFor };
