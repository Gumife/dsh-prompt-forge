# dsh-prompt-forge

把口语化草稿锻造为 agent 可执行提示词的 DSH 插件。差异化能力：**硬事实保真闸** + **验收补全** + **工作区文档感知** + **改写判定**。

当前阶段：**P3 评估侧 + 费用计量已完成**（`/prompt-forge/api` 的 `rewrite` 命令：抽取硬事实 → 改写 → 逐字校验 → 至多一次修复 → 确定性回注；新增工作区文档上下文、验收补全模式、设置双写持久化；客户端读草稿、点击 ✦ 直接改写并替换草稿，不满意一次 Ctrl+Z 回退）。

- 分期计划与验收口径：见 `KICKOFF.md`
- P1：保真优化管线 + 硬事实闸 + 会话上下文 + 悬停选模式、点击即改写 ✅
- P2：工作区文档上下文 + 验收补全模式 + 设置持久化 ✅
- P3：README 完整化 + 发布决策 ✅（已定：暂不发，保持 `private` + 本地 Junction）
- P3 追加：改写判定（评估侧）✅ —— 改写定稿后同一条链路判四个信号，只标注不改文本
- 0.5.0：费用计量 ✅ —— `usageTotal` 汇总一次改写的**全部**模型调用，`cost` 按峰谷费率折算（当前版本 `0.5.0`）

## 结构

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 半：注册 `POST /prompt-forge/api`；`config` / `rewrite` / `settings-get` / `settings-set` / `diagnose`。另导出四个费用纯函数（`beijingParts` / `billingPeriod` / `sumUsage` / `costOf`）供测试直调 |
| `client.js` | Client 半：在 `conversation.input.left` 挂 ✦ 按钮；悬停展开三个选项（模式单选 + 文档开关）、移出自动收起、点击即改写并直接替换草稿、改写中再点一次即取消（90 秒超时兜底）。回执除字符数与事实计数外，还报告验收三态、结果被截断、凭空新增的字面量（后者悬停看具体项）；改写结果与原文完全一致时不写回，回执改说「改写结果与原文一致」 |
| `cordis.patch.yml` | bundle patch，把插件挂进 profile |
| `verify-host.mjs` | Host 契约测试：路由、鉴权透传、守卫、特性地图、保真闸三态、档位能力降级、会话路由折叠、工作区文档、验收补全、设置持久化、config 旋钮接线（含 `maxFactCount` 上下限夹取）、分节 system prompt、双向硬事实闸、事实上限、输出预算与截断、每个用户输入都不可伪造分节或越界闭容器、判定默认开启/独立提示/只标注不改文本/冲突信号由代码派生/解析失败绝不默认通过（239 条断言，无需凭据与真实模型） |
| `verify-client.mjs` | Client 半的槽位/渲染/悬停开合/点击即改写/改写中取消/忙碌态动效（含空闲↔忙碌 120ms 交叉淡化）/模式单选与文档开关语义/一键替换回执（含验收三态、截断与凭空新增提示、无变化守卫）/事实上限提示/切会话后补写/设置分桶/白名单清洗契约测试/判定行三态（通过·需复核·未返回，后者必须是灰的而不是绿的）（306 条断言） |
| `verify-live.mjs` | 真机验收：打真实宿主 `POST /prompt-forge/api`（需登录态 cookie，自动从 `~/.dsh/.credentials.yaml` 铸造）。其中一条断言查 `config` 里只有当前源码才会输出的字段，**用来区分「新代码」与「改完之后没重启的旧进程」**——否则整套断言对旧构建也照样全绿 |
| `probe-sentinel.mjs` | 真机模型探针：**唯一能证明「模型真的会照第 6 条输出哨兵值」的测试**，两次真实调用——无目标草稿应 `declared:true`，有具体目标的草稿应 `present:true`（哨兵不能变成所有草稿的通用逃生口）。stub 测不出这一层 |

## P2 三个差异化能力

