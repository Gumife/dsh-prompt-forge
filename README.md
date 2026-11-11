# 提示词锻造（dsh-prompt-forge）

> 在输入框工具行挂一个 ✦。写完草稿点它，把口语化草稿改写成 agent 能照着做完的提示词，结果直接替换草稿，不满意一次 Ctrl+Z 回退。

> **个人自用项目。** 不是通用产品：接口随我自己需要变动，不承诺向后兼容，也不承诺响应时间。开源只为代码可读、可改、可搬零件；你要用，请自己读代码、自己承担后果。

## 为什么需要它

你写的是「帮我把那个登录页改一下，加个记住我，别搞太复杂，明天要上线」。agent 需要的是另一套东西：改哪个文件、边界在哪、怎么算做完。

直接让模型改写有三个坑：

1. **事实丢失**——`index.js` 被写成 `index`，`v0.6.0` 变成 `0.6`，路径少一段。
2. **凭空加约束**——需求里没提的东西被补进去，改写结果比原稿还长，但没一条是你想要的。
3. **没有验收标准**——改写完了，谁也不知道做到什么程度算完成。

这个插件在改写链路上加了闸：改写前抽出硬事实，改写后逐个要求逐字出现；要求输出带验收标准，草稿本来就没有可核对目标时明确说出来，而不是编一个。

## 它做什么

- **硬事实保真闸**——正则抽出代码、路径、URL、文件名、版本号、点号标识符，改写后逐个校验字面量；漏了先自动修复一次，仍漏就如实回报，不偷偷放行。
- **验收补全**——正文末尾要求 `## 验收标准`（3–6 条可客观核对的项，且只能来自草稿已表达的目标）。草稿本来就没有可核对目标时，模型输出固定哨兵 `NO_VERIFIABLE_ACCEPTANCE`，代码按字符串比较判定——不靠「文中出现验收标准四个字」这种会被否句骗过的检查。三态呈现：通过 / 已声明无目标 / 需复核，绝不伪造。
- **工作区文档感知**——从会话 cwd 读 `AGENTS.md` → `GLOSSARY-MAP.md` → `GLOSSARY.md` → `README.md`，默认最多 3 份、每份 1800 字符封顶；读不到就静默跳过。可一键关闭。
- **改写判定**——定稿后同一条链路判四个信号（保真 / 深度 / 落地性 / 可执行性），**只标注不改字**。判不出来渲染成灰色，绝不渲染成通过——沉默不能被读成批准。
- **费用计量**——`usageTotal` 汇总本次全部模型调用（含事实修复、验收重试、判定），`cost` 按峰谷费率折算。没有用量回报时是 `null`，界面显示「费用未知（不等于免费）」。

## 安装

需要 DeepSeek Harness。版本区间看 `package.json` 的 `engines.dsh`，不满足时宿主会直接拦下并说明原因。

**方式一：直接从 GitHub 装**（不用先克隆，锁当时 HEAD commit）

```powershell
plugin_manager install_bundle(target='github:Gumife/dsh-prompt-forge')
```

**方式二：克隆到本地再指向目录**（要读代码、要改就用这个）

```powershell
git clone https://github.com/Gumife/dsh-prompt-forge.git
plugin_manager install_bundle(target='<克隆路径>/dsh-prompt-forge')
```

不要手改 profile 的 `package.json` / `cordis.patch.yml`，也不要在 profile 目录跑 pnpm；卸载走 `remove_bundle`。

**改完 `client.js` 或 `index.js` 必须整进程重启宿主，刷新页面不够。**

## 用法

1. 在输入框写草稿。
2. 点 ✦ → 悬停展开模式单选（保真优化 / 验收补全）与工作区文档开关。
3. 点击即改写，结果直接替换草稿；不满意一次 Ctrl+Z。
4. 改写中再点一次 = 取消（90 秒超时兜底）。

回执报字符数、事实计数、验收三态、结果是否被截断、有没有凭空新增的字面量。改写结果与原文完全一致时不写回，回执直说「一致」。

切换会话不会丢掉在飞的改写：卡片卸载后结果按 sessionId 停住，等这个会话重新挂载再落地。

## 结构

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 半，注册 `POST /prompt-forge/api`，命令 `config` / `rewrite` / `settings-get` / `settings-set` / `diagnose`；另导出四个费用纯函数供测试直调 |
| `client.js` | Client 半，`conversation.input.left` 挂 ✦ 按钮、悬停展开选项、点击即改写并替换草稿 |
| `host-authority.mjs` | 会话对象形状与路由解析的取数层 |
| `cordis.patch.yml` | 挂载声明（`name` 必须等于包名） |
| `verify-host.mjs` / `verify-client.mjs` | 桩驱动契约测试，不需登录态 |
| `verify-live.mjs` | 真机验收，打真实宿主接口 |
| `probe-sentinel.mjs` | 真实调用模型，验证哨兵值行为（stub 测不出这一层） |
| `dev.mjs` | 本地开发辅助 |

## 验证

```bash
node verify-host.mjs && node verify-client.mjs   # 桩驱动，不需登录态
node verify-live.mjs [authority] [sessionId]     # 真机，cookie 自动铸造
```

`verify-client.mjs` 会**真正执行** client 的 factory——这是唯一能抓到「CSS 模板里混进反引号」这类加载期语法错误的手段（`node --check` 看不出来）。

`verify-live.mjs` 里有一条断言专门查 `config` 里只有当前源码才会输出的字段，用来区分「新代码」和「改完之后没重启的旧进程」——否则整套断言对旧构建也照样全绿。

真机校验的 sessionId 用**宿主 id**（带 `session-` 前缀）。`~/.dsh/sessions/--…--/` 下的目录名是**裸 uuid**，那是磁盘日志文件名，传它会得到 `sessions.get() === undefined`，现象和「插件坏了」一模一样。

## 发布

已开源到 GitHub（MIT），**不发布 npm**，安装走 git 源。`private: true` 保留——它只阻止 `npm publish`，不阻止 git 源安装，等于给「误发 npm」留了一道保险。
