#!/usr/bin/env node
'use strict';

/**
 * 下载 OMG 官方的 BPMN 2.0 XSD 到工作区 .cache/schema/bpmn20。
 *
 * 为什么不把 XSD 提交进仓库：
 *   1. P-09（可归零）：规范文件属于"运行期依赖"，不该进交付目录；
 *   2. P-11（开源合规）：OMG 规范的再分发条款需要单独确认，不擅自打包。
 * 所以按需下载、缓存在 .cache，删掉即可复原。
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const FILES = ['BPMN20.xsd', 'BPMNDI.xsd', 'Semantic.xsd', 'DC.xsd', 'DI.xsd'];
const BASE = 'https://www.omg.org/spec/BPMN/20100501/';
const OUT = path.join(__dirname, '..', '..', '.cache', 'schema', 'bpmn20');

function get(url, depth) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location && depth < 5) {
        res.resume();
        resolve(get(res.headers.location, depth + 1));
        return;
      }
      if (code !== 200) {
        res.resume();
        reject(new Error('HTTP ' + code + '  ' + url));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.setTimeout(30000, () => req.destroy(new Error('超时: ' + url)));
    req.on('error', reject);
  });
}

async function main() {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  console.log('下载 BPMN 2.0 XSD -> ' + OUT);
  let ok = 0;
  for (const f of FILES) {
    try {
      const buf = await get(BASE + f, 0);
      fs.writeFileSync(path.join(OUT, f), buf);
      console.log('  [OK]   ' + f.padEnd(14) + buf.length + ' 字节');
      ok++;
    } catch (e) {
      console.log('  [FAIL] ' + f.padEnd(14) + e.message);
    }
  }
  console.log('');
  console.log('成功 ' + ok + ' / ' + FILES.length);
  process.exit(ok === FILES.length ? 0 : 1);
}

main().catch((e) => {
  console.log('[ERR] ' + (e && e.message ? e.message : e));
  process.exit(2);
});