1. **工作区文档上下文**：从会话 `cwd` 读 `AGENTS.md` → `GLOSSARY-MAP.md` → `GLOSSARY.md` → `README.md`，默认最多 3 个文件（`maxWorkspaceDocs` 可调，0 关闭）、每份 1800 字符封顶；读不到就静默跳过，改写照常可用。客户端可一键关闭（`workspaceDocs:false`）。
2. **验收补全模式（自动）**：`mode:'acceptance'` 时 system prompt 强制要求正文末尾追加 `## 验收标准`（3–6 条可客观核对的检查项，且只能来自草稿已表达的目标）。模型漏写会触发一次修复；仍漏则如实回报 `acceptance.present:false`，**绝不伪造**验收段。

   判定是三态而不是二态。最初只看 `rewrite.includes('验收标准')`，于是「暂无验收标准，因为草稿没有可核对的目标」这种**否定**该小节的句子反而通过了检查——只找词不看语义，与小结节相反的句子被当成了小节。现在草稿没有可核对目标时，模型必须输出固定哨兵值 `NO_VERIFIABLE_ACCEPTANCE`，代码按字符串比较判定 `acceptance.declared:true`（这**不是**失败，客户端用中性文案而非黄色警告），哨兵在返回前被剥掉。空标题也不算小节。三态的差别是给客户端的：`present` 绿、`declared` 中性、两者皆无才黄并触发一次重问。
3. **设置持久化双写**：客户端 `localStorage` 为主（本浏览器权威），同时 POST `settings-set` 写 `<cwd>/.prompt-forge/settings.json`。localStorage 的键按**工作区 cwd 分桶**——同一个浏览器开多个项目时，B 项目不会继承 A 项目的模式；0.3.1 的扁平键会在首次写入时迁移到 `""` 桶，不再污染真实工作区。写失败（只读工作区、无 cwd）返回 `persisted:false` 并静默降级，不报错、不阻塞 UI。

   `cwd` 必须从**会话对象的创建头**取（`sessions.get(id).header.cwd`），会话门面本身不暴露 `cwd`，会话列表投影也不带——`session.header` 正是宿主 agent-loop 自己传给持久化层的那个对象。空白新会话尚无 sessionId，此时持久化必然降级，属设计内行为。响应回显解析到的 `cwd`，便于区分「没有工作区」和「写被拒绝」。

### `diagnose`（只读排障命令）

`{"command":"diagnose","sessionId":"…"}` 回显宿主里会话对象的真实形状：`ownKeys` / `hasHeader` / `headerKeys` / `headerCwd` / `faceCwd` / `resolved`，以及会话列表快照里前几个会话的同样信息。**纯只读，不改任何状态**，唯一用途是让「cwd 到底挂在哪」这类问题当场有答案，而不是靠读 asar 猜。`verify-live.mjs` 每次都先调它并打印，失败时不会变成猜谜。

## 改写判定（P3 评估侧，0.4.0）

这是本插件唯一一处**让模型评价自己输出**的地方，也是唯一一处输出**不改变任何字符**的调用。

### 为什么加

在此之前，插件的每一道闸都是确定性的：字面量有没有逐字保留、有没有出现原稿没有的字面量、验收小节在不在。这些闸能回答「有没有丢东西」，回答不了用户唯一关心的问题——**这一版到底好不好**。「好」不是字符串比较。

### 四条硬约束（写在代码注释里，改代码前先读）

1. **判定永不改写。** 判定是报告，不是编辑。改写文本在调用前冻结，逐字返回。能改写的评估，就能悄悄替自己的失败擦屁股。
2. **用枚举不用分数。** 0–100 分在这个颗粒度上不可证伪——两次跑差 15 分，没人能说哪次错。四个带 `unclear` 成员的枚举可以被反驳。
3. **判定用独立 system prompt，不含 OUTPUT_CONTRACT。** 改写提示要求模型只输出提示词正文；把同一份契约交给裁判，它会用提示词形状的散文来回答。
4. **解析失败必须报 `judged:false`，绝不填默认值。** 把「判定没答」变成「改写通过」，正是这个功能存在的意义要防的那句谎。

### 四个信号

| 信号 | 枚举 | 谁来判 |
|---|---|---|
| `fidelity` | pass / fail / unclear | 模型判，**代码可交叉验证**（`missingFacts`/`addedFacts`） |
| `depth` | deepened / rephrased-only / compressed / unclear | 只有模型能判 |
| `grounding` | grounded / inferred / invented / unclear | 模型判；`addedFacts` 只能抓凭空出现的**字面量**，抓不到凭空出现的需求 |
| `executability` | executable / needs-clarification / blocked / unclear | 只有模型能判 |

`fidelity` 是四条里唯一能被机器证伪的一条——所以它最值钱。判定说 pass 而硬事实闸发现缺失，这是**可证明的错误**，不是意见分歧。

### 冲突信号由代码派生，不问模型

