# 配置参考

默认 `configurationMode: auto`。插件跟随 SillyTavern 当前聊天补全来源、端点、模型、
对应密钥槽、温度、输出长度和上下文长度。Custom 连接会读取 Custom URL、模型和
Custom 密钥槽，不会误用同一服务商的内置密钥槽。

只有需要让 Bot 使用独立配置时才选择 `configurationMode: override`。此模式要求同时显式配置
`provider`、`endpoint` 和 `model`，并使用插件中的生成参数。无论哪种模式，密钥均按最终连接
精确选择，不跨密钥槽或服务商回退。

## 配置项

| 配置项 | 默认值 | 说明 |
|---|---:|---|
| `configurationMode` | `auto` | `auto` 跟随酒馆；`override` 使用插件显式配置 |
| `provider` | — | 仅用于 `override`；支持 `deepseek`、`openai`、`custom`、`anthropic`、`gemini`、`openrouter`、`mistral`、`groq` 或 `ollama` |
| `endpoint` | — | 仅用于 `override`；API 根地址 |
| `model` | — | 仅用于 `override`；模型 ID，Bot 不在微信端修改该值 |
| `secretSource` | 与 provider 相同 | 仅用于 `override`；指定 SillyTavern 密钥槽，例如 `custom` |
| `thinking` | `disabled` | `enabled` 或 `disabled`；仅对适配器支持的模型生效 |
| `temperature` | `0.9` | `override` 模式的生成温度；`auto` 从酒馆读取 |
| `maxOutputTokens` | `1200` | `override` 模式的最大输出 token；`auto` 从酒馆读取，硬上限 65536 |
| `maxContextTokens` | `64000` | `override` 模式的上下文预算；`auto` 从酒馆读取，硬上限 2000000 |
| `charsPerToken` | `3` | 无精确 tokenizer 时的估算系数；调小会更保守 |
| `requestTimeoutMs` | `90000` | 单次 LLM 请求超时，单位毫秒 |
| `maxQueuedMessages` | `20` | 单所有者普通消息的处理与等待总上限；只读命令不占用 |
| `syncMode` | `notify` | `off`、`notify` 或 `full`；只影响微信展示投影，不改共享聊天或 LLM 上下文 |
| `worldInfoBudgetTokens` | `0` | 世界书独立预算；`0` 表示只受总上下文预算约束 |
| `dataRoot` | `../../data/default-user` | 从插件目录出发的 ST 用户数据目录，解析后必须仍在 SillyTavern 根目录内 |

未知字段会被忽略。无效枚举或数值会使用经过校验的默认值或 ST 当前设置；启动日志只显示
脱敏后的最终 provider、model 和数据根目录，不输出 API key。

## 推荐的自动模式

```yaml
configurationMode: auto
thinking: disabled
charsPerToken: 3
requestTimeoutMs: 90000
maxQueuedMessages: 20
syncMode: notify
worldInfoBudgetTokens: 0
dataRoot: ../../data/default-user
```

此时只需在 SillyTavern 中配置并连接模型。内置 DeepSeek 来源会读取 DeepSeek 密钥槽；
“自定义（兼容 OpenAI）”来源会读取 Custom 密钥槽，无需在插件中手动指定。

## 独立覆盖示例

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

覆盖模式仍只从 SillyTavern 的指定密钥槽读取密钥。不要把 API key 直接写入本文件。
通过 SillyTavern 的密钥管理界面保存，并在扩展面板使用
“测试模型连接”验证最终解析结果。

## 同步模式

- `off`：不主动把浏览器新增完整轮次通知微信；共享聊天文件仍保持一致。
- `notify`：发送单条有界通知，优先保留最新完整轮次，适合日常使用。
- `full`：发送更多正文，但仍受微信总投影预算约束；超长内容会明确标记截断。

无论选择哪种模式，浏览器与 Bot 只有在稳定角色 ID 和 chatId 同时一致时才互相通知，
不同角色或不同聊天文件不会被强制切换或同步到当前微信窗口。
