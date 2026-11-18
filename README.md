# token-speed

Claude Code 的 mod（函数钩子插件），在输入框下方的状态栏里显示模型的输出速度，Claude 桌面应用的 Code 标签页和终端里都能用。

## 安装

在终端的 Claude Code 会话里输入：

```
/plugin install token-speed --marketplace AdamDashen666/claude-token-speed
```

问 `Add marketplace?` 时回答 `y`，范围选用户级（user，排在第一个，直接回车）。装好后当前会话立刻生效，之后每个新会话也会自动加载。

也可以在系统命令行里装：

```
claude plugin install token-speed --marketplace AdamDashen666/claude-token-speed
```

Claude 桌面应用里不能用 `/plugin`：点输入框旁边的 +，选 Plugins，用 Add marketplace 添加 `AdamDashen666/claude-token-speed`，再点 Add plugin。在终端里按用户级装好的插件，桌面应用的 Code 标签页也会加载。

## 显示什么

- 生成中：`⚡ 生成中 ≈58 tok/s · 首字 1.4s`，按字数粗估，再按本会话前几次请求的实际比例校准，每 0.3 秒刷新一次
- 每次请求结束：`⚡ 62.3 tok/s · 首字 1.4s · 输出 812 · 缓存 97%`，用 API 返回的准确 `output_tokens`
- 一轮对话结束：`⚡ 本轮 60.1 tok/s · 5 次请求 · 输出 3.2k · 缓存 97% · 会话均速 58.1`

`/token-speed` 输出本会话的统计：按模型的平均速度、首字延迟中位数、输入/输出/缓存合计、最近 10 次速度。`/token-speed reset` 清零。

## 怎么算

- 速度 = 输出 token ÷（从第一个流式片段到结束的时间），服务端工具（如 advisor）运行的时间会扣掉
- 首字 = 发出请求到收到第一个流式片段
- 缓存 = 读缓存的输入 token ÷ 全部输入 token
- 生成不到 0.3 秒或少于 16 个 token 的请求不计速度，只计用量
- 子代理的请求计入 `/token-speed` 统计，但不刷新状态栏
- 在客户端测量，含网络抖动；统计只保存在当前会话里

## 限制

只对 Claude Code 会话有效，Claude 桌面应用的普通 Chat 页用不了。