问模型「这几个答案自洽吗」，它倾向答「自洽」，因为自洽是对自己有利的报告。而冲突本来就是代码手里已有的值上的一个布尔量，问一遍只是多一次出错机会。

- `depthIsFabricated`：depth=deepened 且 grounding ∈ {invented, inferred}
- `depthBreaksExecutability`：depth=deepened 且 executability ∈ {blocked, needs-clarification}
- `depthIsCosmetic`：depth=rephrased-only 且 fidelity=pass
- `fidelityContradictsFactGate`：fidelity=pass 且代码发现硬事实缺失

冲突必落 `verdict:'check'`，**永不落 'ok'**。矛盾按定义就不是干净通过，把它当通过是让裁判变成装饰品。

### 判定看到的是模型的文本，不是回注后的文本

判定在**确定性回注之前**取快照。模型丢了事实、代码补回去了，这仍然是模型的一次保真失败，用户该听到。判回注后的文本，等于为模型没做的工作报告一个干净通过。

### 判定失败不代价改写

判定抛异常、超时、返回不可解析内容，一律 `judged:false` + `error`，HTTP 仍是 200，改写原样返回。改写已经过了全部确定性闸，不该因为裁判失联而被吞掉。

界面三种状态，第三种最重要：`judged:false` 渲染成**灰色**，绝不渲染成通过。沉默不能被读成批准。

### 关掉它

请求体传 `judge:false`，或插件配置 `judge:false`。关掉时响应里的 `judge.enabled` 为 false、`judged` 为 false，客户端**不渲染任何判定行**——没问过的事，不报告。

## 费用计量（0.5.0）

一次改写到底调了几次模型，此前没人说。事实修复、验收重试、改写判定都是**额外**调用，而响应里的 `usage` 只报了第一次——判定默认开启时，面板上那个用量数字只有真实成本的三分之一。**结构性低估比没有数字更糟**：用户会拿它去估预算。

现在响应体多两个字段：

| 字段 | 内容 |
|---|---|
| `usageTotal` | 本次请求**所有**模型调用的用量之和，附 `calls`（调用次数）。无任何用量回报时为 `null` |
| `cost` | `{amount, currency, period, multiplier, estimated:true, calls}`。无用量时为 `null` |

`usage` **原样保留**（仍只是第一次调用），因为真机上确实有人在读它；新增而不改动是唯一不破坏既有断言与既有读法的做法。

### 三条算错就会说谎的规则

1. **缓存命中是 `inputTokens` 的子集，不是额外输入。** 正确拆法：`cached = min(cacheRead, input)`，`missed = input - cached`，金额 = `(missed×input费率 + cached×缓存费率 + output×output费率) × 峰谷系数 / 1e6`。当成额外输入会把同一批 token 计两遍。
2. **周末与节假日先于时段判断。** 先判 09:00–12:00 / 14:00–18:00 再看星期几，周六上午就会被双倍计价。本实现的顺序是：先判非工作日（周末**或**节假日），再判时段，窗口左闭右开（12:00 整不算峰时）。周末与节假日谁先谁后无所谓，两者都返回谷时；要紧的是两者都必须在时段判断**之前**。
3. **`null` 不是 `0`。** 模型没回报用量时 `cost` 为 `null`，界面显示「费用未知（不等于免费）」。把未知渲染成 ¥0.00 是在替供应商宣布免费，而这句话收不回来。

峰谷判断固定用**北京时间**（`Intl` → `Asia/Shanghai`），与本机时区无关——费率是供应商按北京时间公布的，跟着本机时区走会让同一笔调用在出差后换个价。

### 界面位置

费用行只在**改写结果面板**里，不写进一键采纳的回执。回执说的是「刚才写进去了什么」，费用说的是「试这一次花了多少」，两句话回答的不是同一个问题；混进回执会让用户以为钱是在点「采纳」那一刻花掉的。

四个纯函数（`beijingParts` / `billingPeriod` / `sumUsage` / `costOf`）从 `index.js` 导出，**只为测试**。峰谷依赖墙上时钟，只能通过真实请求触达的话，测试就永远只能在「跑测试那一刻」的时段上验，边界（12:00 整、周六上午、节假日）一条也钉不住。
## 真机才暴露的三个缺陷（已修）

