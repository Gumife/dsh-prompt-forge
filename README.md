# dsh-prompt-forge

> **这是个人自用项目，不是通用产品。**
> 它是我自己日常在用的工具，开源只是为了代码可读、可改、可搬零件。
> 接口随我自己的需要变动，**不承诺向后兼容**；遇到问题欢迎提 Issue，但**不承诺响应时间**。
> 你要用，请自己读代码、自己承担后果。

把口语化草稿锻造为 agent 可执行提示词。选中草稿点 ✦ 直接改写并替换，不满意一次 Ctrl+Z 回退。

四个能力：

- **硬事实保真闸** —— 改写前用正则抽出代码、路径、URL、文件名、版本号、点号标识符，改写后逐个要求字面量逐字出现；漏了先自动修复一次，仍漏就如实回报，不偷偷放行。
- **验收补全** —— 要求正文末尾带 `## 验收标准`（3–6 条可客观核对的项，且只能来自草稿已表达的目标）。草稿本来就没有可核对目标时，模型输出固定哨兵 `NO_VERIFIABLE_ACCEPTANCE`，代码按字符串比较判定——不靠"文中出现「验收标准」四个字"这种会被否句骗过的检查。三态呈现：通过 / 已声明无目标 / 需复核，绝不伪造。
- **工作区文档感知** —— 从会话 cwd 读 `AGENTS.md` → `GLOSSARY-MAP.md` → `GLOSSARY.md` → `README.md`，默认最多 3 份、每份 1800 字符封顶；读不到就静默跳过，改写照常可用。可一键关闭。
- **改写判定** —— 定稿后同一条链路判四个信号（保真 / 深度 / 落地性 / 可执行性），**只标注不改字**。判不出来渲染成**灰色**，绝不渲染成通过——沉默不能被读成批准。

**费用计量**：响应里 `usageTotal` 汇总本次**全部**模型调用（含事实修复、验收重试、判定），`cost` 按峰谷费率折算（北京时间，与本机时区无关）。没有用量回报时是 `null`，界面显示「费用未知（不等于免费）」。

## 安装

需要 DeepSeek Harness，版本区间由 `package.json` 的 `engines.dsh` 声明——不满足时宿主会直接拦下并说明原因。

**方式一：直接从 GitHub 安装**（不用先克隆）

```powershell
plugin_manager install_bundle(target='github:Gumife/dsh-prompt-forge')
```

**方式二：克隆到本地，再指向目录**（适合要读代码、要改的情况）

```powershell
git clone https://github.com/Gumife/dsh-prompt-forge.git
plugin_manager install_bundle(target='<你的克隆路径>/dsh-prompt-forge')
```

不要手改 profile 的 `package.json` / `cordis.patch.yml`，也不要在 profile 目录跑 pnpm。卸载走 `plugin_manager` 的 `remove_bundle`，别手工删目录。

**改完 `client.js` 或 `index.js` 必须整进程重启宿主才生效，刷新页面不够。**

`github:` 源安装锁定当时的 HEAD commit，升级要重新执行一次安装。

## 用法

1. 在输入框写草稿
2. 点 ✦ 按钮 → 悬停展开模式单选（润色 / 验收补全）与工作区文档开关
3. 点击即改写，结果直接替换草稿；不满意一次 Ctrl+Z
4. 改写中再点一次 = 取消（90 秒超时兜底）

回执报字符数、事实计数、验收三态、结果是否被截断、有没有凭空新增的字面量。改写结果与原文完全一致时不写回，回执直说「一致」。

切换会话不会丢掉在飞的改写：卡片卸载后结果按 sessionId 停住，等这个会话重新挂载再落地。

## 结构

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 半。注册 `POST /prompt-forge/api`，命令有 `config` / `rewrite` / `settings-get` / `settings-set` / `diagnose`；另导出四个费用纯函数供测试直调。 |
| `client.js` | Client 半。`conversation.input.left` 挂 ✦ 按钮、悬停展开选项、点击即改写并替换草稿。 |
| `host-authority.mjs` | 会话对象形状与路由解析的取数层。 |
| `cordis.patch.yml` | 挂载声明（`name` 必须等于包名）。 |
| `verify-host.mjs` / `verify-client.mjs` | 桩驱动契约测试，不需登录态。 |
| `verify-live.mjs` | 真机验收，打真实宿主接口。 |
| `probe-sentinel.mjs` | 真实调用模型，验证哨兵值行为（stub 测不出这一层）。 |
| `dev.mjs` | 本地开发辅助。 |

## 验证

```bash
node verify-host.mjs && node verify-client.mjs   # 桩驱动，不需登录态
node verify-live.mjs [authority] [sessionId]     # 真机，cookie 自动铸造
```

`verify-client.mjs` 会**真正执行** client 的 factory——这是唯一能抓到「CSS 模板里混进反引号」这类加载期语法错误的手段（`node --check` 看不出来）。

`verify-live.mjs` 里有一条断言专门查 `config` 里只有当前源码才会输出的字段，用来区分「新代码」和「改完之后没重启的旧进程」——否则整套断言对旧构建也照样全绿。

真机校验的 sessionId 用**宿主 id**（带 `session-` 前缀）。`~/.dsh/sessions/--…--/` 下的目录名是**裸 uuid**，那是磁盘日志文件名，传它会得到 `sessions.get() === undefined`，现象和「插件坏了」一模一样。

## ⚠️ 市场里那条升级别点

插件市场（`dshm_list`）会把本插件标成 outdated：本地 `0.5.0`，`latestVersion` 指向 `1.2.2`。**那条升级不能点。**

`dsh-prompt-forge` 这个名字在 npm 上属于别人的包（维护者 `aliboder`，仓库 `github.com/Aliboder/dsh-prompt-forge`），与本插件**同名异物**。判据是特征字符串而不是版本号：本地 `index.js` 命中 `NO_VERIFIABLE_ACCEPTANCE` / `maxWorkspaceDocs` / `/prompt-forge/api` / `settings-set` / `acceptance` / `diagnose` 六项，上游全不命中；上游从 `v1.0.0` 起就是 `lib/` + `test/` 多文件结构且带 CHANGELOG，本地是单文件 `index.js`。

点下去的后果：profile 里的 `link:` 会被换成那个 npm 包，本地这套代码**当场脱钩**——保真闸、验收补全、工作区文档、费用计量全部消失，而这些恰好是上游没有的东西。

要彻底解耦就改名（如 `dsh-prompt-forge-local`），需同步改 `cordis.patch.yml` 的 `name` 与 profile 里的 `link:` 路径。不改的话角标一直红着，是已知噪音，不影响运行。

## 发布

已开源到 GitHub（MIT），**不发布 npm**，安装走 git 源。`private: true` 保留——它只阻止 `npm publish`，不阻止 git 源安装，等于给「误发 npm」留了一道保险。
