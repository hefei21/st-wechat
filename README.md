# ST WeChat Bot

**酒馆角色卡 → 微信对话**  
通过微信 iLink 协议，在微信中与 SillyTavern 角色卡直接聊天。

---

## 适用范围

- 已验证兼容基线：SillyTavern `1.16.0`、Node.js 18+。
- 支持原生进程和 Docker 部署；Docker 必须持久化 `config`、`data`、`plugins` 与第三方 UI
  扩展四个目录。
- 当前采用**单所有者**模型，适合个人使用；它不是多人共享 Bot 或公开聊天服务。
- 默认只处理文字消息。引用、图片理解、语音转写、视频和文件输入尚未支持。

升级 SillyTavern、修改数据目录或开放外网访问前，请先阅读
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)。

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
- 同一个微信 Bot 可通过 `/switch` 在酒馆角色卡之间切换
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

### 1. 安装插件

下载 Release 中的插件 ZIP，解压后将其中的 `st-wechat/` 整个目录放到酒馆的 `plugins/`
下。也可以从源码复制同名目录。最终必须是单层结构：

```
SillyTavern/
└── plugins/
    └── st-wechat/
        ├── package.json
        ├── config.yaml
        ├── src/
        │   └── index.js
        └── ui-extension/
            └── manifest.json
```

不要把旧版本改名后继续留在 `plugins/` 下；SillyTavern 可能同时扫描新旧目录并产生
`plugin ID is already in use`。升级备份应移到 `plugins/` 之外，具体见部署文档。

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

修改的是 SillyTavern 根目录中的配置，不是插件自己的 `config.yaml`。修改后需要重启
SillyTavern。

### 4. 确认前端扩展目录

如果使用 Docker，至少确认以下四个容器目录均已持久化：

```yaml
volumes:
  - ./config:/home/node/app/config
  - ./data:/home/node/app/data
  - ./plugins:/home/node/app/plugins
  - ./public/scripts/extensions/third-party:/home/node/app/public/scripts/extensions/third-party
```

可以直接参考 [`deploy/production/compose.yml`](deploy/production/compose.yml)。已有部署使用
绝对路径或命名卷时无需搬迁，只需确保四个容器目标一致且可写。

非 Docker 用户不需要配置上述挂载。请确认 SillyTavern 安装目录下存在或允许程序创建：

```text
public/scripts/extensions/third-party/
```

插件启动时会递归创建缺失的 `third-party/st-wechat/` 目录，并把随插件提供的浏览器扩展复制
进去；通常无需提前手动创建。如果目录没有自动生成，请手动创建上述路径，并确认运行
SillyTavern 的系统账号对该目录具有读写权限。启动日志出现
`UI 扩展已部署: .../public/scripts/extensions/third-party/st-wechat` 才表示前端部署成功。

### 5. 重启酒馆

```bash
docker compose restart sillytavern
# 或直接重启进程
```

重启后打开 SillyTavern 的「扩展」→ **ST WeChat Bot**。首次使用先扫码登录，再查看六位
所有者认领码，并从准备长期使用的微信账号发送 `/claim 六位码`。认领后其他微信身份默认
无法访问角色、聊天或模型。

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
| `/sync` | 查看尚未成功推送的浏览器更新；不是 `off` 模式下的手动同步队列 |

### 对话控制

| 命令 | 说明 |
|------|------|
| `/continue [方向]` | 原位续写上一条 AI 回复，可指定方向；不新建 user 消息或增加轮次 |
| `/retry` | 重新生成上一条回复，并保留原回复作为 swipe |
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

普通微信轮次由 Bot 直接写入 JSONL，浏览器只投影界面，不会再整体保存一遍文件。
`/retry`、`/swipe` 等原位改写完成后，浏览器会自动重载原 chatId，而不是把替换结果追加成
重复消息。旧标签页在生成前发现 revision 过期时也会先重载，避免覆盖对端的新记录。

`syncMode` 控制浏览器更新推送：

- `off`：完全关闭浏览器→微信通知，不创建可供 `/sync` 补取的长期队列。
- `notify`：默认，合并完整轮次并发送有限预览。
- `full`：发送本次检测到的完整新增内容。

`/sync` 仅用于查看 `notify` 或 `full` 模式下尚未成功主动推送的更新，例如启动恢复、发送
上下文暂不可用或通知重试期间的待处理事件；正常情况下无需手动调用。

同一聊天文件始终使用其真实历史。需要脱离旧上下文时使用 `/new`
创建新聊天，不在原文件内制造模型看不到、用户却可见的历史断层。