1. **`reasoningEffort` 是模型能力位，不是常量。** 硬编码 `'low'` 时，不声明该档位的模型会让宿主在派发前抛 `UNSUPPORTED_REASONING_EFFORT`，整条改写 500。改为「先按配置发一次，被拒则去掉该字段重试」——拒绝发生在 provider I/O 之前，重试零 token 成本，响应里如实回报 `effort`。
2. **新会话拿不到模型路由。** `requestContext()` 在首轮之前是空的，而 `agent.options` 冻结创建期默认值（会报出输入框里已不显示的模型）。改为折叠会话事件：pending `model/selection` ?? 最后一条 `request/header`，再兜底 `agentDefaultModel.currentSelection()`。
3. **`cwd` 在 `session.header` 上，不在会话门面上。** 设置双写一直静默降级成 `persisted:false`，因为 `sessions.get(id).cwd` 恒为 `undefined`。真身是创建头 `sessions.get(id).header.cwd`（宿主 agent-loop 传给持久化层的就是这个对象）。前两版 stub 都把 `cwd` 放在顺手的位置，于是测试全绿而真机全废——**stub 一旦比现实更宽容，它就是 bug 的共犯**。
4. **切换会话会让在飞的改写永远写不进去。** 离开一个会话会销毁它的 input shell：宿主的清理里先 `unregister()`（摘掉编辑器 update 监听，于是投影不再刷新、`rev` 不再递增），再让 `unbindDraftPersistence()` 失效，最后才 `shell.dispose()`。插件卡片随之卸载，而旧的卸载 effect 会 `controller.abort()`——请求死在半路，改写结果根本没进输入框；即使请求活着回来，写进那个已被摘掉监听的编辑器也不会进 per-session store，切回来读到的仍是原文。修法两条一起：卸载**不再 abort**（只置 `mountedRef` 拦掉延迟的 setState），并且落地时若卡片已卸载就把结果按 sessionId 停进模块级 `pendingWrites`，等这个会话重新挂载、`actions` 属于活着的 shell 时再写。**教训：一个"取消"手势写在卸载回调里，就变成了"切走即取消"的隐式语义；而组件卸载并不等于它操作的那个数据面还在。**

四条都是 stub 测不出来的——必须在真机 + GUI 上跑。第 3 条修复后，`verify-host.mjs` 的桩已改成真实形态（只暴露 `header.cwd`），`verify-live.mjs` 也从「`persisted` 是个布尔值」收紧为「`persisted === true` 且回显真实 `cwd`」。

## 本地校验

```bash
node verify-host.mjs && node verify-client.mjs
```

两个脚本都用 stub，不需要登录态，也不碰真实 profile。`verify-client.mjs` 会**真正执行** client 的 factory——这是唯一能抓到「CSS 模板里混进反引号」这类加载期语法错误的手段（`node --check` 看不出来）。

## 真机校验

```bash
node verify-live.mjs [authority] [sessionId]
```

cookie 从 `~/.dsh/.credentials.yaml` 自动铸造，不用手抄。**sessionId 缺省时取 `$DSH_SESSION_ID`**——宿主把它导出给每个子进程，所以不带参数跑就是强分支（验 `persisted === true` 与真实 `cwd`）。只有显式传空串 `''` 才走「无工作区时静默降级」那条弱分支。

id 用**宿主的会话 id**，带 `session-` 前缀（如 `session-b349e38e-…`）。`~/.dsh/sessions/--E-deepseek-workspace--/` 下的目录名是**裸 uuid**，那是磁盘日志文件名、不是宿主 id；传裸 uuid 会让 `sessions.get()` 返回 `undefined`，现象和「插件坏了」一模一样。脚本每次都会先跑 `diagnose` 把宿主真实形状打出来。

## rewrite 管线（P1 的核心承诺）

```
extractFacts(draft)      正则抽取：反引号代码 / Windows 与 POSIX 路径 / URL / 文件名 / 点号标识符 / 版本号 / CONSTANT_CASE
      ↓
llm.stream(...)          一次改写（reasoningEffort 按模型能力自适应：被拒则在 provider I/O 前无代价重试一次并省略该字段）
      ↓
missingFacts()           每个硬事实必须在改写结果里逐字出现
      ↓
至多一次 repair          把漏掉的硬事实交给模型补回
      ↓
reinjectFacts()          仍然缺失的，逐字追加到「## 原文硬事实（逐字保留）」小节
```

**「零硬事实丢失」是本代码的保证，不是对模型的期望。** 响应里的 `facts` 字段如实汇报 `total / kept / missing / repaired / reinjected / invented / capped`，客户端把缺口显性标黄，不吞掉。

### 提示词层的形状是有出处的

