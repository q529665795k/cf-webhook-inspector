# Webhook Inspector

轻量临时 Webhook 调试面板，基于 Cloudflare Worker + Durable Object。

## 在线体验

**👉 https://hook.808.qzz.io**

打开自动生成一个监听地址，复制就能用，不用部署。

## 这是什么？

一句话：**给你一个临时的接收地址，用来抓别人系统自动推过来的数据，调试用。**

有时候你对接 API、机器人、支付回调，不知道对方到底发没发、发的内容对不对。把这个工具生成的地址填到对方的回调配置里，对方一发，你手机上立刻就能看到完整的请求内容。

## 功能

- ✅ 一键生成临时监听地址
- ✅ WebSocket 实时推送，不用刷新页面
- ✅ 完整展示：方法、Headers、Body、来源IP、时间
- ✅ JSON 自动格式化高亮
- ✅ 一键复制 cURL 命令重放请求
- ✅ 一键清空记录
- ✅ 24 小时自动过期销毁
- ✅ 内置敏感关键词黑名单，自动丢弃恶意请求
- ✅ 手机端完美适配

## 技术栈

- Cloudflare Workers
- Durable Objects（每个监听地址一个独立实例）
- WebSocket 实时推送
- 纯前端单页应用，无框架

## 快速部署

```bash
# 安装 wrangler
npm install -g wrangler

# 登录
wrangler login

# 部署
wrangler deploy
```

部署完成后访问你的 Worker 域名，自动生成一个监听地址。

## 使用方法

1. 打开 **https://hook.808.qzz.io**，自动跳转到一个监听页面，得到地址 `https://hook.808.qzz.io/abc123xyz`
2. 把这个地址填到你要调试的 webhook 配置里
3. 触发对方发请求，页面上实时显示请求内容
4. 调试完直接关掉页面，24 小时后数据自动销毁

## 示例测试

```bash
# 先发个请求到你的监听地址（替换成你自己的UUID）
curl -X POST https://hook.808.qzz.io/你的UUID \
  -H "Content-Type: application/json" \
  -d '{"event":"test","data":"hello world"}'
```

## 免责声明

本项目仅用于合法的开发调试用途。

使用者不得利用本服务从事任何违法违规活动，包括但不限于：
- 接收、转发非法获取的数据
- 用于未授权的网络探测、扫描
- 用于诈骗、钓鱼等违法活动
- 其他违反法律法规的行为

本服务对发送的内容不做人工审核，但内置关键词过滤机制。因使用者不当使用造成的一切后果，由使用者自行承担，本项目作者不承担任何责任。

使用本服务即表示你已阅读并同意上述条款。

## License

MIT License

Copyright (c) 2026 摸鱼基地出品

任何人可自由使用、修改、分发、商用本项目，唯一要求：保留本版权署名，不得冒充原创。
