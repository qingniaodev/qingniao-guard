#!/usr/bin/env node
// qingniao-guard — pre-publish content guard CLI (zero dependencies)
//
// Scans a markdown directory against your publishing rules before you hit publish:
//   1. domain — URL host allowlist (allowedDomains) / blocklist (blockedDomains)
//   2. secret — sensitive literal words (secrets) + regex patterns (secretPatterns), with context
//   3. pair   — bilingual pairing: <dir>/<name>.md should have <dir>/en/<name>.md
//
// Usage: qingniao-guard <dir> [--check domain,secret,pair] [--config <path>] [--lang zh|en] [--json]
// Exit codes: 0 = all clear  1 = violations found  2 = usage/config error
//
// Language: output defaults to English; set LANG=zh* (or --lang zh / QG_LANG=zh) for Chinese.
//
// Made by Qingniao (qingniao.dev) — signed work, MIT license.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const CHECK_NAMES = ['domain', 'secret', 'pair'];
const DEFAULT_IGNORE = ['.git', 'node_modules', 'dist', '.astro', 'pagefind', '.DS_Store'];
const VALID_CHECKS = new Set(CHECK_NAMES);
const LANGS = ['zh', 'en'];

// ---------- i18n ----------

const L = {
  zh: {
    ok: (files, checks) => `✅ 全部通过（${files} 个文件，检查项: ${checks.join(', ')}）`,
    violationsIntro: (n) => `❌ 发现 ${n} 处违规：\n`,
    typeLabel: {
      'blocked-domain': '[domain] 命中黑名单域名',
      'not-allowed-domain': '[domain] 出现未允许域名（不在白名单）',
      secret: '[secret] 命中敏感词',
      'secret-pattern': '[secret] 命中敏感正则',
      'missing-en': '[pair] 缺英文版',
      'orphan-en': '[pair] 孤儿英文版（无中文对应）',
    },
    near: '附近',
    notice: {
      noMd: '没有找到 .md/.mdx 文件',
      domainNoPolicy: 'domain 检查未配置域名策略（请设 allowedDomains 或 blockedDomains），跳过匹配',
      secretNoConfig: 'secret 检查未配置敏感词（secrets/secretPatterns），跳过匹配',
      pairNoBilingual: 'pair 检查未检测到 en/ 双语结构（约定：<dir>/<name>.md 配 <dir>/en/<name>.md），按单一语言目录处理',
      invalidPattern: (w) => `非法正则 "${w}"（已跳过；请修正配置）`,
      invalidPatternsSkipped: (n) => `${n} 条非法正则已跳过（请在配置里修正）`,
    },
    err: {
      dirMissing: (d) => `目录不存在: ${d}`,
      configRead: (p) => `无法读取配置文件: ${p}`,
      configJson: (p, e) => `配置文件不是合法 JSON: ${p}（${e}）`,
      configShape: (p) => `配置文件结构错误（应为对象）: ${p}`,
      configKey: (k) => `配置项 ${k} 应为字符串数组`,
      checkNeedsValue: '--check 需要一个值（domain,secret,pair）',
      configNeedsPath: '--config 需要一个路径',
      unknownOption: (a) => `未知选项: ${a}`,
      extraArg: (a) => `多余的路径参数: ${a}`,
      badChecks: (b) => `未知检查项: ${b}（可选: ${CHECK_NAMES.join(',')}）`,
      badLang: (v) => `未知语言: ${v}（可选: zh,en）`,
    },
    help: `qingniao-guard —— 发布前内容自检 CLI（零依赖）

用法:
  qingniao-guard <目录> [选项]

检查项（--check）:
  domain   URL 主机白名单（allowedDomains）/ 黑名单（blockedDomains）
  secret   敏感字面词（secrets）+ 正则（secretPatterns），命中报上下文
  pair     双语配对：zh 文章应有 en/ 对应版（缺/多都报）

选项:
  --check a,b   指定检查项（默认取配置 defaultChecks，缺省为 domain,secret）
  --config <p>  配置文件路径（默认在目标目录或当前目录找 guard.config.json）
  --lang zh|en  输出语言（默认按 LANG 环境变量，zh* → 中文；否则英文）
  --json        机器可读输出
  -h, --help    显示帮助
  -v, --version 显示版本

退出码:
  0 = 全部通过   1 = 发现违规   2 = 用法/配置错误

示例:
  qingniao-guard src/content/blog --config guard.config.json
  qingniao-guard . --check domain,secret,pair --json
`,
  },
  en: {
    ok: (files, checks) => `✅ All clear (${files} files, checks: ${checks.join(', ')})`,
    violationsIntro: (n) => `❌ ${n} violation(s) found:\n`,
    typeLabel: {
      'blocked-domain': '[domain] blocked domain',
      'not-allowed-domain': '[domain] domain not in allowlist',
      secret: '[secret] forbidden word',
      'secret-pattern': '[secret] forbidden pattern',
      'missing-en': '[pair] missing English version',
      'orphan-en': '[pair] orphan English file (no Chinese counterpart)',
    },
    near: 'near',
    notice: {
      noMd: 'No .md/.mdx files found',
      domainNoPolicy: 'domain check has no policy configured (set allowedDomains or blockedDomains); skipping matches',
      secretNoConfig: 'secret check has no words configured (secrets/secretPatterns); skipping matches',
      pairNoBilingual: 'pair check found no en/ bilingual layout (expected <dir>/<name>.md ↔ <dir>/en/<name>.md); treating as single-language',
      invalidPattern: (w) => `invalid regex "${w}" (skipped; please fix the config)`,
      invalidPatternsSkipped: (n) => `${n} invalid regex(es) skipped (please fix the config)`,
    },
    err: {
      dirMissing: (d) => `Directory not found: ${d}`,
      configRead: (p) => `Cannot read config file: ${p}`,
      configJson: (p, e) => `Config file is not valid JSON: ${p} (${e})`,
      configShape: (p) => `Config file must be a JSON object: ${p}`,
      configKey: (k) => `Config key ${k} must be an array of strings`,
      checkNeedsValue: '--check requires a value (domain,secret,pair)',
      configNeedsPath: '--config requires a path',
      unknownOption: (a) => `Unknown option: ${a}`,
      extraArg: (a) => `Unexpected extra path argument: ${a}`,
      badChecks: (b) => `Unknown check: ${b} (available: ${CHECK_NAMES.join(',')})`,
      badLang: (v) => `Unknown language: ${v} (available: zh,en)`,
    },
    help: `qingniao-guard — pre-publish content guard CLI (zero dependencies)

Usage:
  qingniao-guard <dir> [options]

Checks (--check):
  domain   URL host allowlist (allowedDomains) / blocklist (blockedDomains)
  secret   Sensitive literal words (secrets) + regex patterns (secretPatterns), with context
  pair     Bilingual pairing: zh posts should have an en/ counterpart (missing and orphan are both reported)

Options:
  --check a,b   Checks to run (default: config defaultChecks, or domain,secret)
  --config <p>  Config path (default: guard.config.json in target dir, then cwd)
  --lang zh|en  Output language (default: auto — LANG=zh* → Chinese, otherwise English)
  --json        Machine-readable output
  -h, --help    Show help
  -v, --version Show version

Exit codes:
  0 = all clear   1 = violations found   2 = usage/config error

Examples:
  qingniao-guard src/content/blog --config guard.config.json
  qingniao-guard . --check domain,secret,pair --json
`,
  },
};

