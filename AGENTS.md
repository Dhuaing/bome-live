# AGENTS.md — AI 协作者手册（播了么 bome-live）

> 本文件是给 AI 代理（OpenCode / Claude / Copilot 等）和新人工程师的项目热启动手册。
> 每次踩到新坑请追加到「已知坑位」表格——这是项目的飞轮：踩坑一次，永久受益。

## 项目是什么

微信小程序「播了么」：追抖音主播直播，核心卖点是**电脑关机也能收到开播提醒**。

- 前端：Taro 4 + React，一套代码出 H5（`dist-h5`）与微信小程序（`dist-weapp`）
- 后端：微信云开发（免费环境）+ 云函数 + 定时触发器 + 订阅消息推送
- 本机脚本 `scripts/watch-live.js` 是旧架构（必须开机），已由云端接管，仅作备用

## 关键事实卡（改动前先读）

| 主题 | 事实 |
|---|---|
| 云环境 ID | `bome-livedongyailongwang-d91c6e8`（免费、文档型数据库） |
| appid | `wx47127cae29fda7e6`（project.config.json） |
| 订阅模板 | 「直播开播通知」公共模板，ID `N923NAse66knou-8SdrzLwYjQqtE5vVCoL3jqYn6aQo` |
| 模板字段 | 达人名称/直播间名称/开播时间/备注 → thing1/thing2/time3/thing4（**无 number 字段**） |
| 订阅模型 | 一次性订阅：用户每点一次「允许」= 1 条额度，推送 1 次消费 1 条 |
| 额度账本 | 微信无「查余额」API → 自建 `subsQuota` 集合（docId=openid）。攒：前端 accept→`notifyQuota(action:'earn')`；花：watchLive 推送成功→spend；43101→zero 归零校准。展示宁虚低不虚高（`_shared/quota-ledger.js`） |
| 收集集合 | `follows`（关注关系，`uniqueId`/`_openid`）、`watchState`（状态+心跳+指标；用户文档含 `sessionKey`/`roomTitle`/`lastPushAt`——同场合并窗的证据字段，坑 #8）、`subsQuota`（额度账本） |
| 触发器 | SCF timer `watch-live-timer`，cron `0 */1 * * * * *`（每分钟） |
| 巡检节奏 | 自适应：有主播在播→分钟级；全员离线/失败→按 `watch-config.json` 的 `pacing` 冷却跳轮，跳轮也会写 `meta__pacing`（= 定时器心跳） |

## 构建与部署 SOP（顺序敏感）

```powershell
# 前端构建：环境变量必须显式传，否则模板 ID/环境 ID 落默认值（坑 #5）
$env:TCB_ENV_ID = 'bome-livedongyailongwang-d91c6e8'
$env:SUBS_TEMPLATE_ID = 'N923NAse66knou-8SdrzLwYjQqtE5vVCoL3jqYn6aQo'
npm run build:weapp          # 内含 sync-cloud-shared.js 前置

# 云函数部署（共享代码已同步进各函数目录）：
& "C:\Program Files (x86)\Tencent\微信web开发者工具\cli.bat" cloud functions deploy `
  --env bome-livedongyailongwang-d91c6e8 `
  --names watchLive --project "D:\小程序" --remote-npm-install
# 输出末尾表格才是真相（PowerShell 报 exit 1 是噪音，别信）

# 改了 cloudfunctions/_shared/ 后必须先跑同步再部署：
node scripts/sync-cloud-shared.js

# 本机脚本退役/状态清零：
node scripts/watch-live.js --reset
```

部署后验证链路：调用 watchLive → 查 `watchState` 的 `meta__pacing.lastRoundAt` 是否推进（定时器心跳）。

## AI 自我维护 SOP（运行时自护 + 少量人工干预）

分层设计目标：**AI 自己发现 → 自己修复 → 只在『验收』和『授权』两点打扰人**。

### 自动层（无人值守持续生效）

| 机制 | 文档依据 | 自愈动作 |
|---|---|---|
| 巡检自适应（含连败指数退避） | `meta__pacing.failStreak` | 失败持续 → 冷却 ×2/×4/×8 自动放大到 30min；恢复 一轮即清零 |
| 心跳停摆自愈 | `meta__pacing.lastRoundAt` | `guardian` 云函数每天 08:00/20:00 自检，停摆 >20min → 补调一轮 watchLive |
| 无主关注隔离 | `meta__orphans` | 巡检自动跳过订阅、不产生脏状态档 |
| 额度账本校准 | `subsQuota`（43101→zero） | 账本永远向平台真实回答对齐 |

