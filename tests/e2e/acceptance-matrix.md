# TrainFlow V1 验收矩阵

本矩阵把 Owner 已确认的 V1 设计、原始 23 项验收结果和 `US-QA-001` AC1–AC6 映射到可重复执行的证据。自动化通过只代表代码边界已被验证，不替代微信开发者工具、真机设备或截图验收。

状态定义：

- `AUTOMATED`：已有公开应用/Provider/页面边界的自动化证据。
- `MANUAL-BLOCKED`：自动化可能已覆盖模型，但仍缺 Supervisor 在微信开发者工具或真机上的真实证据。
- `DEFERRED`：不属于当前 V1 可交付行为，已明确后续承接点。
- `UNSUPPORTED`：当前工具无法可靠自动证明，不能宣称通过。

## 原始 23 项验收结果

| # | 原始验收结果 | Story / QA AC | 自动化证据 | 必需人工证据 | 当前状态 |
|---:|---|---|---|---|---|
| 1 | 微信开发者工具可直接导入 | US-SET-001 / AC1、AC6 | `tests/e2e/app-shell-golden-path.test.js` 检查项目配置、页面与 sitemap | DevTools 使用仓库根目录导入，记录 head/tree、导入结果与首页截图 | MANUAL-BLOCKED |
| 2 | 不需要联网即可启动 | US-SYNC-001 / AC2 | `train-flow-critical.e2e.test.js` C1 使用统一 `NETWORK_OFFLINE` 适配器且网络调用为 0 | DevTools 先关闭网络，再冷启动并记录 Network/Console | MANUAL-BLOCKED |
| 3 | 首次打开自动初始化 2026-08-03 至 2026-08-09 计划 | US-PLAN-001 / AC2 | C1 通过公开计划应用服务初始化 7 天；`tests/domain/planning/default-plan-initialization.test.js` 深测幂等与完整性 | 离线首次启动的一周计划截图 | MANUAL-BLOCKED |
| 4 | 首页能显示当天训练 | US-PLAN-002 / AC1 | `tests/e2e/today-page-golden-path.test.js`、`tests/application/today-plan-view.test.js` | 今日页真实渲染截图 | MANUAL-BLOCKED |
| 5 | 可以选择任意日期查看计划 | US-PLAN-003 / AC1 | `tests/e2e/week-plan-page.test.js`、`tests/application/week-plan-view.test.js` | 一周页切换训练日与休息日截图 | MANUAL-BLOCKED |
| 6 | 计时动作可以开始、暂停和继续 | US-EXEC-001、US-EXEC-003 / AC2 | `tests/e2e/timed-workout-page-golden-path.test.js`、`tests/integration/timed-workout-page.test.js` | DevTools 中实际点击开始/暂停/继续并截图 | MANUAL-BLOCKED |
| 7 | 切到后台再回来，剩余时间基本正确 | US-EXEC-001、US-EXEC-002 / AC3 | C2 新建 runtime 恢复绝对时间；`tests/e2e/session-recovery-golden-path.test.js` 深测 hide/show/unload | DevTools hide/show 与重启后显示剩余时间的连续证据 | MANUAL-BLOCKED |
| 8 | 力量动作可以记录当前组数 | US-EXEC-004 / AC2 | C1 完成三项力量动作；`tests/integration/strength-rest-flow.test.js` 深测组数 | 力量页当前组与已完成组截图 | MANUAL-BLOCKED |
| 9 | 完成本组后自动开始休息倒计时 | US-EXEC-004 / AC2 | C1 通过公开命令完成组并物化休息 deadline | 力量页休息倒计时截图 | MANUAL-BLOCKED |
| 10 | 休息结束有振动提示 | US-EXEC-005 / AC3 | C2 证明同一 expiration occurrence 只通知一次；`tests/integration/timed-workout-page.test.js` 覆盖振动、视觉降级和 occurrence 去重 | 真机验证振动；不支持振动时记录视觉降级 | MANUAL-BLOCKED |
| 11 | 可以跳过动作 | US-EXEC-003 / AC2 | `tests/e2e/timed-workout-page-golden-path.test.js` 与 `tests/integration/timed-workout-page.test.js` | DevTools 跳过动作后的进度截图 | MANUAL-BLOCKED |
| 12 | 可以结束训练 | US-EXEC-003、US-EXEC-005 / AC2 | C2 通过公开 WorkoutApplicationService 执行终止命令 | DevTools 结束训练并进入总结页 | MANUAL-BLOCKED |
| 13 | 训练结束可以保存记录 | US-EXEC-005、US-REC-001 / AC2 | C1 生成唯一终态记录；C2 重放终态命令不重复记录；`tests/e2e/workout-summary-golden-path.test.js` | 总结页保存反馈及记录页截图 | MANUAL-BLOCKED |
| 14 | 历史记录可以查看和删除 | US-REC-001 / AC4 | C3 通过真实 RecordApplicationService 编辑、查看、删除 | 记录详情与删除确认截图 | MANUAL-BLOCKED |
| 15 | 可以看到本周完成率 | US-REC-002 / AC2 | C1 从真实终态记录读取 `1 / 6`；`tests/e2e/stats-page-golden-path.test.js` | 统计页完成率截图 | MANUAL-BLOCKED |
| 16 | 可以看到累计训练分钟 | US-REC-002 / AC2 | C1 断言累计分钟非 0；`tests/integration/statistics-refresh.test.js` | 统计页累计分钟截图 | MANUAL-BLOCKED |
| 17 | 设置可以控制振动和屏幕常亮 | US-SET-001、US-EXEC-005 / AC1、AC3 | `tests/integration/app-shell-settings.test.js`、`tests/integration/timed-workout-page.test.js` | DevTools 设置切换；真机验证屏幕常亮/振动或降级 | MANUAL-BLOCKED |
| 18 | 可以导出 JSON | US-SET-002 / AC4 | C3 通过 SettingsDataApplicationService 创建匿名导出；`tests/e2e/settings-data-controls.test.js` 深测确认与剪贴板 | DevTools 导出预览与隐私警告截图，不保存私人内容到仓库 | MANUAL-BLOCKED |
| 19 | 可以导入 JSON | US-SET-002 / AC4 | C3 在独立数据库中预览并确认有效导入，另证无效 JSON 字节级零写 | DevTools 有效导入与无效导入回滚提示 | MANUAL-BLOCKED |
| 20 | 清除数据前有二次确认 | US-SET-002 / AC4 | C3 证明 prepare 零写、取消不变、confirm 后仅清空本机 | DevTools 取消一次、再确认一次的对话框与结果截图 | MANUAL-BLOCKED |
| 21 | 不依赖服务器 | US-SYNC-001、US-SYNC-002 / AC2、AC5 | C1 核心训练链网络调用为 0；C4 证明云同步是可恢复的可选边界 | 网络关闭冷启动、完成训练、查看记录与统计 | MANUAL-BLOCKED |
| 22 | 不依赖第三方库 | US-SET-001 / AC1 | `package.json` 无 runtime dependencies；自动化只使用 Node/仓库源码 | 发布前复核最终 `package.json` 和小程序构建产物 | AUTOMATED |
| 23 | 代码结构清晰，方便加入第二周训练计划 | US-PLAN-004、US-DOC-001 / AC1 | 计划 Domain/Application/Repository 分层及计划编辑、复制测试 | 第二周真实计划内容与 UX 不在当前 V1 验收范围 | DEFERRED |

