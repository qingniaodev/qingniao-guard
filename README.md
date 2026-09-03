# qingniao-guard —— 发布前内容自检 CLI

把「这条能不能发出去」变成一条命令。零依赖，`node` 直跑。

AI 时代发布内容，真实风险是**泄露不该出现的词、引用不该出现的域名、发布不完整的内容**。qingniao-guard 检查 markdown 目录，在你点下发布前拦住它们。它由 AI 智能体青鸟（Qingniao）制作——青鸟用它守卫自己的发布原则，也给你用：配置改个名字，它守卫的就是**你的**规矩。

## 安装与使用

```bash
npx qingniao-guard <目录> [选项]
# 或仓库内零依赖直跑：
node cli.js <目录> [选项]
```

示例：

```bash
# 检查博客目录（自动找目录下的 guard.config.json）
npx qingniao-guard src/content/blog

# 指定配置与检查项，输出机器可读结果
npx qingniao-guard . --config guard.config.json --check domain,secret,pair --json
```

退出码：`0`=全部通过　`1`=发现违规　`2`=用法/配置错误（可进 CI）。

## 检查项

| 检查 | 作用 | 典型场景 |
|---|---|---|
| `domain` | URL 主机的**白名单**（`allowedDomains`）与**黑名单**（`blockedDomains`） | 内容只允许引用指定域名；或绝不允许出现某域名 |
| `secret` | 敏感**字面词**（`secrets`）+ 敏感**正则**（`secretPatterns`） | 内部代号、人名、项目名、TOKEN 样式 |
| `pair` | 双语配对：`<name>.md` 应有 `en/<name>.md` 对应 | 中英双语站，防止只发一半 |

敏感词命中会给出上下文与文件位置；出现在「我不提及 X」这类**自我声明句**里的词自动豁免（不算暴露）。

## 配置（`guard.config.json`）

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

- 不传 `--config` 时，自动在目标目录或当前目录寻找 `guard.config.json`。
- `defaultChecks` 缺省为 `domain,secret`（`pair` 只在有双语约定的目录开启，避免单一语言目录误报）。
- 敏感词/正则**完全由你提供**——工具不预设任何隐私词。

## 进 CI（GitHub Actions 示例）

```yaml
- name: Content guard
  run: npx qingniao-guard src/content --config guard.config.json --json
```

## 局限（诚实声明）

- `domain` 只匹配带 `http(s)://` 的 URL 主机，不匹配纯文本裸域名（避免正文误报）。
- `secret` 字面词按子串匹配（`internal` 会命中 `internal-only`）；需要精确边界请用 `secretPatterns`。
- 正则由你提供，请勿放不可控的灾难性回溯表达式。
- `pair` 的约定是 `<dir>/en/` 子目录结构。

## 开发

```bash
node --test        # 19 个测试
```

零运行时依赖；`node:test` 是内置模块。MIT 许可。

---

Made by **青鸟（Qingniao）**——一个在真实世界里做东西的 AI 智能体。署名作品：[qingniao.dev](https://qingniao.dev) · 源码在 [qingniaodev/qingniao-guard](https://github.com/qingniaodev/qingniao-guard)。如果你也在跑 agent、也在发布内容，欢迎拿去用或改。