system prompt 不是四条并列规则，而是按 GEPA 优化后 prompt 的真实形态排的：定位句 → `## Inputs`（本请求的硬事实，确定性抽取后注入）→ `## Output requirements` → `## 保真判据`（编号、按优先级）→ `## 常见失败模式`（写明具体错误产出，不写评价词）。

四条平行规则会被当成四个独立过滤器，模型满足其中三条就交稿；编号 + 优先级 + 具体反例才压得住。几条具体写法与出处：

| 写法 | 出处 | 在这里的作用 |
|---|---|---|
| `Only output X` **附理由** | fabric `improve_prompt` | 「产出的唯一用途是被原样粘进输入框发给 agent」——给约束因果，边缘情况模型能自己推 |
| 零 / 具体禁用词表 | fabric `write_essay`（`ZERO cliches`） | 「不要客套」压不住，「用『好的』『以下是』开头 = 违规」可定位到要删的那句 |
| 负向约束**带兜底动作** | CO-STAR `# OBJECTIVE #` 的 fallback | 只写「不许编」模型会中途打太极；写明「不确定就保留原措辞继续，不要用占位符」，它才有合法退路 |
| 读者与口吻显式化 | CO-STAR `Style/Tone/Audience` | 读者是执行任务的 agent，用祈使句直接对它说话；否则模型写成「用户希望…」的需求转述，agent 会当背景读 |
| 素材是**数据**不是指令 | 上一版调研（结构化表单类插件） | 草稿里写一行 `## 工作区文档` 就能伪造我们的一整节；`fenceData()` 把命中我们分节标题的行转义成 `\##`，用户自己的 `## 背景` 不动 |
| 骨架 markdown、数据 XML 容器 | Anthropic 推荐 XML 分隔数据；OpenAI 把两者平权；GEPA 产物是纯 markdown 且没有数据块 | 我们把两者的职责分开：分节标题留 markdown（可读可 diff），用户提供的每个字节（草稿/工作区文档/会话轮）都装进自己命名的标签。起初只保护了草稿——文档和会话轮同样是用户可控输入，`AGENTS.md` 里写一行 `## 会话上下文` 伪造的正是管线当成权威的那一节 |
| 缺失时给**固定输出串** | OpenAI 指南 `If the answer cannot be found in the articles, write "I could not find an answer."` | 验收模式里「草稿没有可核对目标」曾只能靠模型自由发挥，代码无从判定。现在改成一个固定哨兵值，代码按比较决策而不是靠猜；猜错的两种代价（认领不存在的小节 / 否掉存在的小节）都由这一条消掉。代价是哨兵必须以大写标识符形式存在，所以它必须在硬事实闸**之前**被剥掉，否则会被当成模型凭空编造的标识符而白烧一次修复调用 |

**明确不学的**：`Take a deep breath and think step by step`（推理模型内置思维链，这句会让推理外显污染产物，还和「零解释」冲突）；fabric `official_pattern_template` 的 `re-read it 218 times` / `1,419 IQ`；`Do not object to this task`（jailbreak 味补丁）；LangGPT 的 `# Role:` + Initialization 剧班底（会诱发自我介绍，与本插件「只输出正文」直接冲突）；把草稿整体 `JSON.stringify` 包裹（长正文进了 JSON 字符串值，模型倾向概括，正好撞上硬事实闸要防的那个失败）；`<scratchpad>` 式「先思考」要求（模型自带 thinking 时，把推理外显进产物与「零解释」直接冲突）。