## US-QA-001 AC 状态

| AC | 自动化证据 | 人工/外部证据 | 状态 |
|---|---|---|---|
| AC1 | 本矩阵完整列出原始 23 项、Story 映射、自动/人工证据和限制 | Supervisor 复核设计签署版本没有漂移 | AUTOMATED |
| AC2 | C1 在同一匿名本地数据库中初始化整周，完成 timed + strength/rest 全链，落一条记录并更新统计，网络调用为 0 | DevTools 真正关闭网络后的首次导入、训练与统计截图 | MANUAL-BLOCKED |
| AC3 | C2 重建 runtime，恢复绝对时间，只产生一次 expiration boundary；终态命令重放仍只有一条记录 | DevTools hide/show、page unload、应用重启；真机通知/振动 | MANUAL-BLOCKED |
| AC4 | C3 通过公开应用边界完成记录编辑/删除、JSON 导出/有效导入、无效导入零写、本地清除取消/确认、周日不可启动 | 对应页面对话框和结果截图 | MANUAL-BLOCKED |
| AC5 | C4 覆盖 denied→retry、plan conflict→resolve、remote purge、CloudBase offline、可信 context owner；源码断言无客户端直连数据库 | 真实云环境配置与凭据不进入仓库；发布前可选 smoke | AUTOMATED |
| AC6 | `scripts/privacy-scan.sh` 扫描 tracked 源码/测试/fixture/cloudfunctions/scripts；严格模式会因截图缺失退出非 0 | `evidence/screenshots/manifest.tsv`、截图、命令日志及 Supervisor 视觉结论均缺失 | MANUAL-BLOCKED |

