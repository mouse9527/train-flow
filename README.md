# 练程 TrainFlow

练程是一个原生微信小程序技术栈实现的个人健身训练助手。它以本机数据为运行基础：没有网络、没有云环境或云端暂时不可用时，计划、训练计时、记录与统计仍然可以使用。云同步是可选的跨设备恢复能力，不是启动条件。

## V1 已完成

- 初始化并查看一周训练计划，编辑动作、复制计划到其他日期。
- 执行计时、间歇、力量和手动动作；支持暂停、继续、跳过、组间休息和训练总结。
- 使用绝对时间恢复后台计时，重启后恢复未结束的训练会话。
- 保存、查看、编辑和删除训练记录，查看周完成率、训练分钟与轻量趋势。
- 配置振动、声音和屏幕常亮偏好；导出、预览导入和清除本机数据。
- 按需启用 CloudBase 同步，处理失败重试、冲突和云端副本删除。

## 运行要求

- 已注册的微信小程序账号；只做本地开发时也可使用测试号或 `touristappid`。
- 微信开发者工具 Stable 版。
- Node.js 20 或更高版本，仅用于测试、文档检查和云函数准备；小程序运行时没有 npm 依赖。

## 导入与本机运行

```sh
npm test
npm run docs:check
```

1. 在微信开发者工具选择“导入项目”，目录选择仓库根目录，而不是 `miniprogram/`。
2. `project.config.json` 保留可公开提交的 `touristappid`，`miniprogramRoot` 已指向 `miniprogram/`。
3. 需要真机预览或上传时，在本机 `project.config.json` 临时把 `appid` 换成你自己的真实 AppID。AppID 不是密码，但它是部署标识；公共分支继续保留占位值，提交前确认没有把本机替换带入 Git。开发者工具的其他本机偏好由已忽略的 `project.private.config.json` 承载。
4. 编译后从“今日”进入。首次使用会在本机初始化匿名首周计划，不需要 CloudBase。

本项目不使用 uni-app、Taro 或其他跨端框架，也没有运行时 npm 依赖。

## 目录结构

- `miniprogram/pages/`：今日、计划、训练、记录、统计和设置页面。
- `miniprogram/application/`：页面调用的应用服务。
- `miniprogram/domain/`：计划、训练会话、记录和同步领域模型。
- `miniprogram/services/`：本地数据库、设备能力、统计和远程同步适配器。
- `cloudfunctions/`：CloudBase 鉴权、推送、拉取和云端副本删除函数。
- `tests/`：Node 原生测试和 V1 验收矩阵。
- `evidence/`：匿名截图与去敏测试日志；不保存真实训练数据。

## 开发者工具复现入口

以下查询参数只在 `develop` 环境生效，`trial` 和 `release` 会忽略它们：

- `pages/today/index?date=2026-08-03`：训练日。
- `pages/today/index?date=2026-08-09`：休息日。
- `pages/today/index?date=2026-08-03&fixture=active`：进行中的训练。
- `pages/today/index?date=2026-08-03&fixture=completed`：已完成训练。
- `pages/stats/index?fixture=worked-sample&state=populated&date=2026-08-05`：匿名统计示例。
- `pages/settings/index?section=data`：本机导入、导出与清除。
- `pages/settings/index?section=cloud-sync&fixture=conflict`：匿名同步冲突界面。

Fixture 只提供匿名、只读的开发视图，不会写入真实记录或访问真实云账号。

## 手机预览与体验版

1. 先执行 `npm test`、`npm run docs:check` 和 `bash scripts/privacy-scan.sh`。
2. 在开发者工具确认使用真实 AppID，点击“预览”，用该小程序的开发者或体验成员微信扫码。
3. 至少验证一次：离线冷启动、计时后台恢复、训练记录保存，以及真机振动/屏幕常亮降级。
4. 点击“上传”，填写版本号与用户可读的项目备注。
5. 在微信公众平台的版本管理中把上传版本设为体验版，完成体验成员验证后提交审核；审核通过后再发布。

不要把开发者工具缓存通过、Node 测试通过或体验版通过互相替代；它们是不同证据层级。

## 数据与云同步

- [隐私与数据说明](docs/privacy-and-data.md)：本机、导出和云端分别保存什么，以及如何清除。
- [CloudBase 配置](docs/cloud-setup.md)：环境、集合、规则、函数、允许名单和密钥变量。
- [云函数运行契约](cloudfunctions/README.md)：服务端授权与部署包细节。
- [V1 验收矩阵](tests/e2e/acceptance-matrix.md)：自动化、开发者工具证据和限制。

真实值只进入微信云函数环境变量或本机忽略文件。仓库中的 `.env.example` 只列变量名，不能复制真实值进 Git、截图、Issue、PR 或测试日志。

## 已知限制与延后项

- 语音提示只保留设置项，V1 不提供 TTS；声音不可用时退化为振动和可见提示。
- 微信开发者工具不能证明真实设备的振动与系统屏幕常亮，发布前需真机 smoke。
- 进行中的训练 Session 只在当前设备恢复，不会迁移到另一台设备；云同步面向计划、记录和设置。
- 真实 CloudBase 环境部署与账号允许名单需要项目所有者在微信后台完成；仓库测试使用隔离 Provider，不访问真实凭据。
- 第二周具体训练内容、自建数据库适配器和更完整的趋势分析不在 V1 范围。

## 通知音频

`miniprogram/assets/workout-notification.m4a` 是项目本地生成的短提示音，不包含下载录音或第三方素材。它只在声音提醒开启且设备支持时使用。
