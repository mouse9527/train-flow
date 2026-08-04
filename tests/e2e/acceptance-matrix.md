# TrainFlow V1 验收矩阵

本矩阵把 Owner 已确认的 V1 设计、原始 23 项验收结果和 `US-QA-001` AC1–AC6 映射到可重复执行的证据。自动化通过只代表代码边界已被验证，不替代微信开发者工具、真机设备或截图验收。

状态定义：

- `AUTOMATED`：已有公开应用/Provider/页面边界的自动化证据。
- `MANUAL-PASS`：Supervisor 已在微信开发者工具中按真实页面和网络状态完成验证，证据已进入受控清单。
- `MANUAL-PARTIAL`：真实页面边界已验证，但真机能力或破坏性操作仍由自动化/已知限制承接。
- `MANUAL-BLOCKED`：自动化可能已覆盖模型，但仍缺 Supervisor 在微信开发者工具或真机上的真实证据。
- `DEFERRED`：不属于当前 V1 可交付行为，已明确后续承接点。
- `UNSUPPORTED`：当前工具无法可靠自动证明，不能宣称通过。

## 原始 23 项验收结果

| # | 原始验收结果 | Story / QA AC | 自动化证据 | 必需人工证据 | 当前状态 |
|---:|---|---|---|---|---|
| 1 | 微信开发者工具可直接导入 | US-SET-001 / AC1、AC6 | `tests/e2e/app-shell-golden-path.test.js` 检查项目配置、页面与 sitemap | Stable 2.01.2510290 使用仓库根目录、`touristappid`、无云服务导入并运行 | MANUAL-PASS |
| 2 | 不需要联网即可启动 | US-SYNC-001 / AC2 | `train-flow-critical.e2e.test.js` C1 使用统一 `NETWORK_OFFLINE` 适配器且网络调用为 0 | DevTools Network=`Offline` 后冷启动；今日页与周计划均可读取 | MANUAL-PASS |
| 3 | 首次打开自动初始化 2026-08-03 至 2026-08-09 计划 | US-PLAN-001 / AC2 | C1 通过公开计划应用服务初始化 7 天；`tests/domain/planning/default-plan-initialization.test.js` 深测幂等与完整性 | 离线周计划显示 08月03日–08月09日共 7 天 | MANUAL-PASS |
| 4 | 首页能显示当天训练 | US-PLAN-002 / AC1 | `tests/e2e/today-page-golden-path.test.js`、`tests/application/today-plan-view.test.js` | 离线今日页真实渲染已截图 | MANUAL-PASS |
| 5 | 可以选择任意日期查看计划 | US-PLAN-003 / AC1 | `tests/e2e/week-plan-page.test.js`、`tests/application/week-plan-view.test.js` | DevTools 切换周一训练日与周日完全休息；休息日无开始训练入口 | MANUAL-PASS |
| 6 | 计时动作可以开始、暂停和继续 | US-EXEC-001、US-EXEC-003 / AC2 | `tests/e2e/timed-workout-page-golden-path.test.js`、`tests/integration/timed-workout-page.test.js` | Offline 下实际点击开始、暂停、继续，恢复后倒计时继续 | MANUAL-PASS |
| 7 | 切到后台再回来，剩余时间基本正确 | US-EXEC-001、US-EXEC-002 / AC3 | C2 新建 runtime 恢复绝对时间；`tests/e2e/session-recovery-golden-path.test.js` 深测 hide/show/unload | Actions Home/Return 越过 deadline 后显示 `00:00`；重启 DevTools 后仍停在同一动作等待确认 | MANUAL-PASS |
| 8 | 力量动作可以记录当前组数 | US-EXEC-004 / AC2 | C1 完成三项力量动作；`tests/integration/strength-rest-flow.test.js` 深测组数 | Offline 下记录两组各 12 次，重量留空 | MANUAL-PASS |
| 9 | 完成本组后自动开始休息倒计时 | US-EXEC-004 / AC2 | C1 通过公开命令完成组并物化休息 deadline | 完成第 1 组后进入绝对时间休息倒计时并截图 | MANUAL-PASS |
| 10 | 休息结束有振动提示 | US-EXEC-005 / AC3 | C2 证明同一 expiration occurrence 只通知一次；`tests/integration/timed-workout-page.test.js` 覆盖振动、视觉降级和 occurrence 去重 | DevTools 证明视觉结束边界；真实振动仍需真机 | MANUAL-PARTIAL |
| 11 | 可以跳过动作 | US-EXEC-003 / AC2 | `tests/e2e/timed-workout-page-golden-path.test.js` 与 `tests/integration/timed-workout-page.test.js` | Offline 下确认跳过两个力量动作，最终记录显示 2 跳过 | MANUAL-PASS |
| 12 | 可以结束训练 | US-EXEC-003、US-EXEC-005 / AC2 | C2 通过公开 WorkoutApplicationService 执行终止命令 | 完成最后计时动作后进入训练总结页 | MANUAL-PASS |
| 13 | 训练结束可以保存记录 | US-EXEC-005、US-REC-001 / AC2 | C1 生成唯一终态记录；C2 重放终态命令不重复记录；`tests/e2e/workout-summary-golden-path.test.js` | 填写匿名 RPE 5 后保存；记录页与统计页即时更新 | MANUAL-PASS |
| 14 | 历史记录可以查看和删除 | US-REC-001 / AC4 | C3 通过真实 RecordApplicationService 编辑、查看、删除 | DevTools 查看真实记录；删除与回滚在隔离自动化数据库中验证，未破坏视觉证据数据 | MANUAL-PARTIAL |
| 15 | 可以看到本周完成率 | US-REC-002 / AC2 | C1 从真实终态记录读取 `1 / 6`；`tests/e2e/stats-page-golden-path.test.js` | 统计页显示 17%、1 / 6 次 | MANUAL-PASS |
| 16 | 可以看到累计训练分钟 | US-REC-002 / AC2 | C1 断言累计分钟非 0；`tests/integration/statistics-refresh.test.js` | 统计页显示 9 分钟实际活动 | MANUAL-PASS |
| 17 | 设置可以控制振动和屏幕常亮 | US-SET-001、US-EXEC-005 / AC1、AC3 | `tests/integration/app-shell-settings.test.js`、`tests/integration/timed-workout-page.test.js` | DevTools 设置页可读取开关；真机振动与系统常亮仍需设备 smoke | MANUAL-PARTIAL |
| 18 | 可以导出 JSON | US-SET-002 / AC4 | C3 通过 SettingsDataApplicationService 创建匿名导出；`tests/e2e/settings-data-controls.test.js` 深测确认与剪贴板 | DevTools 本机数据页显示隐私警告与生成备份入口；仓库不保存导出 payload | MANUAL-PARTIAL |
| 19 | 可以导入 JSON | US-SET-002 / AC4 | C3 在独立数据库中预览并确认有效导入，另证无效 JSON 字节级零写 | DevTools 显示先验证/预览边界；有效与无效导入在隔离自动化数据库中验证 | MANUAL-PARTIAL |
| 20 | 清除数据前有二次确认 | US-SET-002 / AC4 | C3 证明 prepare 零写、取消不变、confirm 后仅清空本机 | DevTools 显示危险操作入口；取消/确认在隔离自动化数据库中验证，未删除验收记录 | MANUAL-PARTIAL |
| 21 | 不依赖服务器 | US-SYNC-001、US-SYNC-002 / AC2、AC5 | C1 核心训练链网络调用为 0；C4 证明云同步是可恢复的可选边界 | Offline 下完成训练、保存记录、查看统计及重启恢复 | MANUAL-PASS |
| 22 | 不依赖第三方库 | US-SET-001 / AC1 | `package.json` 无 runtime dependencies；自动化只使用 Node/仓库源码 | 发布前复核最终 `package.json` 和小程序构建产物 | AUTOMATED |
| 23 | 代码结构清晰，方便加入第二周训练计划 | US-PLAN-004、US-DOC-001 / AC1 | 计划 Domain/Application/Repository 分层及计划编辑、复制测试 | 第二周真实计划内容与 UX 不在当前 V1 验收范围 | DEFERRED |

