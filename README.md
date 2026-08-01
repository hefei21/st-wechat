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
- 单所有者验证码认领，其他微信身份默认拒绝访问
- 每个酒馆角色卡映射为一个 Bot，通过 `/switch` 切换
- 支持按酒馆已安装 PNG 角色卡的名称、序号或前缀切换
- 世界书关键词自动匹配注入
- 每轮完成后写入酒馆 `chats/` 目录，并与酒馆网页进行最终一致同步
- 浏览器与微信共享同一组聊天文件，各自保留当前聊天选择
- 容器重启后恢复上次角色和准确聊天，不需要重新 `/switch`
- 同一聊天的两端生成串行处理，并通过修订号避免旧上下文写入
- 续写 `/continue`、重试 `/retry`、备选回复 `/swipe` 和停止生成 `/stop`
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
# 默认跟随酒馆当前连接与生成配置
configurationMode: auto
thinking: disabled
charsPerToken: 3
maxQueuedMessages: 20
syncMode: notify
```

`auto` 会读取酒馆当前的聊天补全来源、端点、模型、对应密钥槽、温度、输出长度和上下文长度。
酒馆使用 **Custom** 连接时会精确读取 Custom 密钥槽，不需要额外配置 `secretSource`。

只有需要让 Bot 使用独立配置时才启用覆盖模式：

```yaml
configurationMode: override
provider: deepseek
endpoint: https://api.deepseek.com/v1
model: deepseek-v4-flash
secretSource: custom
temperature: 0.9
maxOutputTokens: 1200
maxContextTokens: 64000
```

密钥始终从指定连接对应的 SillyTavern 密钥槽读取，不会跨槽回退，也不要写入 `config.yaml`。

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

为避免二维码凭据泄露，终端日志只提示前往已认证的扩展面板或独立页面扫码，不输出二维码原文或链接。

---

## 命令一览

### 角色管理

| 命令 | 说明 |
|------|------|
| `/list [页码/关键词]` | 分页浏览或搜索角色卡；同名角色显示稳定序号区分 |
| `/switch 序号` `/switch 角色名` | 切换到角色（支持序号、完整名、前缀） |
| `/status` | 当前角色、聊天文件和实际用户轮数 |
| `/chats` | 按最近活动列出当前角色的聊天 |
| `/chat 序号` | 只切换微信 Bot 当前聊天，不强制浏览器跳转 |
| `/new` | 新建共享聊天并切换过去，不删除旧记录 |
| `/sync` | 查看尚未主动推送的浏览器端完整轮次 |

### 对话控制

| 命令 | 说明 |
|------|------|
| `/continue [方向]` | AI 续写，可指定方向 |
| `/retry` `/r` | 重新生成上一条回复 |
| `/swipe` | 查看备选回复 |
| `/stop` | 停止当前生成；被取消轮次不写入聊天文件 |

### 记忆

| 命令 | 说明 |
|------|------|
| `/memory [内容]` | 不带内容时查看记忆，带内容时设置记忆 |

### 系统

| 命令 | 说明 |
|------|------|
| `/help` | 帮助 |
| `/help advanced` | 显示低频高级命令 `/memory`、`/sync` |

---

## 管理与诊断

SillyTavern 扩展面板提供模型连通测试、iLink 立即重试和脱敏诊断报告复制。立即重试只唤醒现有轮询退避，不会创建第二个轮询任务。

- `GET /api/plugins/st-wechat/health`：最小健康状态，仅返回是否在线、连接状态和运行时长。
- `GET /api/plugins/st-wechat/diagnostics`：脱敏运行报告，不包含 API key、endpoint、微信身份、角色名、聊天内容或内部路径。
- 面板统计仅保存在内存中，容器重启后清零；优先使用模型接口返回的 token usage，缺失时标记为估算值，不默认计算金额。
- Bot 端只读取 SillyTavern 当前模型配置，不提供修改 provider、模型、endpoint、密钥或生成参数的命令。

引用、图片理解和语音转写尚未加入当前版本；收到不支持的非文本消息时，Bot 会在下载、
聊天写入和模型调用前停止，并返回明确的文字提示。

---

## 切换角色时

`/switch Alisa` 或 `/switch 3`：

- 如果该角色**已有聊天记录**：优先恢复 Bot 上次明确选择的聊天，否则选择真正最近活动的聊天
- 如果该角色**没有任何聊天**：新建标准共享聊天，直接保存并发送角色卡 `first_mes`，不会调用 LLM 或写入空用户消息

不同角色各自维护独立的对话历史，可来回切换互不干扰。

`/switch` 恢复历史时只发送一条合并消息，最近各条消息之间使用空行分隔。轮次按
用户消息数量计算；角色开场白不算一轮。

如果 Bot 当前聊天在浏览器中被删除，Bot 在下一条消息前重新校验文件：

- 仍有其他聊天时，自动切换到最近仍存在的聊天并明确提示。
- 没有任何聊天时，创建新聊天、保存 `first_mes` 并明确提示。

触发恢复的这条普通消息不会发送给模型，避免用户尚未确认目标聊天就把内容写入
错误文件；确认提示中的聊天后重新发送即可。

---

## 数据同步

| 数据 | 酒馆 → 微信 | 微信 → 酒馆 |
|------|------------|------------|
| 角色卡 | ✅ 自动读取 | — |
| 聊天记录 | ✅ 共享文件、增量通知、生成前重读 | ✅ 每轮完成后写入共享 JSONL |
| 世界书 | ✅ 自动匹配注入 | — |
| 记忆 | ✅ 读取聊天文件 summary | `/memory` 写入 |
| API 配置 | ✅ 自动（或 config.yaml 覆盖） | — |

浏览器和微信各自保留当前聊天。只有两端恰好打开同一文件时才同步当前界面；
非当前文件只更新目录和修订状态，不打断正在进行的聊天。微信更新当前文件后，
浏览器使用 SillyTavern 的当前聊天重载接口自动读取新内容，不刷新整个网页，
因此不会返回角色或聊天选择界面；浏览器正在生成或编辑时会延迟到操作完成后再同步。
同步保证最终一致，不会强制两个界面切换到同一个聊天。

`syncMode` 控制浏览器更新推送：

- `off`：不主动推送。
- `notify`：默认，合并完整轮次并发送有限预览。
- `full`：发送本次检测到的完整新增内容。

同一聊天文件始终使用其真实历史。需要脱离旧上下文时使用 `/new`
创建新聊天，不在原文件内制造模型看不到、用户却可见的历史断层。

---

## 长连接与异常恢复

- **Token 有效期**：iLink 通常持续数天，由服务端决定
- **自动重连**：临时网络异常会保留现有凭据并继续重试，不会立即要求重新扫码
- **Token 过期**：服务端明确返回 `ret: -14` 后，才清理失效凭据并触发重新扫码
- **容器重启**：自动从 SillyTavern 持久化数据目录中的 `data/default-user/st-wechat/.wechat_creds.json` 恢复凭据
- **旧版迁移**：首次启动时会自动把插件目录中的旧 `.wechat_creds.json` 复制到持久化数据目录；完成迁移前不要删除旧插件目录
- **网络断连**：指数退避重试

---

## 目录结构

```
st-wechat/
├── config.yaml              ← 模型/端点覆盖（可选）
├── package.json
├── .gitignore
├── README.md
├── src/
│   ├── index.js             ← 插件入口，部署 UI 扩展
│   ├── ilink.js             ← iLink 协议（扫码/长轮询/收发）
│   ├── config.js            ← ST 配置加载
│   ├── adapter.js           ← 角色加载 + LLM API
│   ├── session.js           ← 会话持久化、同步与命令路由
│   ├── owner-store.js       ← 单所有者认领状态
│   ├── chat-registry.js     ← 角色/聊天选择和同步游标
│   ├── chat-coordinator.js  ← 同文件队列、租约和修订冲突
│   ├── chat-tracker.js      ← 增量文件变化跟踪
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

