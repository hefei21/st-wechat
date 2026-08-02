# Changelog

本项目遵循语义化版本。所有面向用户的重要变化都会记录在此文件中。

## [Unreleased]

## [1.0.0] - 2026-08-02

### Added

- 单所有者微信 iLink 登录、角色选择、共享聊天、世界书、记忆与主要对话命令。
- 浏览器与微信最终一致同步、同聊天生成租约、持久化事件箱及容器重启恢复。
- 管理面板的连接状态、模型测试、立即重试、最小健康状态和脱敏诊断。
- 长消息语义投影、非文本明确降级、自然分片和停止生成。
- 独立 Docker 测试环境、生产 Compose 基线、自动化测试及 CLI/图形界面回滚流程。

### Changed

- 角色发现只枚举 SillyTavern 已安装的 PNG 角色卡，裸 JSON 不再形成 Bot 可见幽灵角色。
- 浏览器与 Bot 使用同一组真实聊天文件，各自保留当前选择；`/bind` 和微信专属聊天取消。
- 模型与生成参数统一读取 SillyTavern/插件配置，微信端不提供远程修改命令。
- 默认自动跟随 SillyTavern 当前连接、精确密钥槽和生成参数；需要独立配置时可显式启用覆盖模式。

### Fixed

- 修复 SillyTavern 1.16 将聊天补全配置保存在 `oai_settings` 内时，自动模式回退到默认模型并找不到 Custom 密钥的问题。
- 修复浏览器与微信穿插生成时输入、回复被覆盖、丢失、重复或顺序错乱的问题；聊天文件改为
  来源端唯一持久化，并在旧 revision 生成前自动重载原 chatId。
- 修复 `/retry` 与 `/swipe` 已改写 JSONL 但浏览器仍按追加消息处理的问题；现在通过持久化
  reload 事件刷新同一聊天，并保留 swipes 与 `swipe_id`。
- 修复容器重启后必须先完成一轮对话，`/status` 才能恢复当前角色和聊天的问题。
- 修复 iLink 恢复凭据时额外短轮询干扰主长轮询、立即重试创建重复轮询和协议响应
  Content-Type 不标准导致误判的问题。
- 修复无关世界书混入、关键词条目不激活、depth 计算及常用 secondary/probability/scan depth
  语义不一致的问题。

### Removed

- 移除 `/clear`、`/clear-context`、`/reload` 和 `/imp`，避免隐藏历史分叉、远程改配置和身份混淆。

### Security

- 凭据迁移到持久化 data 目录并限制文件权限；二维码和认领码不写日志。
- 日志伪匿名化微信身份，上游错误正文和内部路径不对外返回。
- 管理写操作启用 CSRF 防护，健康接口不暴露用户、角色、聊天或凭据。

[Unreleased]: https://github.com/hefei21/st-wechat/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/hefei21/st-wechat/releases/tag/v1.0.0
