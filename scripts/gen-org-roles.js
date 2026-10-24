#!/usr/bin/env node
'use strict';
/**
 * 生成 src/org-roles.json：角色组映射表。
 *
 * 为什么需要它：生成物里的审批人用 flowable:candidateGroups="role_xxx"（字面量组名）表达，
 * 引擎里必须真的存在这些组、并且组里有人，任务才会出现在对应人的待办里。
 * 这张表就是"业务角色 → 引擎组"的交接契约。
 *
 * 用法：
 *   node scripts/gen-org-roles.js          重新生成（模板改了角色就重跑）
 *   node scripts/gen-org-roles.js --check  只校验：模板里用到的组是否都在表里
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TPL_DIR = path.join(ROOT, 'src', 'templates');
const OUT = path.join(ROOT, 'src', 'org-roles.json');

const LABELS = {
  initiator: '发起人',
  manager: '直属主管',
  director: '总监',
  finance: '财务',
  financeDirector: '财务总监',
  hr: '人事',
  legal: '法务',
  it: 'IT 运维',
  admin: '行政',
  leader: '主要领导',
  gm: '总经理',
  security: '安全保密',
  opsDirector: '运维总监',
  sealKeeper: '印章管理员',
  deptManager: '部门经理',
  purchaseManager: '采购经理',
  business: '业务部门',
  approver: '会签成员',
  reviewer: '回访确认人',
  dispatcher: '投诉分办人',
  handler: '承办部门',
  accountant: '会计',
  cosign: '会签方',
  qualify: '资质审核',
  purchase: '采购员',
  fleet: '车队调度'
};

const SUGGEST = {
  manager: 'dept_manager',
  director: 'director',
  finance: 'finance',
  financeDirector: 'finance_director',
  hr: 'hr',
  legal: 'legal',
  it: 'it_ops',
  admin: 'admin',
  leader: 'top_leader',
  gm: 'gm',
  security: 'security',
  opsDirector: 'ops_director',
  sealKeeper: 'seal_keeper',
  deptManager: 'dept_manager',
  purchaseManager: 'purchase_manager',
  business: 'business_dept',
  approver: 'cosign_members',
  reviewer: 'reviewer',
  dispatcher: 'dispatcher',
  handler: 'handler',
  accountant: 'accountant',
  cosign: 'cosign',
  qualify: 'qualify',
  purchase: 'purchase',
  fleet: 'fleet'
};

/** 从所有模板里收集角色：candidateGroups 的组名 + assignee 变量名 */
function collectRoles() {
  const groups = new Map();   // role key -> 出现次数
  const assigneeVars = new Map();
  for (const f of fs.readdirSync(TPL_DIR).filter((x) => x.endsWith('.json'))) {
    const t = JSON.parse(fs.readFileSync(path.join(TPL_DIR, f), 'utf8'));
    for (const n of t.nodes || []) {
      if (n.type !== 'userTask' && n.type !== 'serviceTask') continue;
      if (n.candidateGroups) {
        for (const g of String(n.candidateGroups).split(',')) {
          const key = g.trim().replace(/^role_/, '');
          if (!key) continue;
          groups.set(key, (groups.get(key) || 0) + 1);
        }
      }
      const m = n.assignee && /^\$\{(\w+)\}$/.exec(n.assignee);
      if (m) assigneeVars.set(m[1], (assigneeVars.get(m[1]) || 0) + 1);
    }
  }
  return { groups: groups, assigneeVars: assigneeVars };
}

function buildDoc(data) {
  const keys = new Set([...data.groups.keys(), ...data.assigneeVars.keys()]);
  const roles = [...keys].sort().map((k) => {
    const isVariable = data.assigneeVars.has(k) && !data.groups.has(k);
    return {
      group: 'role_' + k,
      label: LABELS[k] || k,
      kind: isVariable ? 'variable' : 'candidateGroup',
      suggestedGroupId: isVariable ? '' : (SUGGEST[k] || k),
      usedByTemplates: data.groups.get(k) || data.assigneeVars.get(k) || 0,
      description: isVariable
        ? '发起人，由引擎在启动流程实例时指定（通常是当前登录用户）。'
        : '候选组：引擎里把该组成员配好，任务就会出现在这些人的待办里；组名可改，但要同步改 .bpmn 里的 role_xxx。'
    };
  });
  return {
    version: 1,
    note: '生成物里的审批人用角色组（flowable:candidateGroups）表达。部署前请在引擎里按本表建组并加人。',
    generatedAt: new Date().toISOString().slice(0, 10),
    roles: roles
  };
}

function main() {
  const data = collectRoles();
  const doc = buildDoc(data);

  if (process.argv.indexOf('--check') !== -1) {
    let bad = 0;
    if (!fs.existsSync(OUT)) {
      console.log('[FAIL] 缺少 src/org-roles.json，请先运行 node scripts/gen-org-roles.js');
      process.exit(1);
    }
    const cur = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    const known = new Set((cur.roles || []).map((r) => r.group));
    for (const k of data.groups.keys()) {
      if (!known.has('role_' + k)) {
        console.log('[FAIL] 模板里用到但映射表里没有: role_' + k);
        bad++;
      }
    }
    if (bad > 0) process.exit(1);
    console.log('[OK] 角色映射表与模板一致（' + cur.roles.length + ' 个角色）');
    return;
  }

  fs.writeFileSync(OUT, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  console.log('已生成 src/org-roles.json：' + doc.roles.length + ' 个角色');
  for (const r of doc.roles) {
    console.log('  ' + r.group.padEnd(22) + r.label.padEnd(10) + (r.kind === 'variable' ? '（变量：发起人）' : '→ ' + r.suggestedGroupId));
  }
}

main();