---

## 长连接与异常恢复

- **Token 有效期**：iLink 通常持续数天，由服务端决定
- **自动重连**：临时网络异常会保留现有凭据并继续重试，不会立即要求重新扫码
- **Token 过期**：服务端明确返回 `ret: -14` 后，才清理失效凭据并触发重新扫码
- **容器重启**：自动从当前 `dataRoot` 下的 `st-wechat/.wechat_creds.json` 恢复凭据
- **旧版迁移**：若凭据仍只在旧插件根目录，升级时按部署文档把该文件临时复制到新版
  插件根目录；首次启动会迁移到持久化 `dataRoot`，确认成功后再移除临时副本
- **网络断连**：指数退避重试

---

## 插件包核心结构

```
st-wechat/
├── config.yaml              ← 模型/端点覆盖（可选）
├── package.json
├── README.md
├── src/
│   ├── index.js             ← 插件入口，部署 UI 扩展
│   ├── ilink.js             ← iLink 协议（扫码/长轮询/收发）
│   ├── config.js            ← ST 配置加载
│   ├── adapter.js           ← LLM API
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
<dataRoot>/st-wechat/.wechat_creds.json
```

该文件包含登录信息，请勿提交、分享或手动修改。只要 Compose 中的
`/home/node/app/data` 仍映射到 Docker 宿主机的持久化目录，更新或替换插件文件不会影响登录状态。

同一目录还会保存：

```text
<dataRoot>/st-wechat/owner.json
<dataRoot>/st-wechat/chat-registry.json
```

默认 `dataRoot` 是 `data/default-user`；多用户或自定义目录安装应以插件配置的实际路径为准。
`owner.json` 只保存所有者微信身份的加盐摘要，`chat-registry.json` 只保存相对聊天路径、
选择和同步游标；二者都不保存聊天正文、API key 或 iLink token。

---

## 依赖

- Node.js ≥ 18
- 零 npm 依赖（使用 Node 内置 `fetch`、`fs`、`path`、`crypto`）

## 许可证

本项目采用 [GNU Affero General Public License v3.0](https://www.gnu.org/licenses/agpl-3.0.html)
（SPDX：`AGPL-3.0-only`）。部署修改版并通过网络向用户提供服务时，请同时遵守该许可证的
源码提供义务。

## 更多文档

- Docker 生产部署、备份、升级和回滚见 [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)。
- 完整配置项见 [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md)，常见故障见
  [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md)。
- 参与开发和运行自动化测试见 [`CONTRIBUTING.md`](CONTRIBUTING.md)，版本变化见 [`CHANGELOG.md`](CHANGELOG.md)。
- 安全问题的私密报告方式和部署责任边界见 [`SECURITY.md`](SECURITY.md)。

## 兼容性与安全边界

- 默认跟随 SillyTavern 当前模型与生成配置；插件默认关闭 thinking，可按需显式开启。
- `dataRoot` 现已真正生效，但必须指向 SillyTavern 根目录内部。
- 世界书只加载明确的全局书、当前角色绑定书和角色卡内嵌书，不再默认混入全部世界书；
  当前实现覆盖关键词、常驻、secondary keys、概率、scan depth、depth 和预算等常用字段，
  尚未承诺完整复现 SillyTavern 的所有高级世界书行为。
- 产品采用单所有者模型；首次部署需在本地扩展面板查看六位认领码，并在微信发送 `/claim 六位码`。
- 同一所有者的普通消息按顺序处理，默认最多允许 20 条正在处理或等待的消息；超过
  `maxQueuedMessages` 时本条不会调用模型，Bot 会提示稍后重新发送。`/status` 等只读命令不受该队列阻塞。
- 二维码和认领码接口不另开端口，继承 SillyTavern 的访问控制。SillyTavern 对外访问必须保留
  ST IP 白名单，并启用 Basic Auth、用户账户或等价的可信反向代理鉴权；不要直接暴露 8000 端口。
- 模型与协议错误仅对外显示错误分类、操作建议和诊断编号；日志中的微信 userId 使用稳定伪匿名。
- `/bind` 和微信专属聊天模型已取消。旧聊天中的 `wechat_user`、`wechat_chat` 字段不会删除，但不再参与选择或权限判断。
- 旧聊天会直接进入共享聊天列表；首次选择按真实最近活动时间确定，不会复制或改写历史文件。
- 聊天元数据更新会原样保留系统消息、未知字段和无法识别的行。
