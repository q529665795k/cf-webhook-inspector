/**
 * Webhook Inspector - 轻量临时Webhook调试面板
 * 基于 Cloudflare Worker + Durable Object
 */

// ========== 黑名单配置（命中即静默丢弃，返回200假装成功） ==========
const BLOCKED_KEYWORDS = [
  // ---- 密码 / 口令 ----
  'password', 'passwd', 'passphrase', 'pwd', '密码', '口令', '旧密码', '新密码',
  // ---- 令牌 / 凭据 ----
  'secret', 'api_key', 'apikey', 'api-key', 'x-api-key', 'access_key', 'accesskey',
  'access_token', 'accesstoken', 'refresh_token', 'refreshtoken', 'id_token',
  'client_secret', 'clientsecret', 'private_key', 'privatekey', 'privkey', 'master_key',
  'token=', 'bearer ', 'authorization', 'credential', 'credentials',
  'cookie', 'set-cookie', 'sessionid', 'jsessionid', 'phpsessid', 'csrf', 'xsrf',
  // ---- 密钥 / 凭据格式特征 ----
  '-----begin', 'begin rsa', 'begin openssh', 'begin private', 'ssh-rsa', 'ssh-ed25519',
  'ghp_', 'github_pat_', 'xoxb-', 'xoxp-', 'sk_live_', 'sk_test_', 'rk_live_',
  'akia', 'asia', 'aiza', 'cfk_', 'eyj',
  // ---- 金融 / 支付 ----
  'credit_card', 'creditcard', 'card_number', 'cardnumber', 'cvv', 'cvc', 'pan=',
  '银行卡', '信用卡', '卡号', 'iban', 'swift', 'paypal', '支付宝', '微信支付',
  // ---- 身份 / 隐私 ----
  'id_card', 'idcard', 'ssn', 'social_security', 'passport', 'date_of_birth',
  '身份证', '护照', '实名', '私钥', '密钥', '秘钥', '证件号'
];

// 内网IP段检测
const INTERNAL_IPS = [
  /^10\./, /^192\.168\./, /^172\.(1[6-9]|2[0-9]|3[01])\./,
  /^127\./, /^169\.254\./, /^::1$/, /^fc/, /^fd/
];

// 过期时间：1小时
const EXPIRE_MS = 60 * 60 * 1000;

// ========== 限流配置 ==========
const RL_HOOK_PER_SEC = 10;        // 单监听：每秒最多 10 次
const RL_HOOK_PER_MIN = 300;       // 单监听：每分钟最多 300 次
const RL_GLOBAL_PER_SEC = 60;      // 全服务：每秒最多 60 次
const RL_GLOBAL_PER_MIN = 3000;    // 全服务：每分钟最多 3000 次
const MAX_ACTIVE_HOOKS = 100;      // 同时活跃监听上限
const RL_HOOK_CREATE_PER_IP = 10;  // 单 IP 10 分钟内最多创建 10 个监听

