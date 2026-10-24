#!/usr/bin/env node
'use strict';

/**
 * 下载 Flowable 官方转换器/校验器的 jar 到工作区 .cache/flowable。
 *
 * 目的：让「引擎自己的代码」来判定我们的 BPMN 能不能被解析、能不能通过流程校验，
 * 这是 L4 最轻量的一层（不需要数据库、不需要 Spring）。
 *
 * 为什么不提交进仓库：jar 是运行期验证工具，不是交付物（P-09 可归零）。
 * 为什么用 Java 自带能力运行：JDK 11+ 支持直接跑单文件源码，不需要 Maven/Gradle（P-02/P-03）。
 *
 * 用法: node scripts/fetch-flowable.js [版本号]
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const FLOWABLE_VERSION = process.argv[2] || '7.2.0';
const OUT = path.join(__dirname, '..', '..', '.cache', 'flowable');

// Flowable 统一版本；其余走最新稳定版自动解析
const ARTIFACTS = [
  { group: 'org.flowable', name: 'flowable-bpmn-model', version: FLOWABLE_VERSION },
  { group: 'org.flowable', name: 'flowable-bpmn-converter', version: FLOWABLE_VERSION },
  { group: 'org.flowable', name: 'flowable-process-validation', version: FLOWABLE_VERSION },
  { group: 'org.flowable', name: 'flowable-engine-common', version: FLOWABLE_VERSION },
  { group: 'org.flowable', name: 'flowable-engine-common-api', version: FLOWABLE_VERSION },
  { group: 'org.apache.commons', name: 'commons-lang3' },
  { group: 'org.slf4j', name: 'slf4j-api' }
];

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
    req.setTimeout(60000, () => req.destroy(new Error('超时 ' + url)));
    req.on('error', reject);
  });
}

function stableVersions(xml) {
  const all = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]);
  return all.filter((v) => !/alpha|beta|rc|SNAPSHOT|-M\d/i.test(v));
}

async function resolveVersion(group, name) {
  const base = 'https://repo1.maven.org/maven2/' + group.replace(/\./g, '/') + '/' + name;
  const xml = (await get(base + '/maven-metadata.xml', 0)).toString('utf8');
  const release = (xml.match(/<release>([^<]+)<\/release>/) || [])[1];
  if (release) return release;
  const list = stableVersions(xml);
  if (list.length === 0) throw new Error('没有稳定版本: ' + group + ':' + name);
  return list[list.length - 1];
}

async function download(group, name, version) {
  const base = 'https://repo1.maven.org/maven2/' + group.replace(/\./g, '/') + '/' + name;
  const file = name + '-' + version + '.jar';
  const target = path.join(OUT, file);
  if (fs.existsSync(target) && fs.statSync(target).size > 0) {
    return { file, size: fs.statSync(target).size, cached: true };
  }
  const buf = await get(base + '/' + version + '/' + file, 0);
  fs.writeFileSync(target, buf);
  return { file, size: buf.length, cached: false };
}

async function main() {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  console.log('下载 Flowable 校验依赖 (Flowable ' + FLOWABLE_VERSION + ') -> ' + OUT);
  console.log('');

  let ok = 0;
  for (const a of ARTIFACTS) {
    try {
      const v = a.version || (await resolveVersion(a.group, a.name));
      const r = await download(a.group, a.name, v);
      console.log('  [' + (r.cached ? 'CACHED' : 'OK    ') + '] ' + r.file.padEnd(46) + (r.size / 1024).toFixed(0) + ' KB');
      ok++;
    } catch (e) {
      console.log('  [FAIL] ' + a.group + ':' + a.name + '  ' + e.message);
    }
  }

  console.log('');
  console.log('成功 ' + ok + ' / ' + ARTIFACTS.length);
  process.exit(ok === ARTIFACTS.length ? 0 : 1);
}

main().catch((e) => {
  console.log('[ERR] ' + (e && e.message ? e.message : e));
  process.exit(2);
});
