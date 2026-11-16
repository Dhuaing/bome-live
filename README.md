# 播了么

抖音主播开播状态查询 + 开播提醒。Taro 4 + React 18 + TypeScript，构建 **微信小程序**。

## 功能

- 输入抖音号（或粘贴直播间地址）关注主播
- 查看已关注主播的实时开播状态、在线人数、开播时长
- 开播时自动推送微信提醒：云端定时巡检为主体（关机也提醒），本机脚本备用

## 技术栈

| 层 | 选型 |
|---|---|
| 框架 | Taro 4.1.9 + React 18 |
| 语言 | TypeScript 5 |
| 样式 | Sass + CSS Modules |
| 构建 | webpack 5 |
| 后端 | 微信云开发（云函数 + 云数据库） |
| 数据源 | 抓取 `live.douyin.com` 的 SSR 页面 |

## 目录结构

```
├─ src/
│  ├─ app.tsx / app.config.ts     全局入口、路由（4 页）、tabBar（3 项）
│  ├─ pages/
│  │  ├─ home/                    首页（主打卡片 + 我的订阅）
│  │  ├─ subscribe/               订阅页（输入抖音号关注/取关）
│  │  ├─ mine/                    我的页
│  │  └─ streamer-detail/         主播详情页（路由参数 id = 抖音号）
│  ├─ hooks/
│  │  ├─ useFollowsWithStatus.ts  关注列表 + 实时状态合并（三个 tab 页共用）
│  │  └─ useLiveStatus.ts         单个主播状态轮询（详情页用）
│  ├─ services/
│  │  ├─ cloud.ts                 云函数调用封装（失败抛错）
│  │  ├─ streamer.ts              getStreamerStatus / toggleFollow / getUserFollows
│  │  └─ liveStatusCache.ts       状态查询的 TTL 缓存 + 并发合并
│  ├─ store/streamer.tsx          关注状态 Context（乐观更新 + 回滚）
│  ├─ components/                 StreamerCard / StreamerAvatar / LiveStatusBadge / EmptyState
│  ├─ constants/                  platform.ts（平台展示）/ cloud.ts（环境配置）
│  ├─ utils/time.ts               时间格式化
│  └─ types/                      类型定义
├─ cloudfunctions/                微信云函数
│  ├─ getStreamerStatus/          抓抖音 SSR 查询开播状态（带 25s 缓存）
│  ├─ getUserFollows/             读云数据库 follows 集合（按 openid 隔离）
│  ├─ toggleFollow/               写云数据库 follows 集合
│  └─ watchLive/                  定时巡检 + 订阅消息推送 + 故障告警（见 docs/开播提醒云化方案.md）
├─ scripts/                       巡检与工具脚本
│  ├─ follows-store.js            关注列表读写（巡检读取）
│  ├─ cloud-env.js                云环境配置（Node 侧）
│  ├─ watch-live.js               开播巡检 + nanobot 推送
│  └─ svg2png-tabbar.js           tabBar 图标 SVG → PNG（微信不支持 svg）
├─ config/                        Taro 构建配置
└─ types/                         全局类型声明
```

## 开发

```bash
# 安装依赖（webpack 版本冲突，需加 --legacy-peer-deps）
npm install --legacy-peer-deps

# 构建
npm run build:weapp     # → dist-weapp/

# 开播巡检
npm run watch:live
node scripts/watch-live.js --once         # 只跑一轮
node scripts/watch-live.js --test-notify  # 测试微信推送链路
node scripts/watch-live.js --reset        # 清空巡检状态
```

### 微信小程序

用微信开发者工具打开**项目根目录**（不是 `dist-weapp/`），
`project.config.json` 里的 `miniprogramRoot` 已指向 `dist-weapp/`。

**首次使用需要：**
1. 把 `project.config.json` 的 `appid` 换成你的真实 AppID（当前是 `touristappid`，游客模式无法使用云开发）
2. 在云开发控制台创建集合 `follows`，权限设为「仅创建者可读写」
3. 右键 `cloudfunctions/` 下每个函数 → 上传并部署

## 数据存储

| 端 | 存储 | 隔离方式 |
|---|---|---|
| 小程序 | 云数据库 `follows` 集合 | 微信自动注入 `_openid`，按用户隔离 |

## 环境配置

云开发环境 ID 集中在两处，都支持环境变量覆盖：

- 前端：`src/constants/cloud.ts`，值由 `config/index.ts` 的 `defineConstants` 编译期注入
- Node 脚本：`scripts/cloud-env.js`

