# Contributing

欢迎提交问题、文档改进和代码贡献。普通安装与使用请先阅读 [README](README.md)；本文只面向
需要修改或验证源码的贡献者。

## 开发环境

- Node.js 18 或更高版本
- npm
- 可选：Docker Compose，用于独立集成环境

安装并验证：

```bash
npm ci
npm run verify
```

测试使用 Node.js 内置 `node:test`，不需要真实微信、生产角色数据或 API key。测试 fixture
必须完全脱敏，不得提交二维码、token、Cookie、真实聊天、微信身份或本地设备路径。

## Docker 集成环境

[`deploy/test/compose.yml`](deploy/test/compose.yml) 提供与生产数据隔离的测试环境，运行数据
写入被 Git 忽略的 `deploy/test/runtime/`。

1. 生成或准备插件 ZIP，并解压到 `deploy/test/runtime/plugins/st-wechat/`。
2. 确认 `st-wechat/package.json` 直接位于该目录，不存在双层文件夹。
3. 在 `deploy/test/` 执行：

   ```bash
   docker compose -p st-wechat-test up -d
   ```

4. 打开 `http://<Docker主机地址>:18000`，只使用可丢弃的角色、世界书、聊天和测试凭据。
5. 完成后执行 `docker compose -p st-wechat-test down`。不要把 `runtime/` 指向生产目录。

## 提交要求

- 一个提交只处理一个清晰目的。
- 运行与修改风险相称的测试，至少执行相关用例和 `git diff --check`。
- 行为变化应补充自动化回归测试；用户可见变化应同步更新 README 或对应公开文档。
- 不提交 `.codex/`、`.artifacts/`、`.test-results/`、运行凭据或本地部署数据。
- 提交 PR 前检查完整待推送历史，而不只检查当前工作树，确保已删除的信息没有残留在旧提交中。