## US-QA-001 AC 状态

| AC | 自动化证据 | 人工/外部证据 | 状态 |
|---|---|---|---|
| AC1 | 本矩阵完整列出原始 23 项、Story 映射、自动/人工证据和限制 | Supervisor 已复核签署范围；没有扩展第二周或真实云部署范围 | MANUAL-PASS |
| AC2 | C1 在同一匿名本地数据库中初始化整周，完成 timed + strength/rest 全链，落一条记录并更新统计，网络调用为 0 | DevTools Network=`Offline` 下完成开始/暂停/继续、力量组/休息、跳过、总结、记录和统计 | MANUAL-PASS |
| AC3 | C2 重建 runtime，恢复绝对时间，只产生一次 expiration boundary；终态命令重放仍只有一条记录 | DevTools Home/Return 越过 deadline 后恢复到等待确认；重启 DevTools 后同一会话仍存在；记录数仍为 1 | MANUAL-PASS |
| AC4 | C3 通过公开应用边界完成记录编辑/删除、JSON 导出/有效导入、无效导入零写、本地清除取消/确认、周日不可启动 | DevTools 已验证记录详情与本机数据控制页面；破坏性步骤保留在隔离自动化数据库 | MANUAL-PASS |
| AC5 | C4 覆盖 denied→retry、plan conflict→resolve、remote purge、CloudBase offline、可信 context owner；源码断言无客户端直连数据库 | 真实云环境配置与凭据不进入仓库；发布前可选 smoke | AUTOMATED |
| AC6 | `scripts/privacy-scan.sh` 扫描 tracked 源码/测试/fixture/cloudfunctions/scripts，并校验证据 source、manifest、哈希和日志结构 | DevTools 截图只含匿名计划、RPE 5、空重量/备注；截图和去敏命令日志由 manifest 绑定同一 source，严格扫描结果写入交付报告 | MANUAL-PASS |

## 证据命令与边界