## 证据命令与边界

```sh
node --test tests/e2e/train-flow-critical.e2e.test.js
PRIVACY_SCAN_REQUIRE_SCREENSHOTS=0 bash scripts/privacy-scan.sh
bash scripts/privacy-scan.sh
```

- 第一条必须恰好执行 C1–C4 四个顶层跨上下文场景。
- 第二条只验证源码、测试 fixture、云函数与已有 evidence 文件的隐私规则；测试 sentinel 只允许精确 allowlist。
- 第三条是发布前严格证据门禁。当前因 `evidence/screenshots/` 与 `evidence/logs/` 缺失而失败，这是预期阻断，不是 warning；默认绑定当前 HEAD/tree，也可用 `PRIVACY_SCAN_EXPECTED_HEAD`、`PRIVACY_SCAN_EXPECTED_TREE` 显式绑定 DevTools 实际运行的 source commit。
- 自动化使用公开 Application Service、Repository、Remote Provider、CloudBase Provider 与 public cloud handler；不直接调用私有 reducer 伪造成功。
- 深层攻击/完整性覆盖保留在已有 integration/domain/cloudfunction tests，C1–C4 不复制这些大套件。

## 截图与日志证据要求

若存在 `evidence/screenshots/`，必须包含 `manifest.tsv`，列顺序固定为：

```text
route	head	tree	sha256	data_source	manual_visual_verdict	file
```

每张图片必须绑定页面 route、40 位 Git head、40 位 tree、SHA-256、匿名数据来源、人工视觉结论和文件名。扫描器只验证清单、来源字段和文件哈希，不读取或宣称检查 PNG 像素；图片中的私人内容必须由 Supervisor 人工确认。日志只能保存命令结论和去敏摘要，不能保存 OpenID、ownerId、token 或训练记录 payload。

`evidence/logs/manifest.tsv` 必须包含并逐项绑定 `critical-e2e`、`full-suite`、`privacy-scan` 三类日志，列顺序固定为：

```text
kind	head	tree	sha256	redaction_verdict	file
```

三个 kind 必须各出现一次并分别绑定不同的 `.log` 文件，不能以一份输出冒充多类命令证据。日志文件和 manifest 必须 tracked、非符号链接、非空纯文本、哈希一致、人工去敏结论为 `PASS`；source head 必须能解析为 commit，tree 必须属于该 commit，并与本次证据运行绑定值一致。除 `evidence/screenshots/` 与 `evidence/logs/` 外的整个项目树（含产品、测试、脚本、CloudBase 规则、ignore 和 package/project 配置）相对 source commit 有任何 tracked 或未忽略的 untracked 变化时，证据一律视为过期。任何未列入 manifest 的 tracked `.log`、NUL/二进制内容或来源过期都会阻断。

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

- `UNSUPPORTED`：Node 自动化不能证明微信开发者工具实际导入、真实 network-off 状态、页面渲染像素、真机振动或系统屏幕常亮；这些项目一律保持 `MANUAL-BLOCKED`。
- `UNSUPPORTED`：隐私扫描器不能检查截图像素，也不声称能从二进制图片中识别私人数据。
- `DEFERRED`：第二周的具体训练内容、真实云环境部署与发布流程由后续 Story 承接；当前只证明扩展边界和可选同步契约。
- 已有云测试只使用匿名、隔离 Provider 和测试密钥 sentinel，不访问真实 AppID、OpenID、Secret 或个人健康数据。
- 截止当前没有 `evidence/screenshots/` 和受控 `evidence/logs/`，因此 AC2、AC3、AC6 以及所有依赖真实 UI/设备的原始验收项都不能标为通过。

## 当前结论

自动化主链可重复执行，但发布验收仍为 **BLOCKED**。只有 Supervisor 在同一 exact head/tree 上完成 DevTools/真机步骤、补齐截图 manifest 与去敏日志，并让严格隐私扫描退出 0 后，才可把 `US-QA-001` 标记为 Done。
