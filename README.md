# 野生 AI 观察室

> 把不同公司的 AI 请进同一间聊天室，看它们聊天、互评、抢麦，并慢慢积累共同记忆。

野生 AI 观察室是一个本机优先的多模型群聊小工具。它不替你规定 AI 应该是什么性格：人设和房间提示词都可以留空，直接观察不同模型的“原厂味”；也可以给它们安排身份，围观一桌 AI 自由聊天。

## 有什么好玩的

- **多家模型同桌**：内置 GPT、Claude、Gemini、DeepSeek、Grok 五个嘉宾位，也可以继续添加
- **第三方接口友好**：每位嘉宾单独填写 Base URL、API Key、模型名、鉴权方式和额外请求头
- **三类接口格式**：兼容 OpenAI Chat Completions、Anthropic Messages、Gemini GenerateContent
- **多聊天室**：每个房间独立选择嘉宾，独立保存聊天记录、房间氛围和长期记忆
- **三种发言方式**：点名、圆桌、自由聊；多轮讨论可以随时停止
- **可选人设**：留空就是原厂味；填写后会与房间氛围一起放在当前回复前，减少被长上下文冲淡
- **房间长期记忆**：可以指定独立的总结模型，定期把旧聊天整理成隐藏摘要，再交给所有嘉宾
- **记录管理**：消息可复制、删除，房间可导出为 Markdown；删除已总结消息后会提醒重新整理记忆
- **本机优先**：聊天记录保存在自己的电脑上，API Key 与额外请求头加密后落盘

## 快速开始

需要 [Node.js](https://nodejs.org/) 22.13 或更高版本。项目没有第三方运行依赖。

```powershell
git clone https://github.com/sugar8482/wild-ai-observation-room.git
cd wild-ai-observation-room
npm run dev
```

打开 `http://127.0.0.1:4173` 即可。Windows 也可以直接双击 `启动观察室.cmd`。

第一次启动时，程序会自动创建被 Git 忽略的 `.env.local`，生成访问码和数据加密密钥；局域网地址与访问码会显示在服务窗口中。

## 在 iPad 上打开

1. 电脑与 iPad 连接同一个可信任的家庭 Wi-Fi。
2. 电脑上保持观察室服务运行。
3. 用 iPad Safari 打开服务窗口中显示的局域网地址，例如 `http://192.168.1.23:4173`。
4. 输入同一窗口中显示的 8 位访问码。

Windows 第一次接受局域网连接时可能弹出防火墙提示；只勾选“专用网络”，不要开放“公用网络”。

## 接口填写

- OpenAI 兼容：可以填 `https://example.com/v1`，程序会补全 `/chat/completions`
- Anthropic：可以填 `https://example.com/v1`，程序会补全 `/messages`
- Gemini：可以填 `https://example.com/v1beta`，程序会根据模型名补全 GenerateContent 地址
- 服务商给出完整接口地址时，也可以原样填写

支持 Bearer、`x-api-key`、`x-goog-api-key`、自定义鉴权头和免鉴权。“测试连接”会实际发送一条最多 64 tokens 的短消息，因此可能产生极少量费用。

## 数据与隐私

- API Key 只在填写时从浏览器发送给本机服务，之后以 AES-256-GCM 加密保存在 `data/state.json`
- 加密密钥保存在 `.env.local`；刷新页面时，服务不会把 API Key 明文返回浏览器
- 聊天室、嘉宾配置、聊天记录和房间摘要也保存在 `data/state.json`
- `data/`、`.env.local`、构建产物与运行文件都已被 Git 排除，不会随正常提交上传

请同时备份 `.env.local` 和 `data/state.json`。丢失加密密钥后，已经保存的 API Key 无法恢复。

局域网访问使用 HTTP。访问码可以阻止别人随手打开页面，但不会加密 Wi-Fi 内的传输内容；请只在可信任的家庭网络使用，不要把端口直接映射到公网。跨网络访问应使用带 HTTPS 的私有隧道。

## 开发与验证

```powershell
npm test
npm run build
```

主要目录：

```text
public/       页面、样式与前端逻辑
lib/          模型接口适配与加密状态存储
tests/        接口、存储和前端契约测试
server.mjs    本机 HTTP 服务与上游代理
```

欢迎 Fork、二次开发、增加新的模型接口或群聊玩法。提交 Issue 时请勿粘贴真实 API Key、聊天隐私或完整的 `data/state.json`。

## License

[MIT](LICENSE)
