# Habblaud Telegram Mini App

## 本机预览

Node 22.12+。在本仓库执行 `npm run miniapp:preview`，浏览器打开
[`http://127.0.0.1:4849`](http://127.0.0.1:4849)。预览只监听回环地址，用模拟会话演示工作台、项目、动态、办公室、对话和投递状态。运行
`npm run miniapp:test` 验证接口。

## Telegram 真机部署

### Render 免费版

1. 把 `feat/telegram-miniapp` 分支推送到 fork 后，在 Render 控制台新建 Blueprint，选择该仓库和分支。
   根目录的 `render.yaml` 配置免费 Web Service、网关专用 Dockerfile 和 `/healthz` 检查。
2. 在 Render 表单里从本机 `env.local` 填入 `TG_BOT_API_TOKEN` 和 `TG_USER_ID`。
   Render 会生成 `MINIAPP_BRIDGE_SECRET`，在服务的 Environment 页面查看。
3. 部署成功后，把服务页面的 HTTPS 根地址填到 BotFather 的 Main Mini App，把同一个地址作为
   `MINIAPP_GATEWAY_URL`、把生成的密钥作为 `MINIAPP_BRIDGE_SECRET` 加到 Mac 的 `env.local`。
   从仓库根目录用 Node 22.12+ 启动桥接。

   ```sh
   node --env-file="/path/to/env.local" miniapp/mac-bridge.mjs
   ```

4. 在 Telegram 打开 Mini App，验证登录、列表、最近回复和两种 Agent 的投递。Render 免费服务无入站流量
   15 分钟会休眠，重新启动期间网关的内存队列与登录状态会重置。

### 通用部署

1. 在 BotFather 创建 Bot。将下面的网关放在可通过 HTTPS 访问的位置，再把 HTTPS 根地址填写为 Bot 的 Main Mini App。
2. 网关执行 `npm run miniapp:gateway`。环境变量 `MINIAPP_BOT_TOKEN` 或 `TG_BOT_API_TOKEN` 为 Bot token，`MINIAPP_USERS`
   为允许访问的 Telegram 数字用户 ID（逗号分隔）。若配置了 `TG_USER_ID`，可省略 `MINIAPP_USERS`。
   `MINIAPP_BRIDGE_SECRET` 为 32 字符以上的随机密钥。
   `HOST` 默认是 `127.0.0.1`，`PORT` 默认是 `4849`。按托管平台部署模型配置监听和 HTTPS 反向代理。
   把 Bot token 和桥接密钥放在服务端的密钥配置中。本机调试可用 `MINIAPP_ENV_FILE=/path/to/env.local npm run miniapp:gateway`
   读取仓库之外的配置文件。
   如果托管平台用 Docker 部署，从仓库根目录构建 `docker build -f miniapp/Dockerfile -t habblaud-miniapp:local .`，
   然后在平台侧注入同样的环境变量并配置 HTTPS。
3. Mac 上运行 `npm run miniapp:bridge`。环境变量 `MINIAPP_GATEWAY_URL` 为网关 HTTPS 根地址，
   `MINIAPP_BRIDGE_SECRET` 与网关一致，`HABBLAUD_LOCAL_URL` 默认是 `http://127.0.0.1:4747`。
   将 Mac 的 Habblaud 端口绑定在本机回环地址，确保终端和消息功能已开启。
4. Docker 模式通过原项目的 `npm run codex:bridge` 将消息交给 Codex。Claude Code 主会话需启用
   `habblaud-mensagens` 插件。Mini App 根据每个会话的消息能力启用输入框。

网关校验 Telegram 启动数据并签发短期访问凭据。Mac 主动向网关拉取请求，只执行会话与工作台数据查询、最近对话、发送用户消息和
读取投递状态四种操作。工作台包含会话状态、Agent 显示名、子 Agent 数量、账号用量，以及最近 24 条动态的类型和时间。
房间采用桌面版的像素布局和角色画法，可按项目切换并点开成员。角色按会话状态摆放，子 Agent 在所属主会话下展开。
工作台数据带上房间和角色的绘制参数、账号短标和任务标题。读取、编辑和写入活动可以显示文件名，省略完整路径、账号邮箱和命令内容。
旧版 Mac 桥接仍可提供基本会话数据，更新桥接后会显示完整工作台。
最近对话只保留用户和 Agent 正文，每次最多 12 条，内容会经网关转发给已授权的 Mini App 用户。
网关和桥接使用内存传递请求和结果。需要信任部署网关，并限制代理、托管平台和应用的日志内容。

「已送达会话」表示指令进入会话或它的队列。网络断开造成的投递结果不明会单独显示，应用不会自动重发。
Bot 通知、手机审批和启动新会话待后续实现。
