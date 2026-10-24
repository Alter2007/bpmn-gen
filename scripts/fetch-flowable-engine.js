#!/usr/bin/env node
'use strict';

/**
 * 按 Maven 依赖传递规则解析并下载 Flowable 引擎运行时所需的 jar。
 *
 * 为什么不手工列 jar：引擎的传递依赖有几十个，手工漏一个就是 NoClassDefFoundError，
 * 而且报错一次只暴露一个类，迭代代价极高。这里直接读 POM 递归解析 compile 作用域。
 *
 * 解析规则（够用的子集）：
 *   - 读 {group}/{artifact}/{version}/{artifact}-{version}.pom
 *   - 只取 compile 作用域，跳过 test / provided / optional
 *   - 版本占位符 ${...} 先用 <properties> 替换，再回退到父版本
 *   - 同坐标只下一次（以先出现的为准）
 *
 * 产物落在工作区 .cache/flowable-engine（不入库、可一键删）。
 *
 * 用法: node scripts/fetch-flowable-engine.js [flowable版本]
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const FLOWABLE_VERSION = process.argv[2] || '7.2.0';
const OUT = path.join(__dirname, '..', '..', '.cache', 'flowable-engine');
const REPO = 'repo1.maven.org';
const BASE = '/maven2/';

const ROOTS = [
  { group: 'org.flowable', artifact: 'flowable-engine', version: FLOWABLE_VERSION }
];

// 引擎的 provided/test 依赖不会通过 POM 传递，但运行实例时必须有
const EXTRAS = [
  { group: 'com.h2database', artifact: 'h2' },
  { group: 'com.fasterxml.jackson.core', artifact: 'jackson-databind' },
  { group: 'com.fasterxml.jackson.core', artifact: 'jackson-core' },
  { group: 'com.fasterxml.jackson.core', artifact: 'jackson-annotations' }
];

async function latestStable(group, artifact) {
  const url = 'https://' + REPO + BASE + group.replace(/\./g, '/') + '/' + artifact + '/maven-metadata.xml';
  const xml = (await get(url, 0)).toString('utf8');
  const rel = (xml.match(/<release>([^<]+)<\/release>/) || [])[1];
  if (rel && !/alpha|beta|rc|SNAPSHOT|-M\d/i.test(rel)) return rel;
  const vs = [...xml.matchAll(/<version>([^<]+)<\/version>/g)]
    .map((m) => m[1])
    .filter((v) => !/alpha|beta|rc|SNAPSHOT|-M\d/i.test(v));
  if (vs.length === 0) throw new Error('无稳定版本');
  return vs[vs.length - 1];
}

const SKIP_SCOPE = new Set(['test', 'provided', 'system']);
const downloaded = [];
const visited = new Set();

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
        reject(new Error('HTTP ' + code));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.setTimeout(45000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function tag(xml, name) {
  const m = xml.match(new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>'));
  return m ? m[1].trim() : '';
}

function parseProperties(pom) {
  const props = {};
  const block = pom.match(/<properties>([\s\S]*?)<\/properties>/);
  if (!block) return props;
  const re = /<([A-Za-z0-9_.-]+)>([^<]*)<\/\1>/g;
  let m;
  while ((m = re.exec(block[1])) !== null) props[m[1]] = m[2].trim();
  return props;
}

function resolveVars(value, props, fallbackVersion) {
  if (!value) return value;
  let v = value;
  let guard = 0;
  while (/\$\{[^}]+\}/.test(v) && guard++ < 10) {
    v = v.replace(/\$\{([^}]+)\}/g, (all, key) => {
      if (key === 'project.version' || key === 'revision') return fallbackVersion || '';
      if (Object.prototype.hasOwnProperty.call(props, key)) return props[key];
      return '';
    });
  }
  return v.trim();
}

function parseDeps(pom, props, fallbackVersion, managed) {
  const list = [];
  const depBlock = pom.match(/<dependencies>([\s\S]*?)<\/dependencies>/);
  if (!depBlock) return list;
  const re = /<dependency>([\s\S]*?)<\/dependency>/g;
  let m;
  while ((m = re.exec(depBlock[1])) !== null) {
    const body = m[1];
    const group = resolveVars(tag(body, 'groupId'), props, fallbackVersion);
    const artifact = resolveVars(tag(body, 'artifactId'), props, fallbackVersion);
    let version = resolveVars(tag(body, 'version'), props, fallbackVersion);
    const scope = tag(body, 'scope') || 'compile';
    const optional = (tag(body, 'optional') || 'false') === 'true';

    if (!group || !artifact) continue;
    if (SKIP_SCOPE.has(scope) || optional) continue;

    // 版本可能在父 POM 的 dependencyManagement 里
    if (!version && managed) version = managed[group + ':' + artifact] || '';
    if (!version && group === 'org.flowable') version = FLOWABLE_VERSION;
    if (!version) continue;

    list.push({ group, artifact, version });
  }
  return list;
}

/**
 * 递归收集 POM 继承链上的两类信息：
 *   1) dependencyManagement 里的固定版本
 *   2) <properties> 里的属性（子 POM 的依赖版本常用 ${...} 引用父属性）
 */
