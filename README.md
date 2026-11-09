# Webhook Inspector

**一个“看完就烧”的 Webhook 调试面板：给你临时地址抓回调数据，2 小时自动销毁；管理员面板只输出计数，不包含请求内容。**

![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)
![Durable Objects](https://img.shields.io/badge/Durable%20Objects-isolated%20instance-F38020)
![Zero Build](https://img.shields.io/badge/zero%20dependency-no%20build-yellow)
![License](https://img.shields.io/badge/License-MIT-green)

**在线直接用** → https://hook.808.qzz.io

---

## 为什么做这个

对接支付回调、机器人、第三方 API 的时候，最烦的就是一句话：

> “我们这边已经发出去了。”

到底发没发？发的是什么？Headers 对不对？Body 是不是少字段？

把本工具生成的临时地址填进对方的回调配置，对方一发，你屏幕上立刻显示完整请求。调试完关掉页面，数据到点自己消失。

**核心不只是“能抓包”，还有“抓完不留副本”。** 不少 webhook 调试工具会把请求存下来、记日志、给运营看；这个的设计是请求体只留在内存里，到点随实例一起清除。

---

## 隐私设计：内容不落盘，管理员面板只看计数

| 设计 | 怎么做的 | 效果 |
|---|---|---|
| **内容不落盘** | 请求体只存在 Durable Object 的内存数组里（上限 100 条，超出淘汰最旧），**不写入持久存储** | 持久层里没有请求内容 |
| **2 小时自毁** | 每个监听地址创建时注册 `setAlarm(Date.now() + 2h)`，到点执行 `storage.deleteAll()` | 到期连状态一起清空，记录不再保留 |
| **实例级隔离** | 每个监听地址是一个独立 UUID + 独立 DO 实例 | 每个地址的数据各自独立 |
| **管理员面板不含内容** | `/admin` 只输出 4 个数字：总监听数、总请求数、今日新建、今日收到 | 站点主人看到的是计数，不含请求体 |
| **无内容日志** | 不写 console.log、不打请求体、不做审计留档 | 日志里也翻不到请求内容 |
| **黑名单静默丢弃** | 命中敏感关键词的请求直接 `return 200 OK`，不入库、不展示、不报错 | 拦截不会给请求方额外反馈 |

再直白一点：请求内容从接收那一刻起只在 DO 内存里停留，不落持久存储，管理员面板也不读取它。所以部署者手上没有可翻阅的副本，能看到的只有当时开着那个监听页面的你。

> 以上是本项目的实现思路，不是唯一做法。密钥/数据保管、访问审计这些环节还有不少可以做得更细的地方，欢迎提 issue 一起聊。

---

## 功能

- 一键生成临时监听地址（UUID），复制即用，无需部署
- WebSocket 实时推送，不用刷新页面
- 完整展示：方法、路径（含 query）、Headers、Body、来源 IP、时间
- JSON 自动格式化 + 语法高亮
- 一键复制成 cURL 命令，原地重放
- 一键清空当前记录
- 2 小时倒计时自动过期销毁
- 内置敏感词黑名单，自动拦截
- 手机端适配

## 技术实现

```
Workers（入口路由）
  ├─ /            → 生成 UUID，跳转到监听页
  ├─ /<uuid>      → 转发到该 UUID 的 Durable Object 接收请求
  └─ /admin       → 密码保护，读 STATS 实例的四个计数器
Durable Object（每监听地址一个）
  ├─ requests[]   → 内存数组，最多 100 条，不落盘
  ├─ WebSocket    → 实时广播给页面
  └─ setAlarm     → 2h 后 storage.deleteAll()
Durable Object（STATS，单例）
  └─ 只累加计数：总数 / 今日数，按天切换
```

**单文件 14KB，零依赖零构建**，`wrangler deploy` 一步上线。没有 npm 依赖树，没有框架。

## 部署

```bash
npm i -g wrangler
wrangler login
wrangler deploy
```

需要两个 Durable Object 绑定（监听实例 + 统计实例），`wrangler.toml` 已带好配置结构，换成你自己的 `id_from_name` 即可。

## 用法

1. 打开 https://hook.808.qzz.io ，自动生成一个监听地址
2. 把这个地址填进对方系统的回调配置
3. 触发回调，页面实时显示完整请求
4. 调试完关掉页面，2 小时后自动销毁

```bash
curl -X POST https://hook.808.qzz.io/<你的UUID> \
  -H "Content-Type: application/json" \
  -d '{"event":"test","data":"hello"}'
```

## 免责声明

本项目仅用于合法的开发调试用途。不得用于接收非法获取的数据、未授权网络探测、诈骗钓鱼等违法违规活动。因使用不当造成的一切后果由使用者自行承担，作者不承担责任。

## License

MIT · Copyright (c) 2026 摸鱼基地出品（匿名爱好者）

可自由使用、修改、分发、商用，保留署名即可。