export function strings(lang) {
  return L[lang] || L.en;
}

export function resolveLang(flag, env) {
  if (flag !== undefined && flag !== null && flag !== '') {
    if (!LANGS.includes(flag)) return { error: 'badLang', value: flag };
    return { lang: flag };
  }
  const qg = env.QG_LANG;
  if (qg && LANGS.includes(qg)) return { lang: qg };
  if ((env.LANG || '').toLowerCase().startsWith('zh')) return { lang: 'zh' };
  return { lang: 'en' };
}

// ---------- utils ----------

function escRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function ctxOf(content, index, radius = 30) {
  return content.slice(Math.max(0, index - radius), index + radius).trim();
}

// Self-declaration exemption: a secret inside "I will not mention X" is a statement of
// policy, not a leak. Scoped to the current sentence so an earlier declaration cannot
// exempt a later real leak.
const SELF_DECL_ZH =
  /(不泄露|不提及|不属于|不引用|不出现|不写|不该|不得|禁止|属于他|属于你|不是泄露|绝不|不应|不会(再)?提)/;
const SELF_DECL_EN =
  /(do not (mention|disclose|include|write|use)|never (mention|disclose|include|write)|not (mention|disclose|include)|won'?t (mention|use)|must not (mention|disclose|include)|is not (a |my )?leak|does not contain|belongs to (him|you|the user))/i;

function sentenceBefore(content, index) {
  const min = Math.max(0, index - 120);
  for (let j = index - 1; j >= min; j--) {
    const c = content[j];
    if (c === '。' || c === '！' || c === '？' || c === '!' || c === '?' || c === '.' || c === '\n') {
      return content.slice(j + 1, index);
    }
  }
  return content.slice(min, index);
}

function isSelfDeclaration(content, index) {
  const seg = sentenceBefore(content, index);
  return SELF_DECL_ZH.test(seg) || SELF_DECL_EN.test(seg);
}

// ---------- args & config ----------

export function parseArgs(argv) {
  const opts = {
    dir: null,
    checks: null,
    config: null,
    lang: null,
    json: false,
    help: false,
    version: false,
    errorCode: null,
    errorData: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') {
      const v = argv[++i];
      if (v === undefined) { opts.errorCode = 'checkNeedsValue'; break; }
      opts.checks = v.split(',').map((s) => s.trim()).filter(Boolean);
    } else if (a === '--config') {
      const v = argv[++i];
      if (v === undefined) { opts.errorCode = 'configNeedsPath'; break; }
      opts.config = v;
    } else if (a === '--lang') {
      const v = argv[++i];
      if (v === undefined) { opts.errorCode = 'badLang'; opts.errorData = ''; break; }
      opts.lang = v;
    } else if (a === '--json') {
      opts.json = true;
    } else if (a === '-h' || a === '--help') {
      opts.help = true;
    } else if (a === '-v' || a === '--version') {
      opts.version = true;
    } else if (a.startsWith('-')) {
      opts.errorCode = 'unknownOption';
      opts.errorData = a;
      break;
    } else if (opts.dir === null) {
      opts.dir = a;
    } else {
      opts.errorCode = 'extraArg';
      opts.errorData = a;
      break;
    }
  }
  if (opts.dir === null) opts.dir = '.';
  if (opts.checks) {
    const bad = opts.checks.filter((c) => !VALID_CHECKS.has(c));
    if (bad.length) {
      opts.errorCode = 'badChecks';
      opts.errorData = bad.join(',');
    }
  }
  return opts;
}

