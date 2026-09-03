import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  parseArgs,
  loadConfig,
  walkMarkdown,
  scanDomain,
  scanSecrets,
  detectPair,
  run,
} from './cli.js';

const execFileP = promisify(execFile);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(ROOT, 'test', 'fixtures');

// ---------- parseArgs ----------

test('parseArgs: 默认目录与检查', () => {
  const o = parseArgs([]);
  assert.equal(o.dir, '.');
  assert.equal(o.checks, null);
  assert.equal(o.error, null);
});

test('parseArgs: 解析 --check/--config/--json 与目录', () => {
  const o = parseArgs(['posts', '--check', 'domain,pair', '--config', 'c.json', '--json']);
  assert.equal(o.dir, 'posts');
  assert.deepEqual(o.checks, ['domain', 'pair']);
  assert.equal(o.config, 'c.json');
  assert.equal(o.json, true);
});

test('parseArgs: 未知选项/多余路径/非法检查项报错', () => {
  assert.match(parseArgs(['--nope']).error, /未知选项/);
  assert.match(parseArgs(['a', 'b']).error, /多余/);
  assert.match(parseArgs(['--check', 'domain,wat']).error, /未知检查项/);
  assert.match(parseArgs(['--check']).error, /需要一个值/);
});

// ---------- loadConfig ----------

test('loadConfig: 非法 JSON / 缺文件 / 结构错误都给清晰报错', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-test-'));
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, '{oops');
  assert.throws(() => loadConfig(bad), /合法 JSON/);
  assert.throws(() => loadConfig(path.join(dir, 'missing.json')), /无法读取/);
  fs.writeFileSync(path.join(dir, 'arr.json'), '[1,2]');
  assert.throws(() => loadConfig(path.join(dir, 'arr.json')), /应为对象/);
  fs.writeFileSync(path.join(dir, 't.json'), '{"secrets": "nope"}');
  assert.throws(() => loadConfig(path.join(dir, 't.json')), /字符串数组/);
  assert.deepEqual(loadConfig(null), {});
});

// ---------- walkMarkdown ----------

test('walkMarkdown: 只收 md/mdx，忽略 node_modules 等', () => {
  const files = walkMarkdown(path.join(FIX, 'ignore')).map((f) => path.relative(path.join(FIX, 'ignore'), f));
  assert.deepEqual(files, []);
  const clean = walkMarkdown(path.join(FIX, 'clean'));
  assert.equal(clean.length, 1);
});

// ---------- scanDomain ----------

test('scanDomain: 白名单通过、子域通过、非白名单命中', () => {
  const content = '看 https://example.com/a 和 https://sub.example.com/b，别点 https://evil.example.net/c';
  const hits = scanDomain(content, ['example.com'], []);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].word, 'evil.example.net');
});

test('scanDomain: 黑名单优先于白名单；截断 URL 不误报', () => {
  const content = '黑名单 https://bad.example.net/x 白名单也写 https://bad.example.net/y 截断的 www. 不算';
  const hits = scanDomain(content, ['bad.example.net', 'example.com'], ['bad.example.net']);
  assert.equal(hits.length, 2);
  const content2 = '只有 www. 没有完整域名';
  assert.equal(scanDomain(content2, ['example.com'], []).length, 0);
});

test('scanDomain: 无策略时不误报（仅提示由 run 层负责）', () => {
  assert.equal(scanDomain('看 https://evil.example.net/a', [], []).length, 0);
});

// ---------- scanSecrets ----------

test('scanSecrets: 字面词命中 + 自我声明豁免', () => {
  const content = '我不提及 acme-internal（豁免）。但这里 acme-internal 是真泄露。';
  const { findings } = scanSecrets(content, ['acme-internal'], []);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].type, 'secret');
});

test('scanSecrets: 正则命中 + 非法正则收集错误不崩', () => {
  const content = '令牌 TOKEN_abc123 泄露';
  const { findings, errors } = scanSecrets(content, [], ['TOKEN_[A-Z0-9_]+', '([bad']);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].type, 'secret-pattern');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /非法正则/);
});

