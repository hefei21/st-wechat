# Docker 生产部署、升级与回滚

本文适用于通过 Docker Compose 部署 SillyTavern 的环境。既可以使用 Docker Compose CLI，
也可以在 Portainer、NAS 容器管理器等图形界面中执行等价操作。生产模板位于
[`deploy/production/compose.yml`](../deploy/production/compose.yml)，测试模板位于
[`deploy/test/compose.yml`](../deploy/test/compose.yml)。

## 1. 当前固定版本

- SillyTavern 镜像：`ghcr.io/sillytavern/sillytavern:1.16.0`
- 该版本是当前经过验证的兼容性基线；升级前应先在独立环境验证插件主链路。
- 不使用 `latest`。升级到新版本必须先在独立测试环境验证，再修改生产模板中的标签。
- 如需供应链级完全复现，可用 `docker image inspect` 或镜像管理界面记录与 CPU 架构匹配的
  digest，并把 `image` 改成 `镜像:标签@sha256:...`。不得复制另一架构的 digest。

## 2. 目录布局

把生产 Compose 放在 SillyTavern 持久化根目录，保持以下结构：

```text
sillytavern/
├── compose.yml
├── config/
├── data/
├── plugins/
│   └── st-wechat/
│       ├── package.json
│       └── src/
└── public/
    └── scripts/extensions/third-party/
        └── st-wechat/
```

模板使用相对 bind mount。已有部署如果使用命名卷或分散的绝对路径，无需为了套用模板而
移动生产数据；逐项确认容器目标仍为 `/home/node/app/config`、`data`、`plugins` 和
`public/scripts/extensions/third-party` 即可。

## 3. 升级前备份

1. 停止生产服务：`docker compose stop sillytavern`，或在容器管理界面点击停止。
2. 确认没有进程正在写入 `config`、`data`、`plugins` 和 UI extension 目录。
3. 创建带日期的备份目录，例如 `backups/2026-08-01-before-1.0/`。
4. 完整复制以下内容，不只复制插件目录：
   - `config/`
   - `data/`
   - `plugins/`
   - `public/scripts/extensions/third-party/`
   - 当前正在使用的 Compose 文件
5. 确认备份中存在 `data/default-user`、角色卡、聊天、世界书以及 `plugins/st-wechat/package.json`。
6. `data/default-user/st-wechat/` 含 iLink 凭据和所有者状态，只保存在受控备份中，不上传
   公共网盘、不提交 Git，也不要作为问题截图发送。

CLI 用户可使用自己熟悉且能保留权限和时间戳的备份工具；图形界面用户执行等价的停止、
复制和核对操作。只有完成备份并记录旧镜像标签或 digest 后，才进入升级。

## 4. 升级

1. 保持生产服务停止。
2. 核对新插件 ZIP 的 SHA-256。
3. 把旧 `plugins/st-wechat/` 重命名为 `st-wechat.previous/`，不要立即删除。
4. 解压新包，确认最终是单层 `plugins/st-wechat/package.json`，没有多套一层 ZIP 文件夹。
5. 确认 UI extension 挂载目录允许容器写入；插件启动时会同步匹配的 UI 文件。
6. 更新 Compose。首次迁移只改变已经核对的镜像、重启策略、健康检查和挂载，不同时更改
   网络、认证与数据根目录。
7. 执行 `docker compose up -d`，或在图形界面部署/启动项目。
8. 用 `docker compose ps`、`docker inspect` 或管理界面等待健康状态变为正常；
   `start_period` 为 60 秒，低性能设备首次启动可能更慢。

## 5. 启动后检查

依次确认：

1. 容器没有反复重启，健康状态为正常。
2. `docker compose logs sillytavern` 或容器日志中没有 `EACCES`、只读文件系统、挂载缺失或插件加载失败。
3. 通过原有受控入口打开 SillyTavern，角色、聊天、世界书和 LLM 配置仍在。
4. ST WeChat 面板能打开，iLink 无需重新扫码；如果凭据真实过期，界面应明确要求重新登录。
5. 浏览器新建一个可丢弃聊天并发送一轮，再用微信 `/status`、`/list`、`/switch` 和普通消息
   验证主链路。
6. 重启容器，确认聊天、所有者状态和 iLink 登录仍能恢复。
7. 检查 UI extension 目录与 `data/default-user/st-wechat/` 均可正常更新，且日志无权限错误。

第 2、3、6、7 项共同用于检查 config、data、plugins 与 UI extension 四个挂载的读写权限。

## 6. 回滚

任何一项出现数据缺失、持续不健康、插件无法加载、扫码状态异常或双端主链路阻断时：

1. 立即停止生产服务，不继续发送测试消息。
2. 把当前故障目录改名保留，例如 `st-wechat.failed-时间/`，不要覆盖唯一故障现场。
3. 恢复升级前 Compose，并把镜像标签改回记录的旧值。
4. 优先只恢复 `plugins/st-wechat/` 与对应 UI 扩展；如果配置或数据已经发生不兼容变化，
   再从同一次备份整体恢复 `config/`、`data/`、`plugins/` 和 UI extension。
5. 执行 `docker compose up -d` 或在管理界面启动旧项目，重复“启动后检查”的第 1～6 项。
6. 回滚成功前保留备份与故障目录；确认稳定后再决定是否清理，不永久删除唯一副本。

## 7. 网络暴露选择

模板默认使用 `8000:8000`，适合受控局域网或 VPN。它不代表允许公网访问：防火墙、云安全组
或路由器不得把 8000 直接暴露到互联网。

只有满足以下条件时才把端口改成 `127.0.0.1:8000:8000`：

1. 已配置 HTTPS 反向代理或安全隧道；
2. 代理与 SillyTavern 位于同一 Docker 主机，并能连接宿主机回环端口；
3. 切换后不再需要其他设备直接访问宿主机的 8000 端口；
4. 已验证 SillyTavern 的可信代理和 forwarded headers 配置。

如果反向代理自身运行在容器中，通常应通过共享 Docker 网络访问 `sillytavern:8000`，而不是
依赖宿主机回环地址。部分 NAS 或托管平台的内置远程访问也不是从回环地址发起请求；切换
绑定前应先确认其网络模型。
