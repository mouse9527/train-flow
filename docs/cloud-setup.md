# CloudBase 配置

CloudBase 同步是可选能力。没有云环境、没有网络、未获允许或云函数暂时失败时，本机计划、训练、记录与统计仍可正常使用。

## 1. 前置条件

- 已注册并完成主体设置的小程序账号。
- 本机 `project.config.json` 临时使用该账号的真实 AppID；公共分支继续保留 `touristappid`，提交前检查并排除这项本机替换。
- 已在微信开发者工具中开通一个云开发环境，并把它设为当前项目使用的默认环境。
- 有权限创建集合、索引、数据库安全规则、云函数和函数环境变量。

AppID、环境 ID 和 OpenID 不是应用密钥，但仍属于部署标识，不应写入公共仓库或验收日志。函数密钥必须只保存在 CloudBase 环境变量/Secret 管理中。

## 2. 创建集合和索引

按下表创建服务端集合。所有业务访问都通过云函数完成，小程序客户端不直接读写这些集合。

| 集合 | 唯一键或查询索引 |
| --- | --- |
| `tf_accounts` | `ownerId` 唯一 |
| `tf_entities` | `ownerId + entityType + entityId` 唯一 |
| `tf_operations` | `ownerId + opId` 唯一 |
| `tf_changes` | `ownerId + epoch + sequence` 唯一，并按该顺序建立查询索引 |
| `tf_purge_confirmations` | `ownerId + tokenHash` 唯一 |
| `tf_purge_receipts` | `ownerId + receiptId` 唯一 |

把 `cloudbase/database.rules.json` 中六个集合的规则应用到云环境：客户端 `read` 和 `write` 都为 `false`。云函数使用服务端权限，客户端伪造 ownerId 或直接访问数据库都必须失败。

## 3. 配置允许名单和函数密钥

只配置以下变量名，不要把真实值写入 `.env.example`：

| 变量 | 要求 |
| --- | --- |
| `TRAINFLOW_ALLOWED_OPENID_SHA256` | 允许使用同步的 OpenID SHA-256，多个值用英文逗号分隔 |
| `TRAINFLOW_OWNER_HMAC_KEY` | 至少 32 字节，用于派生不透明 ownerId |
| `TRAINFLOW_CURSOR_HMAC_KEY` | 至少 32 字节，用于保护同步游标 |
| `TRAINFLOW_PURGE_HMAC_KEY` | 至少 32 字节，用于云端删除确认 |
| `TRAINFLOW_PURGE_TTL_SECONDS` | 30–900，建议 300 |

获取自己的 OpenID 后，可在不回显输入的本机终端计算哈希：

```sh
read -s TRAINFLOW_TEMP_OPENID
printf %s "$TRAINFLOW_TEMP_OPENID" | shasum -a 256
unset TRAINFLOW_TEMP_OPENID
```

不要把 OpenID 直接写进命令历史、截图或日志。把输出哈希填入云函数环境变量；四个密钥使用独立的密码学随机值并分别保存。

## 4. 准备和部署云函数

```sh
npm run cloud:prepare
```

该命令把 `cloudfunctions/shared/` 的受控源码复制到四个独立部署包的 `_shared/` 目录，并打印 SHA-256 摘要。生成目录已被 Git 忽略。

在微信开发者工具中分别对以下目录执行“上传并部署：云端安装依赖”：

- `cloudfunctions/authBootstrap/`
- `cloudfunctions/syncPush/`
- `cloudfunctions/syncPull/`
- `cloudfunctions/accountPurge/`

为四个函数配置同一组上述环境变量。不要把变量值写入函数源码、`cloudbaserc`、截图或部署日志。依赖锁和已接受的上游安全例外记录在 [云函数运行契约](../cloudfunctions/README.md)。

## 5. 连接和 smoke

1. 在开发者工具确认当前项目使用正确的真实 AppID 和目标云环境。
2. 编译后打开 `pages/settings/index?section=cloud-sync`。
3. 启用同步，确认上传范围只包含计划、记录和设置。
4. 创建一条匿名测试计划或记录，验证 push 后能从另一台体验设备 pull。
5. 临时移除允许名单，确认页面显示无权限且本机训练不受影响；恢复后重试成功。
6. 制造同一实体的两端修改，确认必须显式选择冲突处理方式。
7. 在匿名账号上完成云端副本两阶段删除，确认本机数据保持不变、服务端数据被清理。
8. 最后再次断网，从冷启动完成一次本机训练链。

真实云 smoke 会访问项目所有者的云环境，应在仓库外记录结果，只保留去敏结论。仓库自动化使用隔离 Provider 和测试密钥 sentinel，不证明真实云环境已经部署。

## 6. 故障排查

- `CLOUD_SYNC_UNAVAILABLE`：检查项目是否选择了云环境、云能力是否可用、四个函数是否已部署；离线功能无需等待修复。
- `SYNC_ACCESS_DENIED`：检查当前 OpenID 的 SHA-256 是否在允许名单，避免记录原始 OpenID。
- 函数提示缺少 `_shared`：重新执行 `npm run cloud:prepare` 后逐个上传函数。
- 客户端能直接读集合：立即重新应用 `cloudbase/database.rules.json` 的 deny-all 规则，停止发布。
- 冲突一直存在：不要直接改数据库；在设置页选择保留云端、本机另存或重放本机修改。
- 删除确认过期：重新发起准备步骤，不要复用旧 token。

## 7. 密钥轮换

1. 暂停真实云同步操作并保留本机数据。
2. 在 Secret 管理中生成并替换目标 HMAC 变量，不在聊天或日志中传值。
3. 重新部署函数并执行匿名 smoke。
4. 游标密钥轮换可能使旧游标失效；客户端应从可信服务端时间线重新拉取。
5. 确认无旧版本函数后再撤销旧密钥。

未来如接入自建数据库，应实现同一远程 Provider 契约，不让页面或领域层直接依赖数据库 SDK。自建适配器不属于当前 V1。
