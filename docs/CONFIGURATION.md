# 配置参考

插件先读取 SillyTavern 当前设置和聊天补全预设，再用插件根目录的 `config.yaml` 覆盖。
最终 provider 确定后，只读取与该 provider 对应的密钥，不跨服务商回退。

## 配置项

| 配置项 | 默认值 | 说明 |
|---|---:|---|
| `provider` | `deepseek` | `deepseek`、`openai`、`custom`、`anthropic`、`gemini`、`openrouter`、`mistral`、`groq` 或 `ollama` |
| `endpoint` | `https://api.deepseek.com` | API 根地址；优先于预设和当前 Custom URL |
| `model` | `deepseek-v4-flash` | 模型 ID；Bot 不在微信端修改该值 |
| `secretSource` | 与 provider 相同 | 仅在密钥实际保存在另一 ST 密钥槽时显式指定，例如 `custom` |
| `thinking` | `disabled` | `enabled` 或 `disabled`；仅对适配器支持的模型生效 |
| `temperature` | `0.9` | 生成温度；必须为有效数字 |
| `maxOutputTokens` | `1200` | 单次回复最大输出 token，必须为正整数 |
| `maxContextTokens` | `64000` | 构造提示词时的总上下文预算，必须为正整数 |
| `charsPerToken` | `3` | 无精确 tokenizer 时的估算系数；调小会更保守 |
| `requestTimeoutMs` | `90000` | 单次 LLM 请求超时，单位毫秒 |
| `maxQueuedMessages` | `20` | 单所有者普通消息的处理与等待总上限；只读命令不占用 |
| `syncMode` | `notify` | `off`、`notify` 或 `full`；只影响微信展示投影，不改共享聊天或 LLM 上下文 |
| `worldInfoBudgetTokens` | `0` | 世界书独立预算；`0` 表示只受总上下文预算约束 |
| `dataRoot` | `../../data/default-user` | 从插件目录出发的 ST 用户数据目录，解析后必须仍在 SillyTavern 根目录内 |

未知字段会被忽略。无效枚举或数值会使用经过校验的默认值或 ST 当前设置；启动日志只显示
脱敏后的最终 provider、model 和数据根目录，不输出 API key。

## DeepSeek 推荐配置

```yaml
provider: deepseek
endpoint: https://api.deepseek.com
model: deepseek-v4-flash
thinking: disabled
temperature: 0.9
maxOutputTokens: 1200
maxContextTokens: 64000
charsPerToken: 3
requestTimeoutMs: 90000
maxQueuedMessages: 20
syncMode: notify
worldInfoBudgetTokens: 0
dataRoot: ../../data/default-user
```

如果密钥是在 SillyTavern 的 Custom 连接中保存：

```yaml
secretSource: custom
```

不要把 API key 直接写入本文件。通过 SillyTavern 的密钥管理界面保存，并在扩展面板使用
“测试模型连接”验证最终解析结果。

## 同步模式

- `off`：不主动把浏览器新增完整轮次通知微信；共享聊天文件仍保持一致。
- `notify`：发送单条有界通知，优先保留最新完整轮次，适合日常使用。
- `full`：发送更多正文，但仍受微信总投影预算约束；超长内容会明确标记截断。

无论选择哪种模式，浏览器与 Bot 只有在稳定角色 ID 和 chatId 同时一致时才互相通知，
不同角色或不同聊天文件不会被强制切换或同步到当前微信窗口。