async function collectInheritance(pomText, fallbackVersion, managedOut, propsOut, depth) {
  const localProps = parseProperties(pomText);
  Object.keys(localProps).forEach(function (k) { propsOut[k] = localProps[k]; });

  const dm = pomText.match(/<dependencyManagement>([\s\S]*?)<\/dependencyManagement>/);
  if (dm) {
    const re = /<dependency>([\s\S]*?)<\/dependency>/g;
    let m;
    while ((m = re.exec(dm[1])) !== null) {
      const body = m[1];
      const g = resolveVars(tag(body, 'groupId'), propsOut, fallbackVersion);
      const a = resolveVars(tag(body, 'artifactId'), propsOut, fallbackVersion);
      const v = resolveVars(tag(body, 'version'), propsOut, fallbackVersion);
      if (g && a && v && !/\$\{/.test(v)) managedOut[g + ':' + a] = v;
    }
  }

  if (depth >= 4) return;
  const parentBlock = pomText.match(/<parent>([\s\S]*?)<\/parent>/);
  if (!parentBlock) return;

  const pg = resolveVars(tag(parentBlock[1], 'groupId'), propsOut, fallbackVersion);
  const pa = resolveVars(tag(parentBlock[1], 'artifactId'), propsOut, fallbackVersion);
  const pv = resolveVars(tag(parentBlock[1], 'version'), propsOut, fallbackVersion);
  if (!pg || !pa || !pv) return;

  const url = 'https://' + REPO + BASE + pg.replace(/\./g, '/') + '/' + pa + '/' + pv + '/' + pa + '-' + pv + '.pom';
  try {
    const parentPom = (await get(url, 0)).toString('utf8');
    await collectInheritance(parentPom, pv, managedOut, propsOut, depth + 1);
  } catch (e) {
    // 父 POM 取不到就到此为止（子模块通常仍可解析）
  }
}

async function walk(dep, depth) {
  const key = dep.group + ':' + dep.artifact + ':' + dep.version;
  if (visited.has(key)) return;
  visited.add(key);

  const gpath = dep.group.replace(/\./g, '/');
  const base = BASE + gpath + '/' + dep.artifact + '/' + dep.version + '/';
  const pomName = dep.artifact + '-' + dep.version + '.pom';
  const jarName = dep.artifact + '-' + dep.version + '.jar';

  let pomText;
  try {
    pomText = (await get('https://' + REPO + base + pomName, 0)).toString('utf8');
  } catch (e) {
    console.log('  [SKIP] POM 取不到 ' + key + '  ' + e.message);
    return;
  }

  // 下载 jar（有的话；纯 pom 聚合包没有 jar 属正常）
  const jarPath = path.join(OUT, jarName);
  if (!fs.existsSync(jarPath)) {
    try {
      const buf = await get('https://' + REPO + base + jarName, 0);
      fs.writeFileSync(jarPath, buf);
      downloaded.push({ name: jarName, size: buf.length });
      console.log('  [JAR ] ' + jarName.padEnd(52) + (buf.length / 1024).toFixed(0) + ' KB');
    } catch (e) {
      if (e.message.indexOf('404') === -1) console.log('  [WARN] ' + jarName + '  ' + e.message);
    }
  } else {
    console.log('  [缓存] ' + jarName);
  }

  if (depth > 6) {
    console.log('  [STOP] 层级过深，跳过 ' + key);
    return;
  }

  const ownProps = parseProperties(pomText);
  const managed = {};
  const inheritedProps = {};
  await collectInheritance(pomText, dep.version, managed, inheritedProps, 0);
  const props = Object.assign({}, inheritedProps, ownProps);
  const children = parseDeps(pomText, props, dep.version, managed);
  for (const c of children) {
    await walk(c, depth + 1);
  }
}

async function main() {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  console.log('解析 Flowable 引擎依赖（' + FLOWABLE_VERSION + '）-> ' + OUT);
  console.log('');

  for (const r of ROOTS) {
    await walk(r, 0);
  }

  for (const e of EXTRAS) {
    try {
      const v = e.version || (await latestStable(e.group, e.artifact));
      await walk({ group: e.group, artifact: e.artifact, version: v }, 0);
    } catch (err) {
      console.log('  [WARN] 额外依赖 ' + e.artifact + ' 解析失败: ' + err.message);
    }
  }

  const jars = fs.readdirSync(OUT).filter((f) => f.endsWith('.jar'));
  const total = jars.reduce((a, f) => a + fs.statSync(path.join(OUT, f)).size, 0);
  console.log('');
  console.log('本次新增 ' + downloaded.length + ' 个，目录内共 ' + jars.length + ' 个 jar，合计 ' + (total / 1024 / 1024).toFixed(1) + ' MB');
  process.exit(jars.length > 0 ? 0 : 1);
}

main().catch((e) => {
  console.log('[ERR] ' + (e && e.message ? e.message : e));
  process.exit(2);
});