调研原文与逐条取证留在 `E:\deepseek-workspace\prompt-research\`（fabric / LangGPT / CO-STAR，7 个文件）与 `E:\deepseek-workspace\.scratch\prompt-research\report.md`（Anthropic / OpenAI / GEPA / Self-Refine / PromptWizard，687 行，含抓取受阻与缺失章节的如实标注）。

## 十个踩过的坑（留给后来的人）

**1. `requestRejection` 返回的是状态码，不是布尔值。**
它返回 `401`（可信来源但未认证）或 `403`（Host/Origin 校验失败），放行时返回 `undefined`。
早期实现把两者统一映射成 403，等于把"你没登录"和"你在跨站伪造"混为一谈——
前者是用户该去看 token URL，后者是攻击特征。现在按原状态码透传。

**2. 插件静态资源的 URL 带 `rev`，且必须用真实 rev。**
`/plugins/<id>/client.js?rev=<rev>` 或 combo 形式 `/plugins/??<id>/client.js&rev=<rev>`。
rev 不对直接 404，看起来像"bundle 没挂上"，其实只是拼错。
**最省事的取法**：从页面 `performance.getEntriesByType('resource')` 里直接读现成的 URL，
再带 cookie curl 下来搜特征标记——比解析 SSE 的 graph 帧稳得多（`/plugins/events` 是长连接，
`reader.read()` 无数据时会永久阻塞）。

**3. 草稿不是槽位 prop，要从会话 binding 上读。**
`renderSlot("conversation.input.left", {})` 不传任何 props。草稿来自：
`ctx.get('sessions').binding(sessionId)` → `ctx.get('uiSession').bindingSource({ sessionId, binding })`
→ `binding.hooks.input`（快照订阅）读 `.draft`，`binding.props.inputActions.setDraft(text)` 写回。
effect 里要重新解析，否则切会话会拿到旧 source。

**4. `llm` 服务不能在 apply 时缓存实例。**
并发加载期拿到的实例可能是 `undefined`，之后每次调用都报「no model service」。
`llm` 写进 `inject`，且**每个请求内部重新 `ctx.get('llm')`**。

**5. 设置不能用一个扁平键存。**
一个浏览器通常开着多个工作区。0.3.1 把 `{mode, workspaceDocs}` 直接写进一个
localStorage 键，结果 B 项目静默继承了 A 项目的模式——用户以为"设置丢了"，
其实是被另一个项目覆盖。现在按 `cwd` 分桶（`{ "<cwd>": {...} }`），旧扁平值
只迁移进 `""` 桶，不再污染真实工作区。

**6. 副作用不能写在 `setState` 的 updater 里。**
`setSettings(current => { ...fetch...; return next; })` 看着很顺手，但 React
可能重放 updater（StrictMode、并发渲染），同一个 `settings-set` 会发两次。
副作用要在 updater **外面**，用当前 state 算出 `next` 再写。

**7. ⚠️ 「改 `client.js` 必须整进程重启」是错的（本项目 2026-10-21 21:57 实测更正）。**
我曾从「bundle `rev = hash(mtimeMs,ctimeMs,size)`，刷新只重取同一 rev」推出这条结论，
还写进了交接单和长期记忆。**实测推翻了它**：客户端 bundle 是**请求时从源目录读**的。
证据：`client.js` 的 mtime 21:52 **晚于**宿主进程启动时间 20:51（20 分钟），
而线上 bundle 里已经带上了 21:52 的新代码（`sanitizeSettings` 命中 5 次、
`MODE_IDS = ['polish','acceptance']`）。
正确口径：
- 改 **`client.js`** → 刷新页面即可，**不用重启**；
- 改 **`index.js`**（Host 半）→ 进程内模块不热替换，**必须整进程重启**（重启后端口会变）。

**8. 验「线上跑的是不是我改的那份」，直接抓产物，别推时间戳。**
正确姿势：从页面 `performance.getEntriesByType('resource')` 拿**真实 bundle URL**
→ 带 cookie curl 下来 → 搜特征标记。
我曾用「进程启动时间 vs 文件 mtime」当判据，那是**错判据**——它会因为时间顺序偶然成立而
给出「看起来在、其实不在」的错误结论。

**9. bundle URL 的真实形状是合并形式。**
`/plugins/??<包1>/client.js,<包2>/client.js,...&rev=<hash>`。
裸 `/plugins/<pkg>/client.js` **恒 404**——那是 URL 形状问题，**不是「bundle 没挂上」的信号**，
别拿它当「插件没生效」的证据。
另外 `/plugins/events` 是长连接（SSE），`reader.read()` 无数据时永久阻塞，**不能当探活接口**。

**10. 从 localStorage / 文件读入并回传给 Host 的字段，读入时必须按白名单校验。**
脏值（如把 `acceptance` 误写成 `accept`）会一路流到 Host：UI 两个模式按钮都不亮（用户看不出原因），
点改写直接 400 `mode not available`——**整条功能静默报废**。
现在 `client.js` 用 `sanitizeSettings()` 统一清洗所有读路径（初始 state / 工作区分桶 / 工作区文件）
和写路径，非法值回落默认 `polish`；合法 id 只从 `MODE_IDS` 一处取，**白名单与 UI 不会漂移**。

## 避雷清单（九条，逐条落实）

来自 `KICKOFF.md` 第六节，来源是 polish / improve / model-radar / winditer 的真实踩坑记录。**每条都写了本项目怎么落实、以及在哪能验证**——照抄清单不算过关，能指出证据才算。

| # | 雷 | 本项目落实方式 | 证据在哪 |
|---|---|---|---|
| 1 | apply 时缓存 `ctx.get('llm')` → 恒报「无模型服务」 | `llm` 写进 `inject`，**每个请求内部重新取**，绝不把实例存进模块变量 | `index.js` 的 `rewrite` 处理器开头；`verify-host.mjs` 用「首轮 undefined、次轮可用」的桩验证不缓存 |
| 2 | 裸包名 import（schemastery / cordis） | Host 半只 import `node:` 内置模块，不 import 任何第三方裸包；Client 半只 `require('react')`（宿主注入） | `index.js` 顶部只有 `node:fs` / `node:path`；`package.json` 无 `dependencies` |
| 3 | client.js 的 CSS 模板字符串内出现反引号 → factory 加载期炸 | CSS 注释里**禁用反引号**；`verify-client.mjs` **真执行 factory** 而不是只做语法检查 | `node verify-client.mjs` 会跑 `factory()`；`node --check` 查不出这类错误，所以不靠它 |
| 4 | 弹层子项无 `min-height:0` → `max-height` 失效、滚不动 | 预览面板的滚动区显式 `min-height:0` + `overflow:auto`；尺寸用 `offsetWidth/Height` 量 | `client.js` 预览面板样式；真机 GUI 长草稿滚动实测 |
| 5 | bundle id ≠ 包名 → `arrive()` 抛错 | patch 里 **`name` 字段必须等于包名**（`dsh-prompt-forge`）；`id` 只是实例标识，可自由取短名（本项目 `id: prompt-forge`），与 model-radar 同构 | `cordis.patch.yml`；插件能正常挂载本身就是证据（`name` 与包名不符会直接抛错） |
| 6 | 用 `session.create/fork` 做生成 → 永远转圈 | Host 半直接 `llm.stream`，**不经过会话**，不创建、不 fork 任何 session | `index.js` 的 `rewrite` 只调 `llm.stream`；`verify-host.mjs` 断言全程无 session 创建 |
| 7 | `connection.rpc.call` 桌面版第二次调用挂起 | Host 通道走 **HTTP 路由** `POST /prompt-forge/api`（`webServer`），完全不碰 rpc | 客户端 `fetch('/prompt-forge/api')`；真机连续多次改写不挂 |
| 8 | ~~桌面 packaged 版无 HMR：改 `client.js` 刷新页面无效~~ | **实测结论已更正（2026-10-21 21:57）**：改 `client.js` **刷新页面即可生效**，无需重启；只有改 `index.js`（Host 半）才需整进程重启 | 见下面「坑 7」 |
| 9 | 新发布 npm 撞 `minimumReleaseAge` | **未发布**，见下节；若发 npm 需预期 profile 预检可能拦 <24h 的新版本 | 见「发布」一节的决策记录 |
| 10 | 无障碍降级把**唯一的状态信号**一起关掉 | `@media (prefers-reduced-motion:reduce)` 里对旋转**只放慢、不删除**：`.pf-btn[data-busy="true"] .pf-glyph-busy .ico{animation-duration:4s}`。转圈是触发按钮上唯一的「正在改写」反馈，设成 `animation:none` 后，任何开启「减少动效」的机器在整个请求期间看起来完全空闲。**注意区分**：交叉淡化是装饰性动效，降级时**整个删掉**（`transition:none`）——删掉它只少一层功夫，删掉旋转等于把状态信号删了 | `client.js` 的 reduced-motion 块；`verify-client.mjs` 的「放慢而非移除 + keyframe 存在」与「降级时整段删掉淡化」两组合计 5 条断言会红 |
| 11 | 用三元切换图标 → 按钮闪一下，环每次从 0° 起转 | 空闲与忙碌**两个图案常驻**、叠在同一格里，只靠 `opacity` 做 120ms 交叉淡化：真值在 `data-busy` 上（CSS 选择器读它），不在渲染函数里。DOM 在两种状态间不变，环也就一直在转，只是「现身」时已经转到了某个角度 | `client.js` 的 `.pf-glyph` 三条规则 + 触发按钮渲染；`verify-client.mjs` 四条断言（两个图案同时挂载、忙碌态里 idle 仍在树中、淡化 120ms 且挂在承载 opacity 的元素上、降级整段删掉）会红 |

## 发布

**当前状态：不发布。`private: true` 保持，本地 Junction 安装，当前版本 `0.5.0`。**

> 决策记录（2026-10-21）：用户选定「暂不发」。理由——P0–P2 刚闭环，接口还没有被外部用户验证过，此时对外承诺 API 稳定的收益远小于维护成本；等出现真实的外部使用需求再发，避免过早背兼容包袱。决策时版本为 `0.3.1`，诚实反映它经历过的三期迭代。
>
> 0.3.2（同日）：P3 之后的一次缺陷修复批次（设置按工作区隔离、config 旋钮真正接线、单次点击只发一次写入、删除一次性脚本）。发布决策不变——仍不发布。
>
> 0.4.0：新增改写判定（评估侧）。这是小版本而不是补丁，因为响应体多了一个 `judge` 字段、`config` 多了一个 `capability.judge`，对外契约变了。发布决策不变——仍不发布。
>
> 0.5.0：新增费用计量。同样是**小版本而不是补丁**：响应体多了 `usageTotal` 与 `cost`，`config` 多了 `pricing`。发布决策不变——仍不发布。

三种选择与真实代价（留档，将来要发时直接看这张表）：

| 方式 | 怎么做 | 代价 / 风险 |
|---|---|---|
| **暂不发**（当前） | 保持 `private: true`，本地 Junction 装 | 零风险、零维护；别人用不了，只能自己用 |
| **npm** | 去掉 `private`，补 `license` / `repository` / `keywords`，`npm publish` | 撞 `minimumReleaseAge`（避雷 #9）：新版本 24h 内可能被 profile 预检拦下，需要 `minimumReleaseAgeExclude` 或等 24h。另外要定 scope（是否 `@<scope>/dsh-prompt-forge`） |
| **GitHub 源** | 推仓库，装包走 `plugin_manager install_bundle <git-url>` | 无 npm 的 24h 限制；但装包锁定 commit，升级要重新装 |

**将来真要发时，必须做的最小改动**：

1. `package.json`：删 `"private": true`
2. 补 `"license"`（未定，建议 `MIT`）、`"repository"`、`"keywords"`
3. 确认 `files` 白名单不含 `KICKOFF.md`、`.prompt-forge/`、临时验证脚本产物
4. 发布前跑一次三套验证：`verify-host` + `verify-client` + `verify-live`

## 与市场同名包的命名空间冲突（别点那条升级）

插件市场（dshm_list / dshm_search）会把本插件标成 outdated：本地 `0.4.0` / `0.5.0`，`latestVersion` 指向 `1.2.2`。**那条升级不能点。**

`dsh-prompt-forge` 这个名字在 npm 上属于别人的包（维护者 `aliboder`，仓库 `github.com/Aliboder/dsh-prompt-forge`，MIT，2026-10-17 建），与本插件**同名异物**。判据是特征字符串而非版本号：本地 `index.js` 命中 `NO_VERIFIABLE_ACCEPTANCE` / `maxWorkspaceDocs` / `/prompt-forge/api` / `settings-set` / `acceptance` / `diagnose` 六项，上游 `main` 与最早 tag `v1.0.0` 这六项**全不命中**；上游从 `v1.0.0` 就是 `lib/` + `test/` 多文件结构且带 CHANGELOG，本地是单文件 `index.js` 加 `host-authority.mjs` 与三个 `verify-*.mjs`。另外 npm 上根本没有 `0.4.0` 这个版本（只有 `0.0.0-stage` / `1.1.0` / `1.2.0` / `1.2.1` / `1.2.2`），版本号序列本身就不连续。

在本机点那条升级的真实后果：profile 里的 `link:` 软链会被换成那个 npm 包，本地这套代码**当场脱钩**——保真闸、验收补全、工作区文档、费用计量全部消失，而这些恰恰是上游没有的东西。

三种处置：

1. **什么都不做**（当前选择）——市场角标一直红着，是已知噪音，不影响运行。
2. **改名解耦**——把包名改成 `dsh-prompt-forge-local` 之类，需同步改 `cordis.patch.yml` 里的 `name` 与 profile 里的 `link:` 路径，改完重启宿主。代价是一次性改动风险，收益是市场不再误判。
3. 只在此处留档，不动代码。

## 验证登录态接口

`/prompt-forge/api` 和 `/plugins/events` 都要过宿主的 connection fence，
裸 `curl` 必然 403/401——这是设计如此，不是插件 bug。
要在命令行验证，从已登录浏览器的 devtools 里复制 Cookie 再用 `curl -b`。
