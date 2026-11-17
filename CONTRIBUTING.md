# 贡献指南

单人自用项目，但欢迎 issue / PR。动手前请先读 `AGENTS.md`（项目热启动手册 + 已知坑位表）。

## 开发环境

- Node.js 20+
- 依赖安装必须带 `--legacy-peer-deps`（webpack 版本冲突，见 README）：

```bash
npm install --legacy-peer-deps
```

## 常用命令

```bash
npm run typecheck      # tsc --noEmit，应为 0 错误
npm run lint           # eslint src
npm test               # 单测（node --test scripts/*.test.js）
npm run check:rules    # 生成物与规则源同步检查
npm run build:weapp    # 小程序构建（需显式传 TCB_ENV_ID / SUBS_TEMPLATE_ID，见 .env.example）
```

## 提交约定

- 提交信息用中文，格式 `<type>(<scope>): 概要`，如 `feat(share): ...` / `fix(ops): ...`
- 改 `follow-record` 等共享规则时，一切改动走生成器（`npm run gen:rules`），不要手改生成物（坑 #12）
- 推送后看一眼 GitHub Actions 结果，红灯=有事故未处理（坑 #12）

## 踩坑文化

项目按「踩坑一次、永久受益」运转：遇到非显而易见的失败，把根因和解法追加到
`AGENTS.md` 的已知坑位表（按编号倒序），而不是只在群里/脑子里记住。
