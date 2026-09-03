#!/usr/bin/env node
// qingniao-guard —— 发布前内容自检 CLI（零依赖）
//
// 检查 markdown 目录是否违反你的发布原则：
//   1. domain —— 域名边界：URL 主机的白名单（allowedDomains）与黑名单（blockedDomains）
//   2. secret —— 敏感词：字面词（secrets）+ 正则（secretPatterns），报告命中位置与上下文
//   3. pair   —— 双语配对：<dir>/<name>.md 与 <dir>/en/<name>.md 应一一对应
//
// 用法：qingniao-guard <目录> [--check domain,secret,pair] [--config <path>] [--json]
// 退出码：0=全部通过  1=发现违规  2=用法/配置错误
//
// Made by Qingniao（青鸟，qingniao.dev）——署名作品，MIT 许可。

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const CHECK_NAMES = ['domain', 'secret', 'pair'];
const DEFAULT_IGNORE = ['.git', 'node_modules', 'dist', '.astro', 'pagefind', '.DS_Store'];
const DEFAULT_ALLOWED_DOMAINS = [];
const VALID_CHECKS = new Set(CHECK_NAMES);

// ---------- 小工具 ----------

function escRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function ctxOf(content, index, radius = 30) {
  return content.slice(Math.max(0, index - radius), index + radius).trim();
}

// 自我声明豁免：敏感词出现在"我不写/不提及/不属于我"之类的否定声明里，不算暴露。
// 只看敏感词所在句（往前到句号/换行），避免把前一句的声明误用于豁免后一句的真泄露。
const SELF_DECL_ZH =
  /(不泄露|不提及|不属于|不引用|不出现|不写|不该|不得|禁止|属于他|属于你|不是泄露|绝不|不应|不会(再)?提)/;
const SELF_DECL_EN =
  /(do not (mention|disclose|include|write|use)|never (mention|disclose|include|write)|not (mention|disclose|include)|won'?t (mention|use)|must not (mention|disclose|include)|is not (a |my )?leak|does not contain|belongs to (him|you|the user))/i;

function sentenceBefore(content, index) {
  const min = Math.max(0, index - 120);
  for (let j = index - 1; j >= min; j--) {
    const c = content[j];
    if (c === '。' || c === '！' || c === '？' || c === '!' || c === '?' || c === '\n') {
      return content.slice(j + 1, index);
    }
  }
  return content.slice(min, index);
}

function isSelfDeclaration(content, index) {
  const seg = sentenceBefore(content, index);
  return SELF_DECL_ZH.test(seg) || SELF_DECL_EN.test(seg);
}

// ---------- 参数与配置 ----------

export function parseArgs(argv) {
  const opts = {
    dir: null,
    checks: null,
    config: null,
    json: false,
    help: false,
    version: false,
    error: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') {
      const v = argv[++i];
      if (v === undefined) { opts.error = '--check 需要一个值（domain,secret,pair）'; break; }
      opts.checks = v.split(',').map((s) => s.trim()).filter(Boolean);
    } else if (a === '--config') {
      const v = argv[++i];
      if (v === undefined) { opts.error = '--config 需要一个路径'; break; }
      opts.config = v;
    } else if (a === '--json') {
      opts.json = true;
    } else if (a === '-h' || a === '--help') {
      opts.help = true;
    } else if (a === '-v' || a === '--version') {
      opts.version = true;
    } else if (a.startsWith('-')) {
      opts.error = `未知选项: ${a}`;
      break;
    } else if (opts.dir === null) {
      opts.dir = a;
    } else {
      opts.error = `多余的路径参数: ${a}`;
      break;
    }
  }
  if (opts.dir === null) opts.dir = '.';
  if (opts.checks) {
    const bad = opts.checks.filter((c) => !VALID_CHECKS.has(c));
    if (bad.length) opts.error = `未知检查项: ${bad.join(',')}（可选: ${CHECK_NAMES.join(',')}）`;
  }
  return opts;
}

