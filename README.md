# ST WeChat Bot

**酒馆角色卡 → 微信对话**  
通过微信 iLink 协议，在微信中与 SillyTavern 角色卡直接聊天。

---

## 原理

```
手机微信  ←→  iLink 云服务  ←→  本插件  ←→  LLM API
                                    ↕
                            酒馆 data 目录（角色卡/聊天记录/世界书/配置）
```

服务端插件直接承担一切：接收微信消息、加载角色卡和世界书、组装提示词、调用 LLM、回推回复到微信。**不依赖酒馆浏览器窗口**。

---

## 功能

- 微信扫码登录（iLink / ClawBot）
- 每个酒馆角色卡映射为一个 Bot，通过 `/switch` 切换
- 支持导入角色卡名/序号/前缀模糊匹配
- 世界书关键词自动匹配注入
- 对话记录实时写入酒馆 `chats/` 目录，与酒馆网页互通
- 续写 `/continue`、重试 `/retry`、代人发言 `/imp` 等
- 手动记忆 `/memory`，自动注入到上下文
- 扩展面板实时显示二维码和状态
- 容器重启自动恢复凭证，无需重复扫码

---

## 部署

### 1. 放入插件目录

将 `st-wechat/` 整个目录放到酒馆的 `plugins/` 下：

```
SillyTavern/
└── plugins/
    └── st-wechat/
        ├── package.json
        ├── config.yaml
        ├── src/
        │   ├── index.js        ← 插件入口
        │   ├── ilink.js        ← iLink 微信协议
        │   ├── config.js       ← ST 配置加载
        │   ├── adapter.js      ← LLM 调用
        │   ├── session.js      ← 会话管理 + 命令路由
        │   ├── prompt-builder.js
        │   ├── worldbook.js    ← 世界书
        │   ├── chat-store.js   ← 聊天记录读写
        │   ├── parser.js       ← 角色卡解析
        │   └── template.js
        ├── ui-extension/       ← 酒馆扩展面板
        │   ├── manifest.json
        │   ├── index.js
        │   ├── settings.html
        │   ├── style.css
        │   └── qrcode.min.js
        └── config.yaml
```

### 2. 编辑 config.yaml（如需要）

```yaml
# 如果 ST 的 settings.json 没有正确保存模型/端点，在此手动指定
endpoint: https://api.deepseek.com/v1
model: deepseek-chat
```

如果不填，插件会尝试从 ST 预设文件自动读取。

### 3. 确保酒馆开启服务端插件

`config.yaml` 中：
```yaml
enableServerPlugins: true
```

### 4. Docker 用户额外挂载 UI 扩展目录

如果使用 Docker，在 compose 中挂载第三方扩展目录，例如：

```yaml
volumes:
  - /宿主机路径/extensions/third-party:/home/node/app/public/scripts/extensions/third-party
```

### 5. 重启酒馆

```bash
docker compose restart sillytavern
# 或直接重启进程
```

---

## 扫码登录

### 方式一：扩展面板

酒馆「扩展」→ **ST WeChat Bot**，面板内自动显示二维码，扫码后自动显示状态。

### 方式二：独立页面

访问 `http://你的酒馆:8000/api/plugins/st-wechat/status`

### 方式三：终端日志

启动后日志直接打印二维码链接。

---

## 命令一览

### 角色管理

| 命令 | 说明 |
|------|------|
| `/list` | 列出所有角色卡 |
| `/switch 序号` `/switch 角色名` | 切换到角色（支持序号、完整名、前缀） |
| `/whoami` | 当前角色和状态 |
| `/clear` | 清空对话历史 |

### 对话控制

| 命令 | 说明 |
|------|------|
| `/continue` `/cont` | AI 续写 |
| `/gen 方向` | 指定续写方向 |
| `/retry` `/r` | 重新生成上一条回复 |
| `/imp 内容` | AI 代用户说话 |
| `/swipe` | 查看备选回复 |

### 记忆

| 命令 | 说明 |
|------|------|
| `/memory 内容` `/mem` | 手动设置记忆 |
| `/getmem` | 查看当前记忆 |

### 系统

| 命令 | 说明 |
|------|------|
| `/reload` | 重载酒馆配置 |
| `/help` | 帮助 |

---

## 切换角色时

`/switch Alisa` 或 `/switch 3`：

- 如果该角色**已有聊天记录**：自动加载，并在微信中展示最近 5 条逐条发送
- 如果该角色**全新**：生成开场白

不同角色各自维护独立的对话历史，可来回切换互不干扰。

---

## 数据同步

| 数据 | 酒馆 → 微信 | 微信 → 酒馆 |
|------|------------|------------|
| 角色卡 | ✅ 自动读取 | — |
| 聊天记录 | `/switch` 时加载历史 | ✅ 每轮实时写入 |
| 世界书 | ✅ 自动匹配注入 | — |
| 记忆 | ✅ 读取聊天文件 summary | `/memory` 写入 |
| API 配置 | ✅ 自动（或 config.yaml 覆盖） | — |

所以你可以在酒馆网页创建/编辑角色卡、写世界书，然后在微信里聊天，两者数据互通。

---

## 长连接与异常恢复

- **Token 有效期**：iLink 通常持续数天，由服务端决定
- **自动重连**：Token 过期 → 自动检测并触发重新扫码
- **容器重启**：自动从 `.wechat_creds.json` 恢复凭证，无需重扫
- **网络断连**：指数退避重试

---

## 目录结构

```
st-wechat/
├── config.yaml              ← 模型/端点覆盖（可选）
├── package.json
├── .gitignore
├── .wechat_creds.json       ← 自动生成，勿删
├── README.md
├── src/
│   ├── index.js             ← 插件入口，部署 UI 扩展
│   ├── ilink.js             ← iLink 协议（扫码/长轮询/收发）
│   ├── config.js            ← ST 配置加载
│   ├── adapter.js           ← 角色加载 + LLM API
│   ├── session.js           ← 会话管理 + 15 条命令
│   ├── prompt-builder.js    ← 提示词组装（模板/世界书/记忆）
│   ├── worldbook.js         ← 世界书加载匹配
│   ├── chat-store.js        ← ST 聊天 JSONL 读写
│   ├── parser.js            ← PNG 角色卡元数据解析
│   └── template.js          ← 模板宏替换
└── ui-extension/
    ├── manifest.json
    ├── index.js             ← 扩展面板
    ├── settings.html        ← 面板模板
    ├── style.css
    └── qrcode.min.js        ← 本地二维码生成库
```

---

## 依赖

- Node.js ≥ 18
- 零 npm 依赖（使用 Node 内置 `fetch`、`fs`、`path`、`crypto`）
