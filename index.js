/**
 * Webhook Inspector - 轻量临时Webhook调试面板
 * 基于 Cloudflare Worker + Durable Object
 */

// ========== 黑名单配置（硬编码，不常改） ==========
const BLOCKED_KEYWORDS = [
  'password', 'passwd', 'pwd', 'secret', 'api_key', 'apikey', 'api-key',
  'credit_card', 'creditcard', 'cvv', 'ssn', 'id_card', '身份证',
  '银行卡', '密码', 'token=', 'bearer '
];

// 内网IP段检测
const INTERNAL_IPS = [
  /^10\./, /^192\.168\./, /^172\.(1[6-9]|2[0-9]|3[01])\./,
  /^127\./, /^169\.254\./, /^::1$/, /^fc/: /^fd/
];

// 过期时间：24小时
const EXPIRE_MS = 24 * 60 * 60 * 1000;

// ========== Durable Object ==========
export class WebhookInspectorDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map(); // ws -> name
    this.requests = []; // 内存缓存最近的请求
    this.MAX_REQUESTS = 100; // 最多存100条

    // 启动时设置过期闹钟
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get('createdAt');
      if (!stored) {
        await this.state.storage.put('createdAt', Date.now());
      }
      // 设置闹钟，到期自动销毁
      await this.state.storage.setAlarm(Date.now() + EXPIRE_MS);
    });
  }

  // 闹钟触发：销毁自己
  async alarm() {
    await this.state.storage.deleteAll();
  }

  // 检查请求是否包含黑名单关键词
  isBlocked(bodyText, headers) {
    const lowerBody = bodyText.toLowerCase();
    for (const kw of BLOCKED_KEYWORDS) {
      if (lowerBody.includes(kw.toLowerCase())) return true;
    }
    return false;
  }

  // 接收第三方发来的webhook请求
  async receiveRequest(request) {
    const url = new URL(request.url);
    const bodyText = await request.text();

    // 黑名单检测
    if (this.isBlocked(bodyText, request.headers)) {
      return new Response('OK', { status: 200 }); // 假装成功，静默丢弃
    }

    const req = {
      id: Date.now() + Math.random(),
      method: request.method,
      path: url.pathname + url.search,
      headers: Object.fromEntries(request.headers),
      body: bodyText,
      ip: request.headers.get('cf-connecting-ip') || 'unknown',
      time: new Date().toISOString()
    };

    // 存到内存
    this.requests.unshift(req);
    if (this.requests.length > this.MAX_REQUESTS) {
      this.requests.pop();
    }

    // 推送给所有连接的前端
    this.broadcast({ type: 'new_request', data: req });

    return new Response(JSON.stringify({ received: true }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // 广播消息给所有前端连接
  broadcast(msg) {
    const text = JSON.stringify(msg);
    for (const ws of this.sessions.keys()) {
      try { ws.send(text); } catch (e) {}
    }
  }

  // 处理前端WebSocket连接
  async handleWebSocket(ws) {
    // 发送历史请求
    ws.send(JSON.stringify({
      type: 'init',
      data: { requests: this.requests }
    }));

    // 监听消息
    ws.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'clear') {
          this.requests = [];
          this.broadcast({ type: 'cleared' });
        }
      } catch (e) {}
    });

    ws.addEventListener('close', () => {
      this.sessions.delete(ws);
    });

    this.sessions.set(ws, Date.now());
  }

  // 处理前端HTTP请求（页面、初始数据）
  async fetch(request) {
    const url = new URL(request.url);

    // WebSocket 升级
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader === 'websocket') {
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      server.accept();
      await this.handleWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    // API: 获取请求列表
    if (url.pathname === '/api/requests') {
      return new Response(JSON.stringify({ requests: this.requests }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response('Not Found', { status: 404 });
  }
}

// ========== 前端页面 HTML ==========
const FRONTEND_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Webhook Inspector</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f0f0f; color: #eee; padding: 12px; }
.header { margin-bottom: 16px; }
.header h1 { font-size: 18px; margin-bottom: 8px; }
.url-box { background: #1a1a1a; border-radius: 8px; padding: 10px; margin-bottom: 8px; word-break: break-all; font-size: 13px; color: #4ade80; }
.btn-row { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 16px; }
.btn { padding: 8px 14px; border: none; border-radius: 6px; cursor: pointer; font-size: 13px; }
.btn-primary { background: #3b82f6; color: white; }
.btn-secondary { background: #333; color: #eee; }
.btn-danger { background: #dc2626; color: white; }
.stats { font-size: 12px; color: #888; margin-bottom: 12px; }
.request-item { background: #1a1a1a; border-radius: 8px; padding: 12px; margin-bottom: 10px; }
.req-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.method { font-weight: bold; font-size: 13px; }
.method-post { color: #4ade80; }
.method-get { color: #60a5fa; }
.method-put { color: #fbbf24; }
.method-delete { color: #f87171; }
.time { font-size: 11px; color: #666; }
.req-body { background: #111; border-radius: 4px; padding: 8px; font-family: monospace; font-size: 12px; white-space: pre-wrap; word-break: break-all; max-height: 200px; overflow-y: auto; }
.req-headers { font-size: 11px; color: #888; margin-top: 6px; }
.empty { text-align: center; color: #555; padding: 40px 0; }
.copy-btn { font-size: 11px; padding: 3px 8px; background: #333; border: none; border-radius: 4px; color: #aaa; cursor: pointer; margin-top: 6px; }
</style>
</head>
<body>
<div class="header">
  <h1>🔍 Webhook Inspector</h1>
  <div class="url-box" id="hookUrl"></div>
  <div class="btn-row">
    <button class="btn btn-primary" onclick="copyUrl()">复制地址</button>
    <button class="btn btn-secondary" onclick="newHook()">新建监听</button>
    <button class="btn btn-danger" onclick="clearAll()">清空记录</button>
  </div>
  <div class="stats" id="stats"></div>
</div>
<div id="requestList">
  <div class="empty">等待请求...<br><small>把上面的地址填到你的webhook配置里</small></div>
</div>

<script>
const uuid = location.pathname.slice(1);
const hookUrl = location.origin + '/' + uuid;
document.getElementById('hookUrl').textContent = hookUrl;

let ws;
function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(proto + '//' + location.host + '/' + uuid + '/ws');
  
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'init') {
      renderRequests(msg.data.requests);
    } else if (msg.type === 'new_request') {
      prependRequest(msg.data);
    } else if (msg.type === 'cleared') {
      renderRequests([]);
    }
  };
  
  ws.onclose = () => setTimeout(connect, 2000);
}

function renderRequests(requests) {
  const list = document.getElementById('requestList');
  document.getElementById('stats').textContent = '共 ' + requests.length + ' 条请求';
  if (requests.length === 0) {
    list.innerHTML = '<div class="empty">等待请求...<br><small>把上面的地址填到你的webhook配置里</small></div>';
    return;
  }
  list.innerHTML = requests.map(r => renderItem(r)).join('');
}

function prependRequest(req) {
  const list = document.getElementById('requestList');
  if (list.querySelector('.empty')) list.innerHTML = '';
  list.insertAdjacentHTML('afterbegin', renderItem(req));
  const count = list.children.length;
  document.getElementById('stats').textContent = '共 ' + count + ' 条请求';
}

function renderItem(r) {
  const methodClass = 'method-' + r.method.toLowerCase();
  let body = r.body;
  try { body = JSON.stringify(JSON.parse(r.body), null, 2); } catch(e) {}
  return '<div class="request-item">' +
    '<div class="req-head">' +
      '<span class="method ' + methodClass + '">' + r.method + ' ' + r.path + '</span>' +
      '<span class="time">' + new Date(r.time).toLocaleTimeString() + '</span>' +
    '</div>' +
    '<div class="req-body">' + escapeHtml(body) + '</div>' +
    '<div class="req-headers">IP: ' + r.ip + '</div>' +
    '<button class="copy-btn" onclick="copyCurl(\\'' + r.id + '\\')">复制cURL</button>' +
  '</div>';
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function copyUrl() {
  navigator.clipboard.writeText(hookUrl);
  alert('已复制: ' + hookUrl);
}

function newHook() {
  location.href = '/new';
}

function clearAll() {
  ws.send(JSON.stringify({ type: 'clear' }));
}

connect();
</script>
</body>
</html>`;

// ========== Worker 主入口 ==========
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // 首页：生成新的UUID，跳转到监听页面
    if (path === '/' || path === '/new') {
      const uuid = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
      return Response.redirect(url.origin + '/' + uuid, 302);
    }

    // 监听页面
    const match = path.match(/^\/([a-zA-Z0-9]{8,32})$/);
    if (match && request.method === 'GET') {
      const id = match[1];
      const idObject = env.WEBHOOK_INSPECTOR.get(env.WEBHOOK_INSPECTOR.idFromName(id));
      // 先确认DO存在
      await idObject.fetch('http://internal/ping');
      return new Response(FRONTEND_HTML, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    // WebSocket 升级到 DO
    const wsMatch = path.match(/^\/([a-zA-Z0-9]{8,32})\/ws$/);
    if (wsMatch) {
      const id = wsMatch[1];
      const idObject = env.WEBHOOK_INSPECTOR.get(env.WEBHOOK_INSPECTOR.idFromName(id));
      return idObject.fetch(request);
    }

    // 接收第三方webhook请求
    const hookMatch = path.match(/^\/([a-zA-Z0-9]{8,32})/);
    if (hookMatch) {
      const id = hookMatch[1];
      const idObject = env.WEBHOOK_INSPECTOR.get(env.WEBHOOK_INSPECTOR.idFromName(id));
      return idObject.fetch(request);
    }

    return new Response('Not Found', { status: 404 });
  }
};