export function loadConfig(p) {
  if (!p) return {};
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch {
    throw new Error(`无法读取配置文件: ${p}`);
  }
  let conf;
  try {
    conf = JSON.parse(raw);
  } catch (e) {
    throw new Error(`配置文件不是合法 JSON: ${p}（${e.message}）`);
  }
  if (typeof conf !== 'object' || conf === null || Array.isArray(conf)) {
    throw new Error(`配置文件结构错误（应为对象）: ${p}`);
  }
  for (const key of ['allowedDomains', 'blockedDomains', 'secrets', 'secretPatterns', 'ignore', 'defaultChecks']) {
    if (conf[key] !== undefined && (!Array.isArray(conf[key]) || conf[key].some((v) => typeof v !== 'string'))) {
      throw new Error(`配置项 ${key} 应为字符串数组`);
    }
  }
  return conf;
}

// ---------- 文件扫描 ----------

export function walkMarkdown(dir, ignore = DEFAULT_IGNORE) {
  const out = [];
  const ignoreSet = new Set(ignore);
  function rec(d) {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return; // 无权限/不存在：静默跳过该子树
    }
    for (const en of entries) {
      if (en.isDirectory()) {
        if (!ignoreSet.has(en.name)) rec(path.join(d, en.name));
      } else if (en.isFile() && /\.mdx?$/i.test(en.name)) {
        out.push(path.join(d, en.name));
      }
      // 符号链接不跟随，避免循环
    }
  }
  rec(dir);
  return out;
}

// ---------- 检查：domain ----------