// ---------- detectPair ----------

test('detectPair: 找出缺英文版与孤儿英文版', () => {
  const dir = path.join(FIX, 'bilingual');
  const files = walkMarkdown(dir);
  const p = detectPair(files, dir);
  assert.equal(p.bilingual, true);
  assert.deepEqual(p.missingEn, ['missing']);
  assert.deepEqual(p.extraEn, ['orphan']);
});

test('detectPair: 单一语言目录不误报缺失', () => {
  const dir = path.join(FIX, 'clean');
  const p = detectPair(walkMarkdown(dir), dir);
  assert.equal(p.bilingual, false);
  assert.equal(p.missingEn.length, 0);
});

// ---------- run 集成 ----------

test('run: 干净目录通过', () => {
  const r = run({
    dir: path.join(FIX, 'clean'),
    checks: ['domain', 'secret'],
    conf: { allowedDomains: ['example.com'], secrets: [] },
  });
  assert.equal(r.ok, true);
  assert.equal(r.violations.length, 0);
});

test('run: 泄露目录命中域名与敏感词', () => {
  const r = run({
    dir: path.join(FIX, 'leaky'),
    checks: ['domain', 'secret'],
    conf: { allowedDomains: ['example.com'], secrets: ['acme-internal'] },
  });
  assert.equal(r.ok, false);
  const types = r.violations.map((v) => v.type).sort();
  assert.deepEqual(types, ['not-allowed-domain', 'secret']);
});

test('run: 豁免生效、正则命中、文件可数', () => {
  const r = run({
    dir: path.join(FIX, 'secrets'),
    checks: ['secret'],
    conf: { secrets: ['acme-internal'], secretPatterns: ['TOKEN_[A-Z0-9_]+'] },
  });
  assert.equal(r.ok, false);
  assert.equal(r.violations.length, 2); // 1 字面 + 1 正则；自我声明行豁免
});

test('run: pair 检查报缺失与孤儿', () => {
  const r = run({
    dir: path.join(FIX, 'bilingual'),
    checks: ['pair'],
    conf: {},
  });
  assert.equal(r.ok, false);
  assert.equal(r.violations.length, 2);
  assert.ok(r.violations.some((v) => v.type === 'missing-en'));
  assert.ok(r.violations.some((v) => v.type === 'orphan-en'));
});

// ---------- CLI 冒烟 ----------

test('CLI: --version 输出版本', async () => {
  const { stdout } = await execFileP(process.execPath, ['cli.js', '--version'], { cwd: ROOT });
  assert.match(stdout, /v1\.0\.0/);
});

test('CLI: --json 泄露目录退出码 1', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-cfg-'));
  const cfg = path.join(tmp, 'guard.config.json');
  fs.writeFileSync(cfg, JSON.stringify({ allowedDomains: ['example.com'], secrets: ['acme-internal'] }));
  try {
    await execFileP(process.execPath, ['cli.js', path.join(FIX, 'leaky'), '--config', cfg, '--json'], { cwd: ROOT });
    assert.fail('应当以退出码 1 失败');
  } catch (e) {
    assert.equal(e.code, 1);
    const out = JSON.parse(e.stdout);
    assert.equal(out.ok, false);
    assert.equal(out.violations.length, 2);
  }
});

test('CLI: 干净目录退出码 0', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-cfg-'));
  const cfg = path.join(tmp, 'guard.config.json');
  fs.writeFileSync(cfg, JSON.stringify({ allowedDomains: ['example.com'], secrets: [] }));
  const { stdout } = await execFileP(
    process.execPath,
    ['cli.js', path.join(FIX, 'clean'), '--config', cfg, '--json'],
    { cwd: ROOT },
  );
  const out = JSON.parse(stdout);
  assert.equal(out.ok, true);
});
