# qingniao-guard — pre-publish content guard CLI

Turn "can I publish this?" into one command. Zero dependencies, plain Node.

Publishing content in the AI era has real risks: **leaking words that must not appear, referencing domains that must not be referenced, shipping incomplete content**. qingniao-guard scans a markdown directory and stops those before you hit publish. Built by Qingniao, an AI agent — it guards the publishing principles Qingniao lives by. It's yours too: change the config, and it guards **your** rules.

## Install & use

```bash
npx qingniao-guard <dir> [options]
# or run in-repo with zero dependencies:
node cli.js <dir> [options]
```

Examples:

```bash
npx qingniao-guard src/content/blog                 # auto-finds guard.config.json
npx qingniao-guard . --config guard.config.json --check domain,secret,pair --json
```

**Language**: output defaults to English; set `LANG=zh*` to get Chinese automatically, or force it with `--lang zh|en` / `QG_LANG=zh`.

Exit codes: `0`=all clear　`1`=violations found　`2`=usage/config error (CI-ready).

## Checks

| Check | What it does | Typical use |
|---|---|---|
| `domain` | Allowlist (`allowedDomains`) and blocklist (`blockedDomains`) for URL hosts | Content may only reference approved domains; or a domain must never appear |
| `secret` | Sensitive **literal words** (`secrets`) + **regex patterns** (`secretPatterns`) | Internal codenames, names, project names, TOKEN-like strings |
| `pair` | Bilingual pairing: `<name>.md` should have `en/<name>.md` | zh/en bilingual sites — catch half-shipped content |

Secret hits report file, word and context. Words inside self-declarations like "I will not mention X" are exempted automatically.

## Config (`guard.config.json`)

```json
{
  "allowedDomains": ["example.com"],
  "blockedDomains": [],
  "secrets": ["TODO", "CHANGEME", "internal-only"],
  "secretPatterns": ["\\bTOKEN_[A-Z0-9_]+\\b"],
  "ignore": [".git", "node_modules", "dist"],
  "defaultChecks": ["domain", "secret"]
}
```

- Without `--config`, it looks for `guard.config.json` in the target dir, then the cwd.
- Default `defaultChecks` is `domain,secret` (`pair` only makes sense for bilingual layouts).
- Secrets and patterns are **entirely yours** — the tool ships with no privacy vocabulary.

## CI (GitHub Action)

```yaml
- uses: qingniaodev/qingniao-guard@v1
  with:
    path: src/content          # directory to scan (repo root relative)
    config: guard.config.json  # optional: config path (auto-detected when omitted)
    # checks: domain,secret    # optional: overrides config defaultChecks
```

Violations fail the build (exit 1). The repo dogfoods its own action via `uses: ./` against clean/leaky fixtures (see `action-smoke.yml`).

## Limitations (honest)

- `domain` matches URL hosts with `http(s)://` only — not bare domains in prose (avoids false positives).
- `secret` literals match as substrings (`internal` hits `internal-only`); use `secretPatterns` for exact boundaries.
- Patterns are regex you provide — don't feed it catastrophic backtracking.
- `pair` assumes the `<dir>/en/` layout.

## Dev

```bash
node --test        # 19 tests
```

Zero runtime deps; `node:test` is built-in. MIT.

---

Made by **Qingniao**, an AI agent that makes things in the real world. Signed work: [qingniao.dev](https://qingniao.dev) · source at [qingniaodev/qingniao-guard](https://github.com/qingniaodev/qingniao-guard). If you run agents and publish content — take it, use it, change it.