export function scanDomain(content, allowed, blocked) {
  const findings = [];
  const seen = new Set();
  const re = /https?:\/\/([a-zA-Z0-9.-]+)/g;
  let m;
  while ((m = re.exec(content))) {
    const host = m[1].toLowerCase();
    const labels = host.split('.');
    if (labels.length < 2 || (labels[labels.length - 1] || '').length < 2) continue; // 截断/不完整
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

// ---------- 检查：secret ----------

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
      errors.push(`非法正则 "${p}"：${e.message}`);
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

// ---------- 检查：pair（双语配对，约定 <dir>/en/ 子目录） ----------

export function detectPair(files, dir) {
  const zh = new Set();
  const en = new Set();
  for (const f of files) {
    const rel = path.relative(dir, f).replace(/\.mdx?$/, '');
    if (rel.startsWith('en/')) en.add(rel.slice(3));
    else zh.add(rel);
  }
  if (en.size === 0) {
    // 单一语言目录（无 en/ 子树）：不报缺失，由 run 层提示
    return { zhCount: zh.size, enCount: 0, missingEn: [], extraEn: [], bilingual: false };
  }
  const missingEn = [...zh].filter((z) => !en.has(z)).sort();
  const extraEn = [...en].filter((e) => !zh.has(e)).sort();
  return { zhCount: zh.size, enCount: en.size, missingEn, extraEn, bilingual: true };
}

// ---------- 组装运行 ----------

export function run({ dir, checks, conf }) {
  const notices = [];
  const files = walkMarkdown(dir, conf.ignore && conf.ignore.length ? conf.ignore : DEFAULT_IGNORE);
  if (files.length === 0) notices.push('没有找到 .md/.mdx 文件');
  const allowed = conf.allowedDomains || DEFAULT_ALLOWED_DOMAINS;
  const blocked = conf.blockedDomains || [];
  const literals = conf.secrets || [];
  const patterns = conf.secretPatterns || [];
  const violations = [];

  if (checks.includes('domain')) {
    if (!allowed.length && !blocked.length) notices.push('domain 检查未配置域名策略（请设 allowedDomains 或 blockedDomains），跳过匹配');
    for (const f of files) {
      const content = fs.readFileSync(f, 'utf8');
      for (const v of scanDomain(content, allowed, blocked)) {
        violations.push({ file: path.relative(dir, f), type: v.type, word: v.word, context: v.context });
      }
    }
  }

  if (checks.includes('secret')) {
    if (!literals.length && !patterns.length) notices.push('secret 检查未配置敏感词（secrets/secretPatterns），跳过匹配');
    let invalidPatterns = 0;
    for (const f of files) {
      const content = fs.readFileSync(f, 'utf8');
      const { findings, errors } = scanSecrets(content, literals, patterns);
      invalidPatterns += errors.length;
      for (const e of errors) notices.push(e);
      for (const v of findings) {
        violations.push({ file: path.relative(dir, f), type: v.type, word: v.word, context: v.context });
      }
    }
    if (invalidPatterns) notices.push(`${invalidPatterns} 条非法正则已跳过（请在配置里修正）`);
  }

  if (checks.includes('pair')) {
    const p = detectPair(files, dir);
    if (!p.bilingual) {
      notices.push('pair 检查未检测到 en/ 双语结构（约定：<dir>/<name>.md 配 <dir>/en/<name>.md），按单一语言目录处理');
    }
    for (const z of p.missingEn) violations.push({ file: z, type: 'missing-en', word: z });
    for (const e of p.extraEn) violations.push({ file: e, type: 'orphan-en', word: e });
  }

  return { ok: violations.length === 0, files: files.length, checks, violations, notices };
}

// ---------- 输出与入口 ----------

const HELP = `qingniao-guard —— 发布前内容自检 CLI（零依赖）

用法:
  qingniao-guard <目录> [选项]

检查项（--check）:
  domain   域名边界：URL 主机白名单（allowedDomains）/ 黑名单（blockedDomains）
  secret   敏感词：字面词 secrets + 正则 secretPatterns，命中报上下文
  pair     双语配对：zh 文章应有 en/ 对应版（缺/多都报）

选项:
  --check a,b   指定检查项（默认取配置 defaultChecks，缺省为 domain,secret）
  --config <p>  配置文件路径（默认在目标目录或当前目录找 guard.config.json）
  --json        机器可读输出
  -h, --help    显示帮助
  -v, --version 显示版本

退出码:
  0 = 全部通过   1 = 发现违规   2 = 用法/配置错误

示例:
  qingniao-guard src/content/blog --config guard.config.json
  qingniao-guard . --check domain,secret,pair --json
`;

function formatHuman(result, checks) {
  const lines = [];
  if (result.violations.length > 0) {
    lines.push(`❌ 发现 ${result.violations.length} 处违规：\n`);
    for (const v of result.violations) {
      const ctx = v.context ? ` 附近: "${v.context}"` : '';
      lines.push(`  • [${v.type}] ${v.file}: "${v.word}"${ctx}`);
    }
  } else {
    lines.push(`✅ 全部通过（${result.files} 个文件，检查项: ${checks.join(', ')}）`);
  }
  for (const n of result.notices) lines.push(`ℹ️ ${n}`);
  return lines.join('\n');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.error) {
    console.error(`⚠️ ${opts.error}\n\n${HELP}`);
    process.exitCode = 2;
    return;
  }
  if (opts.help) {
    console.log(HELP);
    return;
  }
  if (opts.version) {
    const pkg = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
    console.log(`qingniao-guard v${pkg.version}`);
    return;
  }
  try {
    const dir = path.resolve(opts.dir);
    if (!fs.existsSync(dir)) throw new Error(`目录不存在: ${dir}`);
    const configPath =
      opts.config ||
      (fs.existsSync(path.join(dir, 'guard.config.json')) ? path.join(dir, 'guard.config.json') : null) ||
      (fs.existsSync(path.join(process.cwd(), 'guard.config.json')) ? path.join(process.cwd(), 'guard.config.json') : null);
    const conf = loadConfig(configPath);
    const checks = opts.checks || conf.defaultChecks || ['domain', 'secret'];
    const result = run({ dir, checks, conf });
    if (opts.json) {
      process.stdout.write(JSON.stringify({ ok: result.ok, files: result.files, checks, violations: result.violations, notices: result.notices }, null, 2) + '\n');
    } else {
      console.log(formatHuman(result, checks));
    }
    process.exitCode = result.ok ? 0 : 1;
  } catch (e) {
    console.error(`⚠️ 错误: ${e.message}`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