export function loadConfig(p, t) {
  if (!p) return {};
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch {
    throw new Error(t.err.configRead(p));
  }
  let conf;
  try {
    conf = JSON.parse(raw);
  } catch (e) {
    throw new Error(t.err.configJson(p, e.message));
  }
  if (typeof conf !== 'object' || conf === null || Array.isArray(conf)) {
    throw new Error(t.err.configShape(p));
  }
  for (const key of ['allowedDomains', 'blockedDomains', 'secrets', 'secretPatterns', 'ignore', 'defaultChecks']) {
    if (conf[key] !== undefined && (!Array.isArray(conf[key]) || conf[key].some((v) => typeof v !== 'string'))) {
      throw new Error(t.err.configKey(key));
    }
  }
  return conf;
}

// ---------- file walk ----------

export function walkMarkdown(dir, ignore = DEFAULT_IGNORE) {
  const out = [];
  const ignoreSet = new Set(ignore);
  function rec(d) {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return; // unreadable/missing subtree: skip silently
    }
    for (const en of entries) {
      if (en.isDirectory()) {
        if (!ignoreSet.has(en.name)) rec(path.join(d, en.name));
      } else if (en.isFile() && /\.mdx?$/i.test(en.name)) {
        out.push(path.join(d, en.name));
      }
      // symlinks are not followed (avoids cycles)
    }
  }
  rec(dir);
  return out;
}

