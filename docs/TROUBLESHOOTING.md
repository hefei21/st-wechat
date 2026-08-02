# 故障排查

先记录发生时间和扩展面板中的脱敏诊断编号。不要发送二维码、API key、token、完整微信
userId、真实聊天正文或 Docker 主机内部绝对路径。

## Bot 显示已登录但收不到消息

1. 查看面板“连接状态”，区分“凭据存在”和“实时轮询在线”。
2. 点击“立即重试”只会唤醒现有轮询，不会创建第二个连接。
3. 日志出现 `auth` 或明确要求扫码时，旧凭据已失效，需要重新登录。
4. 日志持续出现“非 JSON 响应”通常是 iLink 上游、代理或网络返回了 HTML 页面，不代表
   SillyTavern 本地登录状态有效。保留脱敏诊断后检查 Docker 主机网络和代理。

## 日志提示 plugin ID already in use

`plugins/` 下同时存在两份 ID 为 `st-wechat` 的插件，常见原因是把旧版仅改名为
`st-wechat.previous` 后仍留在原目录。停止 SillyTavern，把旧版完整移动到 `plugins/` 之外的
备份目录，只保留一个 `plugins/st-wechat/`，然后重新启动。不要通过删除唯一旧版来处理，
回滚副本应保存在不被插件扫描的位置。

## 扩展列表中没有 ST WeChat Bot

1. 检查启动日志是否出现 `UI 扩展已部署: .../public/scripts/extensions/third-party/st-wechat`。
2. 如果出现 `UI 扩展部署失败`，确认运行 SillyTavern 的系统账号可以写入
   `public/scripts/extensions/third-party/`。非 Docker 安装若没有该路径，可手动逐层创建。
3. Docker 安装确认该目录已正确挂载且容器内可写；非 Docker 安装无需配置挂载。
4. 修复目录或权限后重启 SillyTavern，再强制刷新浏览器。只有复制前端文件成功，扩展面板
   才会出现；仅加载服务端插件还不够。

## 局域网访问 Forbidden

这是 SillyTavern 白名单，不是插件错误。把浏览器实际来源 IP 或可信子网加入 ST 白名单；
经反向代理、隧道或容器网关访问时，日志可能显示 Docker 网桥地址。不要为了省事把未经鉴权的
8000 端口直接暴露公网。

## 模型连接失败或提示没有 API key

1. 在 SillyTavern 本身确认当前聊天补全来源、模型和密钥可用。
2. 默认 `configurationMode: auto` 会跟随当前来源；Custom 连接只读取 Custom 密钥槽，
   内置 DeepSeek 来源只读取 DeepSeek 密钥槽，不会互相兜底。
3. 若使用 `configurationMode: override`，检查 `provider`、`endpoint`、`model` 和
   `secretSource` 是否与 SillyTavern 中实际保存密钥的位置一致。
4. 查看 [`CONFIGURATION.md`](CONFIGURATION.md) 的模式说明，并在面板点击“测试模型连接”；
   错误只会返回分类和诊断编号，完整上游响应不会暴露。

## 浏览器与微信没有互相通知

- 两端必须同时选择相同稳定角色和相同 chatId；只存在同名角色或历史路径相同不算共享当前聊天。
- `syncMode: off` 完全关闭浏览器→微信通知，也不会积压供 `/sync` 手动补取的队列；改为
  `notify` 后重启插件。
- 浏览器正在流式生成或编辑时，微信增量会等待安全时机再合并，不应整页刷新或跳回聊天列表。
- 用 `/status` 查看 Bot 当前聊天，用 `/chats` 与 `/chat` 明确切换，不使用已移除的 `/bind`。

如果 `/retry` 或 `/swipe` 后浏览器没有更新，确认页面仍打开相同 chatId，并查看控制台是否有
扩展加载错误。正常行为是重载同一聊天，不是追加一条新 assistant 消息，也不会返回聊天列表。
升级插件后若浏览器仍运行旧扩展代码，先关闭其他 SillyTavern 标签页，再用浏览器强制刷新并
确认扩展版本；不要反复执行命令来“推进同步”。

## 发送消息提示上一轮没有有效正文

当前 JSONL 末尾存在未完成的 user 消息或仅有思考、没有角色正文。先在浏览器完成或重试该轮，
确认出现可见角色正文后再从微信发送。插件不会把两个未完成请求合并给模型。

## 容器重启后要求重新扫码或重新选角色

检查 `data` 是否持久化到 `/home/node/app/data`，并确认日志没有 `EACCES`。以下目录必须保留：

```text
<dataRoot>/st-wechat/
```

它包含 iLink 凭据、所有者状态、聊天注册表和事件箱。真实 iLink token 过期仍可能要求重新扫码，
但普通容器重启不应丢失本地状态。

## 修改配置后仍使用旧模型或旧参数

插件配置和 SillyTavern 模型配置在服务端插件启动时读取。修改后重启 SillyTavern，再在扩展
面板点击“测试模型连接”。`configurationMode: auto` 读取 `dataRoot` 指向用户的当前配置；
多用户安装如果仍指向 `default-user`，请改为实际用户目录。微信端没有 `/reload` 或模型修改命令。

## 图片、语音或文件没有进入角色聊天

这是当前明确的产品边界。非文本消息会在协议入口停止，不下载、不写聊天、不调用模型，并
提示改用文字。图片理解、引用和语音转写需要另行立项，不通过占位文本伪装成已支持能力。

## 权限或健康检查失败

1. 确认四个宿主目录存在并分别挂载到 config、data、plugins 和 UI extension 目标。
2. 日志搜索 `EACCES`、`read-only file system` 和 `permission denied`。
3. 使用与 [`DEPLOYMENT.md`](DEPLOYMENT.md) 一致的健康检查；首次启动允许 60 秒预热。
4. 不通过给整个宿主机共享目录开放匿名完全控制来绕过权限，应只给容器运行身份必要读写权限。