登录凭据不再保存在插件目录内，而是保存在 SillyTavern 用户数据目录：

```text
data/default-user/st-wechat/.wechat_creds.json
```

该文件包含登录信息，请勿提交、分享或手动修改。只要 Compose 中的
`/home/node/app/data` 仍映射到 Docker 宿主机的持久化目录，更新或替换插件文件不会影响登录状态。

同一目录还会保存：

```text
data/default-user/st-wechat/owner.json
data/default-user/st-wechat/chat-registry.json
```

前者只保存所有者微信身份的加盐摘要，后者只保存相对聊天路径、选择和同步游标；二者都不保存聊天正文、API key 或 iLink token。

---

## 依赖

- Node.js ≥ 18
- 零 npm 依赖（使用 Node 内置 `fetch`、`fs`、`path`、`crypto`）

## 更多文档

- Docker 生产部署、备份、升级和回滚见 [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)。
- 完整配置项见 [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md)，常见故障见
  [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md)。
- 参与开发和运行自动化测试见 [`CONTRIBUTING.md`](CONTRIBUTING.md)，版本变化见 [`CHANGELOG.md`](CHANGELOG.md)。

## 兼容性与安全边界

- 默认跟随 SillyTavern 当前模型与生成配置；插件默认关闭 thinking，可按需显式开启。
- `dataRoot` 现已真正生效，但必须指向 SillyTavern 根目录内部。
- 世界书只加载明确的全局书、当前角色绑定书和角色卡内嵌书，不再默认混入全部世界书。
- 产品采用单所有者模型；首次部署需在本地扩展面板查看六位认领码，并在微信发送 `/claim 六位码`。
- 同一所有者的普通消息按顺序处理，默认最多允许 20 条正在处理或等待的消息；超过
  `maxQueuedMessages` 时本条不会调用模型，Bot 会提示稍后重新发送。`/status` 等只读命令不受该队列阻塞。
- 二维码和认领码接口不另开端口，继承 SillyTavern 的访问控制。SillyTavern 对外访问必须保留
  ST IP 白名单，并启用 Basic Auth、用户账户或等价的可信反向代理鉴权；不要直接暴露 8000 端口。
- 模型与协议错误仅对外显示错误分类、操作建议和诊断编号；日志中的微信 userId 使用稳定伪匿名。
- `/bind` 和微信专属聊天模型已取消。旧聊天中的 `wechat_user`、`wechat_chat` 字段不会删除，但不再参与选择或权限判断。
- 旧聊天会直接进入共享聊天列表；首次选择按真实最近活动时间确定，不会复制或改写历史文件。
- 聊天元数据更新会原样保留系统消息、未知字段和无法识别的行。