值班脚本 `scripts/duty.js`（本机/AI 都能跑）：
1. `node scripts/duty.js` —— 手动/AI 值守：本地体检 + 读云端自检 → 写 `docs/运维日志/YYYY-MM-DD.md`
2. `--auto` —— 只提交日志，供计划任务调用
3. Windows 计划任务 `bome-duty`（每天 21:00）→ `scripts/duty-task.bat` → `duty.js --auto`

值班脚本的 CDP 读数坑（新踩 2026-11-05）：
- `tcbQueryRecords` 条件查询必须同时带 `mgoQuery`（JSON 字符串）+ `mgoLimit`，缺 mgoLimit 报 MissingParameter
- cdp-eval.js 返回值包了一层 `{type, value}`——读数在 `.value` 里，忘解包会把「读失败」报销成「无事故」
- 脚本已内置防失真：五份 meta__ 文档全空时按「读数不可用」降级，不假报平安

### AI 接手维护的标准动作（每次会话维护开场）

1. 读 `docs/运维日志/ 最新一篇` → 有没有待处理事故
2. `node scripts/doctor.js && npm test` → 本地有没有野火
3. 有 incidents → 按坑位表修复 → 部署 → 修复后把 `meta__incidents` 已办清单注释进运维日志
4. 无事 → 一句话回报「今日值班：无事故」，结束

### 开发者的少量干预点（唯一打扰面）

- 「验收」：修复涉及真人接收到推送（额度/模板内容变化）→ AI 修复后请你真机确认一次
- 「授权」：动权限配置、删用户数据、换云环境类不可逆动作 → AI 必须先问你
- 其余（修 bug/部署/写代码/查指标）AI 全自动，无需等待

## 已知坑位表（飞轮核心，按踩坑时间倒序追加）

| # | 坑 | 症状 | 解法/要点 |
|---|---|---|---|
| 11 | **`git ls-tree` 默认把非 ASCII 路径转义成带引号坏名** | GitHub API 推送脚本直接拿 ls-tree 输出当路径 → 远端 13 个中文文档路径变成 `"docs/\345\274\200..."`（引号+八进制转义全进了真实文件名） | `git ls-tree -r -z`（NUL 分隔不转义）且用二进制读出再按 UTF-8 解析；`Temp\opencode\api-push.js` 已修。远端树可用 `GET /git/trees/master?recursive=1` 数 `path -match '["\\]'` 条目终检（盘点应为 0） |
| 10 | **CDP 管理端 `tcbUpdateItem` 的 `mgoUpdate` 是整文档替换，不是 $set patch** | 运维迁移只补一个字段（`mgoUpdate:{_openid}`）→ 其余字段（uniqueId/name/status）被整个洗掉，巡检 streamers 数骤降 | 云函数内 `doc().update({data:patch})` 才是增量语义；CDP 管理端更新必须**先读全文档→拼完整替换体→再写**（坑 #6 的姊妹教训，管理端更凶）；恢复验证以 `meta__metrics.streamers/records` 计数为终检证据 |
| 9 | **add 依赖 SDK 自动注入 `_openid`，部分调用上下文会失效** | 新端点添加的关注落库后 `_openid` 字段整个缺失 → 该用户自己都查不到这条关注，巡检端还为 `undefined__*` 白跑状态档 | 写库方必须**显式**带 `_openid`（云函数用 `getWXContext().OPENID`），与读取端显式 `where` 对称；别赌 wx-server-sdk 自动注入。历史坑 #1 的姊妹教训 |
| 8 | **抖音 create_time 推流重连漂移 → 同场双推送** | 同标题连收两条推送（开播时间 15:00/15:43，间隔 43min），白烧用户订阅额度 | 合并窗解决：`SESSION_MERGE_MS`=90min，`living→living` 漂移≤窗且标题不变→同场静默更新 sessionKey；`offline→living` 回看 `lastPushAt`（掉线秒重开离线轮观察不到）。代价：90min 内同标题真重开不推（可接受，见 `_shared/watch-rules.js`） |
| 7 | **SCF 容器是 UTC** | 订阅消息开播时间显示 06:59，实际北京 14:59 | `formatTime` 一律 +8h 后用 `getUTC*` 渲染（见 `_shared/notify-data.js`）；**本地 Win 是 +8 看不出这坑**，凡时间渲染必须钉住时区测试。**测试自身也会踩**：`new Date(y,m,d,h)` 按宿主机时区构造，Windows 绿、CI 的 UTC 容器炸——测试里构造绝对时刻必须用 `Date.UTC()` 或带偏移的 `Date.parse`（本地复现法：`$env:TZ='UTC'; npm test`） |
| 6 | **`doc().update()` 对不存在文档是静默空操作** | 首轮巡检「成功」但 watchState 永远 0 条 | 不能靠「update 失败再 add」建文档；`putStateDoc` 先读后写 + add 兜底 + 并发竞态回退 update |
| 5 | **构建环境变量必须显式传** | 产物里模板 ID/环境 ID 为空或旧默认值 → 订阅按钮消失/连错环境 | build 前设 `TCB_ENV_ID` + `SUBS_TEMPLATE_ID`；`scripts/doctor.js` 可验 |
| 4 | **React 子组件 effect 先于父组件执行** | `wx.cloud.init` 写在 App 的 useEffect → store 首拉报「please call wx.cloud.init first」且被吞，关注列表空白 | init 提到模块加载期；`services/cloud.ts` 有 ensureCloudInit 兜底 |
| 3 | **`scfGetFunctionLogs` 对微信环境永远空** | 用它验证定时器是否触发→假阴性 | 查 `watchState` 心跳文档/指标文档；`tcbGetFunctionLogs`/`tcbSearchClsLog` 需开日志服务 |
| 2 | **IDE CLI/HTTP 通道做不到云 API 配置**（触发器、超时） | CLI 路由表无这些端点 | IDE 带 `--remote-debugging-port=9223` 启动 → CDP 驱动 cloudconsolev1 webview 里的 `window.cloudApi`（小驼峰参数：functionName/namespace/timeout/region） |
| 1 | **微信数据库权限模型** | 客户端查询只见自己的文档（`_openid` 过滤）；服务端 read 全量 | 巡检函数刻意不按 openid 过滤；写库方（toggleFollow）责任带 `_openid` |