// ========== Durable Object ==========
export class WebhookInspectorDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map(); // ws -> name
    this.requests = []; // 内存缓存最近的请求
    this.MAX_REQUESTS = 100; // 最多存100条

    // 单监听限流计数器（内存滑动窗口）
    this.rlSecStart = Date.now();
    this.rlSecCount = 0;
    this.rlMinStart = Date.now();
    this.rlMinCount = 0;
    this.expired = false;

    // 启动时设置过期闹钟（按创建时间算，不因访问续期）
    this.state.blockConcurrencyWhile(async () => {
      const expiredAt = await this.state.storage.get('expiredAt');
      if (expiredAt) {
        this.expired = true;
        this.requests = [];
        return;
      }
      const stored = await this.state.storage.get('createdAt');
      const createdAt = stored || Date.now();
      if (!stored) await this.state.storage.put('createdAt', createdAt);
      await this.state.storage.setAlarm(createdAt + EXPIRE_MS);
    });
  }

  // 闹钟触发：销毁自己，并留墓碑防止被访问复活
  async alarm() {
    await this.state.storage.deleteAll();
    await this.state.storage.put('expiredAt', Date.now());
    this.expired = true;
    this.requests = [];
  }

  // 单监听限流检查
  checkRateLimit() {
    const now = Date.now();
    if (now - this.rlSecStart >= 1000) { this.rlSecStart = now; this.rlSecCount = 0; }
    if (now - this.rlMinStart >= 60000) { this.rlMinStart = now; this.rlMinCount = 0; }
    this.rlSecCount++;
    this.rlMinCount++;
    if (this.rlSecCount > RL_HOOK_PER_SEC) return { ok: false, scope: 'hook_sec', retryAfter: 1 };
    if (this.rlMinCount > RL_HOOK_PER_MIN) return { ok: false, scope: 'hook_min', retryAfter: 60 };
    return { ok: true };
  }

  // 检查请求是否包含黑名单关键词（body + 请求头一起扫）
  isBlocked(bodyText, headers) {
    const parts = [String(bodyText || '')];
    try {
      for (const [k, v] of headers.entries()) {
        const key = k.toLowerCase();
        // 跳过无害的头，避免误判
        if (/^(cf-|host|content-length|content-type|user-agent|accept|accept-encoding|accept-language|connection|priority|cache-control|postman-token)$/.test(key)) continue;
        parts.push(key + ': ' + v);
      }
    } catch (e) {}
    const text = parts.join('\n').toLowerCase();
    for (const kw of BLOCKED_KEYWORDS) {
      if (text.includes(kw.toLowerCase())) return true;
    }
    return false;
  }

  // 黑名单命中计数（用于面板展示）
  bumpBlocked() {
    this.blockedCount = (this.blockedCount || 0) + 1;
  }

  // 接收第三方发来的webhook请求
  async receiveRequest(request) {
    const url = new URL(request.url);
    if (this.expired) {
      return new Response(JSON.stringify({ error: 'hook_expired', message: '监听已到期，请重新创建' }), {
        status: 410, headers: { 'Content-Type': 'application/json' }
      });
    }
    const rate = this.checkRateLimit();
    if (!rate.ok) {
      return new Response(JSON.stringify({ error: 'rate_limited', scope: rate.scope }), {
        status: 429,
        headers: { 'Content-Type': 'application/json', 'Retry-After': String(rate.retryAfter) }
      });
    }
    const bodyText = await request.text();

    // 黑名单检测
    if (this.isBlocked(bodyText, request.headers)) {
      this.bumpBlocked();
      return new Response(JSON.stringify({ received: true, blocked: true }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      }); // 假装成功，静默丢弃
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

    if (this.expired && !url.pathname.endsWith('/api/requests')) {
      if (request.headers.get('Upgrade') === 'websocket') {
        return new Response('hook expired', { status: 410 });
      }
      return new Response(JSON.stringify({ error: 'hook_expired' }), {
        status: 410, headers: { 'Content-Type': 'application/json' }
      });
    }

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
    if (url.pathname.endsWith('/api/requests')) {
      return new Response(JSON.stringify({ requests: this.requests }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 其他请求都当作 webhook 接收
    return this.receiveRequest(request);
  }
}

// ========== 统计 DO（只存数字，不存内容） ==========
export class StatsDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const today = new Date().toISOString().slice(0, 10);

    // 新建监听：活跃上限 + 单IP频率限制
    if (url.pathname === '/hook/new') {
      let ip = 'unknown';
      try { ip = (await request.json()).ip || 'unknown'; } catch (e) {}
      const now = Date.now();
      let active = await this.state.storage.get('active_hooks') || [];
      active = active.filter(ts => now - ts < EXPIRE_MS);
      let ipLog = await this.state.storage.get('ip_create_log') || {};
      const recent = (ipLog[ip] || []).filter(ts => now - ts < 10 * 60 * 1000);
      if (recent.length >= RL_HOOK_CREATE_PER_IP) {
        await this.state.storage.put('active_hooks', active);
        return new Response(JSON.stringify({ ok: false, reason: 'too_many_ip', active: active.length, max: MAX_ACTIVE_HOOKS }), { headers: { 'Content-Type': 'application/json' } });
      }
      if (active.length >= MAX_ACTIVE_HOOKS) {
        await this.state.storage.put('active_hooks', active);
        return new Response(JSON.stringify({ ok: false, reason: 'full', active: active.length, max: MAX_ACTIVE_HOOKS }), { headers: { 'Content-Type': 'application/json' } });
      }
      active.push(now);
      recent.push(now);
      ipLog[ip] = recent;
      await this.state.storage.put('active_hooks', active);
      await this.state.storage.put('ip_create_log', ipLog);
      await this.state.storage.put('total_hooks', (await this.state.storage.get('total_hooks') || 0) + 1);
      await this.state.storage.put(`hooks_${today}`, (await this.state.storage.get(`hooks_${today}`) || 0) + 1);
      return new Response(JSON.stringify({ ok: true, active: active.length, max: MAX_ACTIVE_HOOKS }), { headers: { 'Content-Type': 'application/json' } });
    }

    // 全局限流计数
    if (url.pathname === '/ratelimit') {
      const now = Date.now();
      if (!this.gSecStart || now - this.gSecStart >= 1000) { this.gSecStart = now; this.gSecCount = 0; }
      if (!this.gMinStart || now - this.gMinStart >= 60000) { this.gMinStart = now; this.gMinCount = 0; }
      this.gSecCount++;
      this.gMinCount++;
      if (this.gSecCount > RL_GLOBAL_PER_SEC) {
        return new Response(JSON.stringify({ ok: false, retryAfter: 1 }), { headers: { 'Content-Type': 'application/json' } });
      }
      if (this.gMinCount > RL_GLOBAL_PER_MIN) {
        return new Response(JSON.stringify({ ok: false, retryAfter: 60 }), { headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    // 计数：收到请求
    if (url.pathname === '/hook/request') {
      await this.state.storage.put('total_requests', (await this.state.storage.get('total_requests') || 0) + 1);
      await this.state.storage.put(`reqs_${today}`, (await this.state.storage.get(`reqs_${today}`) || 0) + 1);
      return new Response('ok');
    }

    // 计数：告警事件
    if (url.pathname === '/alert') {
      await this.state.storage.put('total_alerts', (await this.state.storage.get('total_alerts') || 0) + 1);
      await this.state.storage.put(`alerts_${today}`, (await this.state.storage.get(`alerts_${today}`) || 0) + 1);
      return new Response('ok');
    }

    // 存 NapCat 事件
    if (url.pathname === '/napcat_event' && request.method === 'POST') {
      const event = await request.json();
      const events = await this.state.storage.get('napcat_events') || [];
      events.unshift({
        time: new Date().toISOString(),
        type: event.post_type,
        msg: event.raw_message?.slice(0, 100),
        user: event.user_id
      });
      // 只留最近 20 条
      await this.state.storage.put('napcat_events', events.slice(0, 20));
      return new Response('ok');
    }

    // 获取统计数据
    if (url.pathname === '/stats') {
      const totalHooks = await this.state.storage.get('total_hooks') || 0;
      const totalReqs = await this.state.storage.get('total_requests') || 0;
      const totalAlerts = await this.state.storage.get('total_alerts') || 0;
      const todayHooks = await this.state.storage.get(`hooks_${today}`) || 0;
      const todayReqs = await this.state.storage.get(`reqs_${today}`) || 0;
      const todayAlerts = await this.state.storage.get(`alerts_${today}`) || 0;
      const napcatEvents = await this.state.storage.get('napcat_events') || [];
      
      return new Response(JSON.stringify({
        totalHooks, totalReqs, totalAlerts, todayHooks, todayReqs, todayAlerts, today, napcatEvents
      }), {
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
  <div style="font-size:11px;color:#fbbf24;margin-bottom:4px;">⏱ 本监听地址有效期 1 小时，到期后自动销毁（访问不会续期）</div>
  <div style="font-size:11px;color:#666;margin-bottom:12px;">限流：单监听 10 次/秒 · 300 次/分｜全站 60 次/秒 · 3000 次/分</div>
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
  // 定时保活：每3分钟 ping Render 上的 NapCat，防止休眠
  async scheduled(event, env, ctx) {
    const targets = [
      'https://napcat-bot.onrender.com/',
      'https://napcat-bot.onrender.com:3000/',
    ];
    
    const results = [];
    for (const url of targets) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        const resp = await fetch(url, {
          method: 'GET',
          signal: controller.signal,
          headers: { 'User-Agent': 'keepalive/1.0' }
        });
        clearTimeout(timeout);
        results.push(`${url} -> ${resp.status}`);
      } catch (e) {
        results.push(`${url} -> ERROR: ${e.message}`);
      }
    }
    
    console.log('[keepalive]', new Date().toISOString(), results.join(' | '));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // 管理员统计面板（密码保护）
    if (path === '/admin') {
      const auth = request.headers.get('Authorization') || '';
      // 兼容 Basic Auth 和 Bearer token
      let password = '';
      if (auth.startsWith('Basic ')) {
        const decoded = atob(auth.slice(6));
        password = decoded.split(':')[1] || '';
      } else if (auth.startsWith('Bearer ')) {
        password = auth.slice(7);
      }
      const ADMIN_PASS = env.ADMIN_PASSWORD || '';
      if (!ADMIN_PASS || password !== ADMIN_PASS) {
        return new Response('需要密码', {
          status: 401,
          headers: { 'WWW-Authenticate': 'Basic realm="Admin"' }
        });
      }
      const statsObj = env.STATS.get(env.STATS.idFromName('main'));
      const statsRes = await statsObj.fetch('http://stats/stats');
      const stats = await statsRes.json();
      
      const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>统计面板</title>
<style>
body{font-family:sans-serif;background:#0f0f0f;color:#eee;padding:20px}
.card{background:#1a1a1a;border-radius:8px;padding:16px;margin-bottom:12px}
.num{font-size:32px;font-weight:bold;color:#4ade80}
.label{font-size:12px;color:#888;margin-top:4px}
h1{font-size:18px;margin-bottom:16px}
</style></head><body>
<h1>📊 Webhook Inspector 统计</h1>
<div class="card"><div class="num">${stats.totalHooks}</div><div class="label">总监听数</div></div>
<div class="card"><div class="num">${stats.totalReqs}</div><div class="label">总请求数</div></div>
<div class="card"><div class="num">${stats.totalAlerts}</div><div class="label">总告警事件</div></div>
<div class="card"><div class="num">${stats.todayHooks}</div><div class="label">今日新建监听</div></div>
<div class="card"><div class="num">${stats.todayReqs}</div><div class="label">今日收到请求</div></div>
<div class="card"><div class="num">${stats.todayAlerts}</div><div class="label">今日告警事件</div></div>
${stats.napcatEvents?.length ? `<h1 style="margin-top:20px;font-size:16px">最近收到的QQ消息</h1>${stats.napcatEvents.map(e => `<div class="card" style="padding:10px"><div style="font-size:12px;color:#888">${e.user} · ${e.time?.slice(11,19)}</div><div style="margin-top:4px">${e.msg}</div></div>`).join('')}` : ''}
<div style="font-size:11px;color:#666;margin-top:20px">日期: ${stats.today}</div>
</body></html>`;
      
      return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    // 永久告警通道（不过期，接收摸鱼基地事件，转发到QQ机器人）
    if (path === '/alert' && request.method === 'POST') {
      try {
        const event = await request.json();
        const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
        
        // 组装QQ消息
        const msgText = `[摸鱼基地告警]\n事件：${event.event || event.action || '未知'}\n来源：${event.source || '-'}\n详情：${event.detail || '-'}\n时间：${event.time || now}`;
        
        // 计数
        const statsObj = env.STATS.get(env.STATS.idFromName('main'));
        await statsObj.fetch('http://stats/alert');
        
        // 通过 WebSocket 发 QQ 消息
        let forwarded = false;
        try {
          const sendResp = await statsObj.fetch('http://stats/send_qq', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              user_id: 2652911299,
              message: msgText
            })
          });
          const sendData = await sendResp.json();
          forwarded = sendData.ok === true;
        } catch (e) {
          console.log('send qq failed:', e.message);
        }
        
        return new Response(JSON.stringify({
          received: true,
          forwarded: forwarded,
          time: now
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 400 });
      }
    }

    // NapCat 事件接收（HTTP 客户端推过来的事件）
    if (path === '/napcat' && request.method === 'POST') {
      try {
        const event = await request.json();
        // 存到 StatsDO 里
        const statsObj = env.STATS.get(env.STATS.idFromName('main'));
        await statsObj.fetch('http://stats/napcat_event', {
          method: 'POST',
          body: JSON.stringify(event)
        });
        return new Response(JSON.stringify({ status: 'ok' }), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (e) {
        return new Response('bad request', { status: 400 });
      }
    }

    // NapCat WebSocket 连接（调试中，暂时禁用）
    // if (path === '/ws/napcat') {
    //   const statsObj = env.STATS.get(env.STATS.idFromName('main'));
    //   return statsObj.fetch(request);
    // }

    // 手动发 QQ 消息（调试中，暂时禁用）
    // if (path === '/send_qq' && request.method === 'POST') {
    //   const statsObj = env.STATS.get(env.STATS.idFromName('main'));
    //   return statsObj.fetch(request);
    // }

    // 首页：生成新的UUID，跳转到监听页面（受活跃监听上限约束）
    if (path === '/' || path === '/new') {
      const ip = request.headers.get('cf-connecting-ip') || 'unknown';
      const statsObj = env.STATS.get(env.STATS.idFromName('main'));
      const regRes = await statsObj.fetch('http://stats/hook/new', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip })
      });
      const reg = await regRes.json();
      if (!reg.ok) {
        const msg = reg.reason === 'too_many_ip'
          ? '创建太频繁：同一 IP 10 分钟内最多创建 10 个监听'
          : '监听已满：当前活跃监听已达 ' + reg.active + '/' + reg.max;
        return new Response('<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>已满</title></head><body style="font-family:sans-serif;background:#0f0f0f;color:#eee;padding:24px"><h2>' + msg + '</h2><p style="color:#888;font-size:14px">活跃监听：' + reg.active + '/' + reg.max + '</p><p><a style="color:#4ade80" href="/">重试</a></p></body></html>', {
          status: 429, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Retry-After': '600' }
        });
      }
      const uuid = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
      return Response.redirect(url.origin + '/' + uuid, 302);
    }

    // 监听页面
    const match = path.match(/^\/([a-zA-Z0-9]{8,32})$/);
    if (match && request.method === 'GET') {
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
      // 全局限流：所有监听之和
      const statsObj = env.STATS.get(env.STATS.idFromName('main'));
      const rlRes = await statsObj.fetch('http://stats/ratelimit');
      const rl = await rlRes.json();
      if (!rl.ok) {
        return new Response(JSON.stringify({ error: 'rate_limited', scope: 'global' }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': String(rl.retryAfter || 1) }
        });
      }
      const idObject = env.WEBHOOK_INSPECTOR.get(env.WEBHOOK_INSPECTOR.idFromName(id));
      // 计数：收到请求
      await statsObj.fetch('http://stats/hook/request');
      return idObject.fetch(request);
    }

    return new Response('Not Found', { status: 404 });
  }
};