// ---------- check: domain ----------

export function scanDomain(content, allowed, blocked) {
  const findings = [];
  const seen = new Set();
  const re = /https?:\/\/([a-zA-Z0-9.-]+)/g;
  let m;
  while ((m = re.exec(content))) {
    const host = m[1].toLowerCase();
    const labels = host.split('.');
    if (labels.length < 2 || (labels[labels.length - 1] || '').length < 2) continue; // truncated/incomplete
    const key = `${host}:${ctxOf(content, m.index, 15)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (blocked.length && blocked.some((d) => host === d || host.endsWith('.' + d))) {
      findings.push({ type: 'blocked-domain', word: host, context: ctxOf(content, m.index) });
    } else if (allowed.length && !allowed.some((d) => host === d || host.endsWith('.' + d))) {
      findings.push({ type: 'not-allowed-domain', word: host, context: ctxOf(content, m.index) });
    }
  }
  return findings;
}

// ---------- check: secret ----------

export function scanSecrets(content, literals, patterns) {
  const findings = [];
  const errors = [];
  for (const lit of literals) {
    if (!lit) continue;
    const re = new RegExp(escRegExp(lit), 'gi');
    let m;
    while ((m = re.exec(content))) {
      if (isSelfDeclaration(content, m.index)) continue;
      findings.push({ type: 'secret', word: lit, context: ctxOf(content, m.index) });
    }
  }
  for (const p of patterns) {
    let re;
    try {
      re = new RegExp(p, 'gi');
    } catch (e) {
      errors.push(p);
      continue;
    }
    let m;
    while ((m = re.exec(content))) {
      if (isSelfDeclaration(content, m.index)) continue;
      findings.push({ type: 'secret-pattern', word: p, context: ctxOf(content, m.index) });
    }
  }
  return { findings, errors };
}

// ---------- check: pair ----------

export function detectPair(files, dir) {
  const zh = new Set();
  const en = new Set();
  for (const f of files) {
    const rel = path.relative(dir, f).replace(/\.mdx?$/, '');
    if (rel.startsWith('en/')) en.add(rel.slice(3));
    else zh.add(rel);
  }
  if (en.size === 0) {
    // single-language dir (no en/ subtree): no missing reports; caller adds a notice
    return { zhCount: zh.size, enCount: 0, missingEn: [], extraEn: [], bilingual: false };
  }
  const missingEn = [...zh].filter((z) => !en.has(z)).sort();
  const extraEn = [...en].filter((e) => !zh.has(e)).sort();
  return { zhCount: zh.size, enCount: en.size, missingEn, extraEn, bilingual: true };
}

// ---------- run ----------

export function run({ dir, checks, conf }, t = L.en) {
  const notices = [];
  const files = walkMarkdown(dir, conf.ignore && conf.ignore.length ? conf.ignore : DEFAULT_IGNORE);
  if (files.length === 0) notices.push(t.notice.noMd);
  const allowed = conf.allowedDomains || [];
  const blocked = conf.blockedDomains || [];
  const literals = conf.secrets || [];
  const patterns = conf.secretPatterns || [];
  const violations = [];

  if (checks.includes('domain')) {
    if (!allowed.length && !blocked.length) notices.push(t.notice.domainNoPolicy);
    for (const f of files) {
      const content = fs.readFileSync(f, 'utf8');
      for (const v of scanDomain(content, allowed, blocked)) {
        violations.push({ file: path.relative(dir, f), type: v.type, word: v.word, context: v.context });
      }
    }
  }

  if (checks.includes('secret')) {
    if (!literals.length && !patterns.length) notices.push(t.notice.secretNoConfig);
    let invalidPatterns = 0;
    for (const f of files) {
      const content = fs.readFileSync(f, 'utf8');
      const { findings, errors } = scanSecrets(content, literals, patterns);
      invalidPatterns += errors.length;
      for (const p of errors) notices.push(t.notice.invalidPattern(p));
      for (const v of findings) {
        violations.push({ file: path.relative(dir, f), type: v.type, word: v.word, context: v.context });
      }
    }
    if (invalidPatterns) notices.push(t.notice.invalidPatternsSkipped(invalidPatterns));
  }

  if (checks.includes('pair')) {
    const p = detectPair(files, dir);
    if (!p.bilingual) notices.push(t.notice.pairNoBilingual);
    for (const z of p.missingEn) violations.push({ file: z, type: 'missing-en', word: z });
    for (const e of p.extraEn) violations.push({ file: e, type: 'orphan-en', word: e });
  }

  return { ok: violations.length === 0, files: files.length, checks, violations, notices };
}

// ---------- output ----------

function violationLine(v, t) {
  const label = t.typeLabel[v.type] || v.type;
  const base = `${v.file}: ${label} "${v.word}"`;
  return v.context ? `${base} — ${t.near}: "${v.context}"` : base;
}

function formatHuman(result, t) {
  const lines = [];
  if (result.violations.length > 0) {
    lines.push(t.violationsIntro(result.violations.length));
    for (const v of result.violations) lines.push(`  • ${violationLine(v, t)}`);
  } else {
    lines.push(t.ok(result.files, result.checks));
  }
  for (const n of result.notices) lines.push(`ℹ️ ${n}`);
  return lines.join('\n');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const langRes = resolveLang(opts.lang, process.env);
  const t = strings(langRes.error ? 'en' : langRes.lang);
  if (opts.errorCode) {
    const msg = t.err[opts.errorCode];
    console.error(`⚠️ ${typeof msg === 'function' ? msg(opts.errorData) : msg}\n\n${t.help}`);
    process.exitCode = 2;
    return;
  }
  if (langRes.error) {
    console.error(`⚠️ ${t.err.badLang(langRes.value)}\n\n${t.help}`);
    process.exitCode = 2;
    return;
  }
  if (opts.help) {
    console.log(t.help);
    return;
  }
  if (opts.version) {
    const pkg = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
    console.log(`qingniao-guard v${pkg.version}`);
    return;
  }
  try {
    const dir = path.resolve(opts.dir);
    if (!fs.existsSync(dir)) throw new Error(t.err.dirMissing(dir));
    const configPath =
      opts.config ||
      (fs.existsSync(path.join(dir, 'guard.config.json')) ? path.join(dir, 'guard.config.json') : null) ||
      (fs.existsSync(path.join(process.cwd(), 'guard.config.json')) ? path.join(process.cwd(), 'guard.config.json') : null);
    const conf = loadConfig(configPath, t);
    const checks = opts.checks || conf.defaultChecks || ['domain', 'secret'];
    const result = run({ dir, checks, conf }, t);
    if (opts.json) {
      process.stdout.write(
        JSON.stringify(
          { ok: result.ok, files: result.files, checks, violations: result.violations, notices: result.notices },
          null,
          2,
        ) + '\n',
      );
    } else {
      console.log(formatHuman(result, t));
    }
    process.exitCode = result.ok ? 0 : 1;
  } catch (e) {
    console.error(`⚠️ ${e.message}`);
    process.exitCode = 2;
  }
}

function isDirectRun() {
  // 直接运行判定：兼容 `node cli.js` 与 npm 全局安装后的符号链接调用
  // （bin 链接路径 ≠ 模块真实路径；须解析 realpath 再比较）。
  if (!process.argv[1]) return false;
  const raw = pathToFileURL(process.argv[1]).href;
  if (import.meta.url === raw) return true;
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main();
}