```sh
node --test tests/e2e/train-flow-critical.e2e.test.js
PRIVACY_SCAN_REQUIRE_SCREENSHOTS=0 bash scripts/privacy-scan.sh
bash scripts/privacy-scan.sh
```

- 第一条必须恰好执行 C1–C4 四个顶层跨上下文场景。
- 第二条只验证源码、测试 fixture、云函数与已有 evidence 文件的隐私规则；测试 sentinel 只允许精确 allowlist。
- 第三条是发布前严格证据门禁。当前因 `evidence/screenshots/` 与 `evidence/logs/` 缺失而失败，这是预期阻断，不是 warning。普通命令会从 manifest 第一条合法记录推导证据采集前的 source head/tree；两个 manifest 的所有记录必须使用同一 source。`PRIVACY_SCAN_EXPECTED_HEAD`、`PRIVACY_SCAN_EXPECTED_TREE` 只用于显式锁定该 source，必须成对提供。
- 自动化使用公开 Application Service、Repository、Remote Provider、CloudBase Provider 与 public cloud handler；不直接调用私有 reducer 伪造成功。
- 深层攻击/完整性覆盖保留在已有 integration/domain/cloudfunction tests，C1–C4 不复制这些大套件。

## 截图与日志证据要求

若存在 `evidence/screenshots/`，必须包含 `manifest.tsv`，列顺序固定为：

```text
route	head	tree	sha256	data_source	manual_visual_verdict	file
```

每张图片必须绑定页面 route、40 位 Git source head、该 commit 的 40 位 tree、SHA-256、匿名数据来源、人工视觉结论和文件名。source commit 必须是当前 evidence commit 的祖先；当前 HEAD 相对 source 只能增加或修改 `evidence/screenshots/`、`evidence/logs/`，任何非 evidence 漂移都会阻断。扫描器只验证清单、来源字段和文件哈希，不读取或宣称检查 PNG 像素；图片中的私人内容必须由 Supervisor 人工确认。日志只能保存命令结论和去敏摘要，不能保存 OpenID、ownerId、token 或训练记录 payload。

`evidence/logs/manifest.tsv` 必须包含并逐项绑定 `critical-e2e`、`full-suite`、`privacy-scan` 三类日志，列顺序固定为：

```text
kind	head	tree	sha256	redaction_verdict	file
```

三个 kind 必须各出现一次并分别绑定不同的 `.log` 文件，不能以一份输出冒充多类命令证据。日志文件和 manifest 必须 tracked、非符号链接、非空纯文本、哈希一致、人工去敏结论为 `PASS`；source head 必须能解析为当前 HEAD 的祖先 commit，tree 必须属于该 commit，并与截图及全部日志的 source 绑定一致。除 `evidence/screenshots/` 与 `evidence/logs/` 外的整个项目树（含产品、测试、脚本、CloudBase 规则、ignore 和 package/project 配置）相对 source commit 有任何 tracked 或未忽略的 untracked 变化时，证据一律视为过期。任何未列入 manifest 的 tracked `.log`、NUL/二进制内容、混用 source 或来源过期都会阻断。

每份日志采用相同的最小 provenance 包装，命令输出置于 source-tree 与 exit-code 之间；首行命令必须与 kind 精确对应，末行只允许成功退出：

```text
command: <critical-e2e、full-suite 或 privacy-scan 对应的固定命令>
source-head: <40 位 commit>
source-tree: <该 commit 的 40 位 tree>
<去敏后的命令输出>
exit-code: 0
```

`critical-e2e` 还必须包含 `# tests 4`、`# pass 4`、`# fail 0`；`full-suite` 的 tests/pass 必须是相同的正整数且 fail 为 0；`privacy-scan` 必须包含扫描器成功标记 `PRIVACY_SCAN_PASS tracked-content`。这些结构检查用于拒绝空白、任意文本或只有包装行而没有命令结果的伪证据。

## 已知限制、Unsupported 与 Deferred

- `UNSUPPORTED`：微信开发者工具不能证明真实设备振动和系统屏幕常亮；当前只证明视觉结束边界与设置契约，发布真机 smoke 仍需设备。
- `UNSUPPORTED`：隐私扫描器不能检查截图像素，也不声称能从二进制图片中识别私人数据。
- `DEFERRED`：第二周的具体训练内容、真实云环境部署与发布流程由后续 Story 承接；当前只证明扩展边界和可选同步契约。
- 已有云测试只使用匿名、隔离 Provider 和测试密钥 sentinel，不访问真实 AppID、OpenID、Secret 或个人健康数据。
- DevTools 首次仅清除 data cache 时曾保留页面内存并触发一次无效 read-back；执行 Clear All 后重新冷启动，在线与 Offline 对照均正常。该现象未在全新 DevTools 进程重启后复现，作为工具缓存观察记录，不归因于产品代码。

## 当前结论

自动化与 DevTools 主链均已完成；截图、日志和严格隐私扫描是同一 source 上的发布门禁，最终退出码由交付报告绑定到 evidence-only head。真机振动/常亮与真实云 smoke 作为明确限制，不阻断离线优先 V1。