订阅消息模板 ID 走同一机制：

```bash
SUBS_TEMPLATE_ID=your-tmplId npm run build:weapp   # 小程序端「开启提醒」入口由它点亮（留空则隐藏）
```

> 注意：源码里不要直接写 `process.env.XXX`（未在 `defineConstants` 声明的键
> 会原样进入产物，导致运行时 `process is not defined` 白屏）。

## 已知限制

- **数据源单一**：完全依赖抓取抖音 SSR 页面。抖音改版会导致查询失效，
  届时需调整 `cloudfunctions/getStreamerStatus/index.js` 里的 `extractEscapedObject` 解析逻辑。
  连续失败 ≥3 轮时云端会主动推送故障告警（需用户攒过订阅额度）。
- **提醒额度依赖授权**：个人小程序只有一次性订阅消息，
  用户每次在小程序里点「开启」攒一条推送额度，没攒过额度收不到。
- **两链路勿同开**：云端 watchLive 与本机 watch-live.js 状态互不同步，同开会对同一场直播重复推送。

> 云函数网关的访问鉴权（CloudBase 控制台配置）仍为关闭状态。
> 小程序端只通过 `Taro.cloud` 调用云函数（微信注入 openid）；
> **若要扩展为公网 HTTP 网关，必须先重新评估整套鉴权方案。**

## 共享规则（单一真相）

项目的三个运行环境**无法在运行时共享代码**：

| 环境 | 构建方式 | 限制 |
|---|---|---|
| `src/` | Taro/webpack 打包 | 只解析 `src/` 内路径与 `@/` 别名 |
| `scripts/` | Node CJS 直接运行 | 无法 import TS |
| `cloudfunctions/` | 微信独立部署 | 只能 require 自己目录内的文件 |

但「关注记录怎么构造」这个规则必须只有一份。做法是**规则单一真相 + 构建时生成**：

```
shared/follow-rules.json          ← 唯一手改的地方
        │
        │ npm run gen:rules
        ▼
├─ src/utils/followRecord.ts      前端 TS
├─ scripts/follow-record.js       Node CJS
└─ cloudfunctions/_shared/follow-record.js  云函数 CJS
        │
        │ npm run sync:cloud（build:weapp 自动执行）
        ▼
   cloudfunctions/*/_shared/follow-record.js  各函数副本
```

**改规则的流程：**

```bash
# 1. 编辑 shared/follow-rules.json
# 2. 重新生成
npm run gen:rules
# 3. 确认三份生成物一致
npm test
# 4. 提交（含生成物）
```

生成物带「自动生成，请勿手改」头。`npm run check:rules` 会检测是否有人手改或忘记重新生成，可接入 CI。

`scripts/follow-record.consistency.test.js` 逐项比对三份实现的行为，任何分叉都会让测试失败。

## 扩展接缝（自用 → 开源）

当前按「单人自用」运行，但数据层预留了可替换的接缝。详见 [docs/扩展接缝设计.md](docs/扩展接缝设计.md)。

```
业务代码（store / hooks / pages）
        │ 只依赖接口
        ▼
src/services/ports.ts          FollowRepository / LiveStatusProvider / IdentityProvider
        │
        ▼
src/services/streamer.ts       cloudFollowRepository / cloudLiveStatusProvider（当前实现）
        │
        ▼
src/services/cloud.ts          传输层（Taro.cloud）
```

**换数据后端的成本**：新增一个实现文件，业务代码不动。

已有的实现：

| 实现 | 用途 |
|---|---|
| `cloudFollowRepository` | 当前：`Taro.cloud` 直连云函数 |
| `createMemoryFollowRepository` | 测试用，也是「如何写一个新实现」的样板 |

`scripts/ports.contract.test.js` 验证任意实现都能满足同一套契约，并遵循相同的字段清洗规则。

**已做的三处解耦**：

1. **契约独立** —— `ports.ts` 只有 interface，业务代码不 import 具体实现
2. **RPC 名收敛** —— `services/rpc.ts` 集中方法名，换 REST 只改一处映射
3. **返回归一化** —— `toFollowList()` / `toFollowResult()` 吸收后端结构差异

## 质量门

```bash
npx tsc --noEmit       # 应为 0 错误
npm test               # 22 个单测（规则一致性 + 接口契约）
npm run check:rules    # 生成物与规则源是否同步
npx eslint src         # 建议接入 CI
```
