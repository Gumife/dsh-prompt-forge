# dsh-prompt-forge 开工接力单

> 写于 2026-10-21（会话：提示词优化插件调研）。本文件自带全部上下文，新会话（创造模式/cordis 预设）读这一份即可开工，无需回看调研会话。

## 一、使命（一句话）

做一个 DSH 输入框提示词优化插件 **dsh-prompt-forge**：把用户口语化草稿改写成 agent 可执行的提示词，**独有两能力：验收补全 + 工作区文档感知**——这两点是全部竞品都没做的，也是用户真实输入抽样的最大缺口。

用户画像（来自历史会话抽样）：输入短、口语化、几乎从不写验收标准（「怎么算完成」）。插件要在发送前把这些补上，而不是逼用户改变输入习惯。

## 二、竞品情报（2026-10-21 实查，全部 GitHub 开源 MIT）

| 项目 | 星 | 状态 | 关键事实 |
|---|---|---|---|
| [hoyyang/dsh-improve-prompt](https://github.com/hoyyang/dsh-improve-prompt) | 5 | 断更（9/24 后作者沉默） | 保真闸（硬事实提取→逐字校验→确定性回灌）是精髓，值得学；**但 npm 0.7.2 在 DSH 0.2.x 装不上**（issue #1/#2：裸包名 `import 'schemastery'` → ERR_MODULE_NOT_FOUND），修复 PR #3 未合 |
| [1321928757/dsh-prompt-polish](https://github.com/1321928757/dsh-prompt-polish) | 3 | 活跃（10/16 推代码） | 6 模式×3 语言 + 目标/todo/压缩摘要/工具结果上下文；**雷**：issue #1——apply 时缓存 `ctx.get('llm')`，并发加载下拿到 undefined，Optimize 恒报「没有可用的模型服务」，0.2.1-rc.2 命中 |
| [winditer/dsh-prompt-optimizer](https://github.com/winditer/dsh-prompt-optimizer) | 5 | 低活跃 | 流式预览（先看思考）、Alt+O、复用会话模型；npm 名 `dsh-prompt-optimizer` 被多个无关插件共用 |
| [zhengzeyong9527-droid/ai-input-enhancer](https://github.com/zhengzeyong9527-droid/ai-input-enhancer)（原 zzy-dsh-prompt-optimizer） | 1 | 停滞（9/11） | **唯一接工作区的**：最多读工作区根 3 个相关 .md；但 README 的 npm 安装命令是死的（npm 404），只能 GitHub 源装，零第三方实测 |
| [EmotionG/dsh-prompt-optimizer](https://github.com/EmotionG/dsh-prompt-optimizer) | 0 | 停滞（9/17） | 唯一在 dsh 0.2.1-rc.2 有第三方 L5 运行时实测徽章（dsh.so），零已知 bug，无工作区上下文 |

**市场空白**：全品类 star 个位数、作者普遍断更；「验收补全」无人做，「工作区文档」仅 zzy 做且已死。差异化组合 = 护城河。

## 三、宿主环境事实（本机实测口径）

- DSH 桌面版 `@deepseek-ai/dsh-desktop-runtime` **0.2.1-rc.2**，Electron packaged，宿主 asar：`D:\Ruanjian\DeepSeek Harness\resources\app.asar\dsh\`
- profile：`C:\Users\17152\.dsh\profiles\desktop`；工作区：`E:\deepseek-workspace`
- **packaged 版无 dev:web watcher：client.js 改动必须整进程重启宿主才生效**（bundle rev = hash(mtimeMs,ctimeMs,size)，刷新页面只重取同一 rev）；重启后 Web GUI 端口会变
- **已开过轮次的会话无法切 preset**（AgentPresetRegistry.select() 抛 agent-preset/locked）——所以本插件开发必须在「新建任务」时选 cordis 预设（本文件就是在 cordis 会话里执行的前置条件）
- 本地装包走 plugin_manager install_bundle 传绝对路径（见 model-radar 经验），不要手写 profile 的 package.json/cordis.patch.yml

## 四、可复用资产（就在本工作区）

| 资产 | 位置 | 用法 |
|---|---|---|
| 已装活过的插件骨架 | `E:\deepseek-workspace\dsh-model-radar\`（index.js host 268 行 + client.js 516 行 + cordis.patch.yml + package.json + locale） | 照抄结构：host 半身（ctx 服务注入 + 自有 /api 路由）、client 半身（__ModuleLoader__ bundle + 槽位注册）、verify-host/verify-client 脚本 |
| asar 提取工具 | `dsh-model-radar\tools\asar.mjs`、`asar-list.mjs` | 挖宿主源码用：composer 草稿读写契约（setDraft/draft props）、llm.stream 参数 |
| 已验证的弹层代码 | model-radar client.js | min-height:0、尺寸公式、ResizeObserver 定位直接搬 |
| 精确复盘 | `E:\deepseek-workspace\.scratch\session-dump-b528823c\REVIEW.md`、`HANDOFF.md` | 槽位接管失败全案 |

## 五、产品定义（MVP）

1. **入口**：`conversation.input.left` 槽注册 ✦ 按钮（**只碰 input.left，绝不接管 conversation.input.model**——model-radar 血泪：replaceRisk shadows-shipped-ui 无退路）
2. **预览对比卡**：原稿 vs 改写并排，采纳/保留/放弃，绝不自动覆盖
3. **三模式**：
   - 保真优化：清哧表达，不虚构需求
   - **验收补全（独有）**：改写时强制生成「怎么算完成」段（可验证的验收口径）
   - 规格扩展：补默认项必须显式标 `## Default assumptions`
4. **上下文三源**（各自字符预算、默认关闭可开）：会话最近几轮 / **工作区根目录 Markdown**（AGENTS.md、GLOSSARY-MAP.md 优先，最多 3 文件）/ 草稿本体
5. **保真闸**（学 improve-prompt）：本地正则提取硬事实（路径/标识符/版本/URL/反引号代码）→ 改写后逐字校验存活 → 缺失先修复调用一次 → 仍缺则确定性回灌
6. 模型路由：默认会话模型；provider+model 可配覆盖；reasoningEffort 默认 low（改写是浅任务）

## 六、避雷清单（验收必过项）

| # | 雷 | 来源 | 对策（写死） |
|---|---|---|---|
| 1 | apply 时缓存 `ctx.get('llm')` → 恒报无模型服务 | polish issue #1 | `inject` 声明 `llm`；**每次请求惰性重取** `ctx.get('llm')`，绝不缓存实例 |
| 2 | 裸包名 import（schemastery/cordis） | improve issue #1/#2 | 只 import `@deepseek-ai/*` 域名包；peerDependencies 键名同 |
| 3 | client.js CSS 模板字符串内出现反引号 | model-radar 实测 | verify 脚本**真执行 factory**（node --check 查不出来）；写 CSS 注释禁用反引号 |
| 4 | 弹层子项无 min-height:0 → 滚不动 | model-radar 契约 | 复用已验证弹层实现 |
| 5 | bundle id ≠ 包名 → arrive() 抛错 | winditer README | build 脚本硬编码校验 id === package name |
| 6 | 用 session.create/fork 做生成 → 永远转圈 | winditer README | Host 半身直接 `llm.stream`，不经会话 |
| 7 | connection.rpc.call 桌面版第二次调用挂起 | winditer README | Host 通道走 HTTP（webServer 路由），不走 rpc |
| 8 | 桌面版无 HMR：改 client.js 刷新无效 | model-radar 实测 | 每轮验证整进程重启；verify 流程固化 |
| 9 | 新发布 npm 撞 minimumReleaseAge | winditer README | 若发 npm，预期 profile 预检可能拦新版本（<24h），必要时加 minimumReleaseAgeExclude 或先 GitHub 源 |

## 七、分期与验收信号

| 期 | 内容 | 验收（全部要真实执行证据，不许口头完成） |
|---|---|---|
| P0 骨架 | 照 model-radar 结构立 dsh-prompt-forge：✦ 按钮挂上 `conversation.input.left` + `/prompt-forge/api/config` 空转 | 装进 profile → 整进程重启 → GUI 按钮可见 + curl config 返回 200 |
| P1 管线 | 保真优化模式 + 硬事实闸 + 会话上下文 + 预览采纳流 | 真实模型跑一条草稿改写：保真计数显示、硬事实零丢失、采纳后草稿替换、放弃后原稿不动 |
| P2 差异化 | 工作区文档上下文 + 验收补全模式 + 设置持久化（localStorage + 工作区文件双写，写失败静默降级） | ①带 AGENTS.md 上下文的改写能引用工作区约定 ②验收补全模式产出含验收段 ③重启后设置仍生效 |
| P3 收尾 | README + 发布决策（npm/GitHub/暂不发） | README 含避雷清单六/九条；发布走用户确认 |

体量预估：约为 model-radar 的 60%（无席位接管、无雷达布局）。P0+P1 一个专注会话可闭环。

## 八、开工口径（给新会话第一轮）

1. 本文件读完直接开 P0，不重复调研
2. 每完成一期先跑验收证据再进下一期；改完 client.js 整进程重启宿主（端口会变，用新端口验证）
3. 终端命令用 pwsh 7（`C:\Program Files\PowerShell\7\pwsh.exe`），不用 5.1
4. 若需挖宿主契约（setDraft/draft props、llm.stream），先跑 `node dsh-model-radar/tools/asar-list.mjs` 定位，再 `asar.mjs` 提取对应 client/index 源文件，只读不写 asar
