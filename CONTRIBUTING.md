# 参与改进

这是个人自用项目（见 README 顶部说明），不是有支持义务的产品。改代码、提 Issue、发 Pull Request 都欢迎，但我**不承诺响应时间**，也不承诺接受改动——合并与否取决于它对我自己有没有用。真要改，Fork 走比 PR 更省事。

## 环境

- Node.js >= 20
- DeepSeek Harness（`engines.dsh` 声明了兼容区间，宿主会据此拦截不兼容的安装，不会静默失败）

## 改完怎么验

```bash
node verify-host.mjs && node verify-client.mjs
```

真机校验（需要已安装并在运行的本插件）：

```bash
node verify-live.mjs [authority] [sessionId]
```

两个 stub 脚本不需要登录态，也不碰真实 profile。`verify-client.mjs` 会真正执行 client 的 factory，能抓到 `node --check` 看不出来的加载期错误。

`verify-live.mjs` 有一条断言专门检查 `config` 里只有当前源码才会输出的字段，用来区分「新代码」和「改完之后没重启的旧进程」——否则整套断言对旧构建也照样全绿。

## 提交约定

- 一个改动一个 commit，提交信息说清**为什么改**，不只是改了什么
- 不提交 `.bak-*` 备份文件（`.gitignore` 已排除）；改之前的样子 `git diff` 就能看，不需要手工备份
- `cordis.patch.yml` 和 profile 里的安装状态不建议手改，走 `plugin_manager` 的 install/remove 动作

## 报问题

在 Issues 里写清楚：DSH 版本、复现步骤、期望与实际。有宿主日志更好。