## CDP 驱动 IDE（调试端口手法）

IDE 须带调试端口启动（正常 IDE 没开端口时，先 `cli.bat quit` 再带端口重启）：

```powershell
Start-Process -FilePath "C:\Program Files (x86)\Tencent\微信web开发者工具\微信开发者工具.exe" -ArgumentList @("--remote-debugging-port=9223")
& `...cli.bat` open --project "D:\小程序"
```

- 目标列表：`http://127.0.0.1:9223/json`
- 求值助手：`node %TMP%\opencode\cdp-eval.js "<url子串>" "<base64表达式>"`（simulator-app-session=小程序逻辑层，wx 可用；cloudconsolev1=云控制台 webview，cloudApi 可用）
- IDE 会闪退/被关——CLDP 失联先查进程与端口，重启即可
- **云控制台 webview 卡死**时：`cdp-raw.js ... Page.reload` 重载后恢复

## 边界与禁区（防 AI 误伤）

1. **不真发推送/不动配额**：订阅额度是用户的资产；除非为验收且用户同意，不通过 openapi.send 消耗额度
2. **不删 follows/watchState 用户数据**（探针文档自建自删，用完即清）
3. **debugProbe 类临时云函数**：删除云函数用 `cloudApi.scfDeleteFunction`，本地目录同步删除，不留垃圾
4. **部署验证只看输出表格**，不看 exit code；`--remote-npm-install` 函数创建中（Creating 状态）等 20s 重试
5. 修改权限/环境配置必须跟用户确认——直接影响线上可用性

## 常用诊断

```powershell
npm test                        # node --test scripts/*.test.js（聚合全部单测）
node scripts/doctor.js          # 配置/同步/产物/环境 一键体检（AI 热启动先跑这个）
npm run typecheck && npm run lint
```

云侧（IDE CDP 可用时，cloudconsolev1 webview）：
- `cloudApi.tcbCountRecords/tcbQueryRecords({envId, tableName, mgoQuery})` 查集合
- `cloudApi.scfGetFunctionInfo({functionName:'watchLive', namespace:'bome-livedongyailongwang-d91c6e8'})`
- 心跳证据：`watchState` 的 `meta__pacing.lastRoundAt`（每轮必写，含跳轮）
