[English](DEVELOPMENT_EN.md)

# 开发指南

## 目录

| 路径 | 说明 |
| --- | --- |
| `src/` | Vue 3、Pinia、路由、组件与 i18n |
| `functions/` | Cloudflare Pages Functions 与服务 |
| `server/` | Node 22 适配层、数据库、内部调度器、本机执行器与安装资源 |
| `runtime/v2/modules/` | POSIX Shell Runtime 源模块 |
| `public/proxy/v2/` | Runtime 构建产物与清单 |
| `tests/unit/` | Vitest 单元与 Miniflare D1 测试 |
| `tests/e2e/` | Playwright 浏览器测试 |
| `scripts/` | Runtime、文档与截图工具 |

## 开发命令

```bash
npm ci
npm run dev
npm run test:run
npm run test:e2e
npm run runtime:build
npm run runtime:check
npm run docs:check
npm run build
npm run pages:verify
npm run deploy:pages
```

维护者发布前，将 `scripts/pages-production-target.example.json` 复制为 Git 忽略的 `scripts/pages-production-target.local.json` 并填写生产项目、KV 和 D1 信息；也可使用对应的 `TSUB_PAGES_*` 环境变量。公共 `wrangler.toml` 不得包含账号资源 ID，Pages 的运行时资源统一在 Cloudflare 控制台绑定。

Runtime 源修改后必须重新运行 `runtime:build`，并将生成脚本、清单和 SHA-256 一起提交。不要手工编辑生成脚本。

## 代码约定

- 前端用户文案必须同时加入 `zh-CN` 和 `en-US`。
- 业务值使用稳定英文 ID，不能使用显示文本作为比较条件。
- 结构化数据使用解析器和 Web API，不使用脆弱的字符串拼接。
- 敏感字段通过统一组件遮蔽，日志和错误只记录摘要。
- 新存储键使用 `tsub_` 命名空间；D1 变更同步更新 [schema.sql](../schema.sql)。
- 演示数据只能通过独立键加入管理读取，不得进入真实业务写入路径。

## 测试策略

Repository 契约必须覆盖 KV、D1、SQLite 和 PostgreSQL。Miniflare 验证 D1 条件更新；真实 SQLite 验证 WAL 与锁；PostgreSQL CI 验证事务、多实例租约和 SQL 兼容。认证覆盖未登录、会话失效与请求上限；部署覆盖配置矩阵、Token、防重放、命令租约、Agent 心跳、Unix Socket 和 Runtime 快照；前端覆盖中英文、桌面/390px 布局与能力置灰。

## 文档规则

正式文档必须成对存在，顶部互相链接。运行 `npm run docs:check` 检查配对、链接、旧文档和来源引用。截图由 `npm run docs:screenshots` 生成，不能手工加入真实数据。

## 发布清单

1. `git diff --check`
2. `npm run test:run`
3. Runtime Shell 测试与 `npm run runtime:check`
4. `npm run docs:check`
5. `npm run build`
6. Node 服务 HTTP 冒烟、`docker compose config`、Docker 构建与 PostgreSQL 测试
7. ShellCheck、dash/BusyBox ash、本机执行器权限与 Secret 扫描
8. Pages 发布必须使用 `npm run deploy:pages`；脚本从本地忽略配置或环境变量读取目标，并核对生产 Account ID、项目子域名及控制台 KV/D1 绑定，禁止直接运行裸 `wrangler pages deploy`
9. 生成演示数据和截图，人工检查桌面/移动端
10. 提交并推送 `origin/main`
