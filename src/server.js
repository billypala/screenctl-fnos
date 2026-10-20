'use strict';
// 屏幕开关服务：node:http 零依赖
// - 统一网关前缀 /app/screenctl
// - Unix Socket 监听（fnOS 部署）或 PORT（本地开发）
// - 特权动作经 sudo -n 调用包内 priv-helper.sh（sudoers 白名单，仅此一个路径）
// - 本地开发（win32 或 SCREENCTL_MOCK=1）为 mock 模式，不执行真实命令

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const PORT = Number(process.env.PORT || 5091);
const HOST = process.env.HOST || '127.0.0.1';
const SOCKET_PATH = process.env.SOCKET_PATH || '';
const GATEWAY_PREFIX = process.env.GATEWAY_PREFIX || '/app/screenctl';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const LOGIND_CONF = process.env.LOGIND_CONF || '/etc/systemd/logind.conf';

const MOCK = process.platform === 'win32' || process.env.SCREENCTL_MOCK === '1';

let HELPER = '';
try {
  // sudoers 白名单必须写真实路径（/var/apps/<app> 可能是符号链接），两端都用 realpath 保持一致
  HELPER = fs.realpathSync(path.join(__dirname, 'priv-helper.sh'));
} catch { /* mock 模式无需 */ }

fs.mkdirSync(DATA_DIR, { recursive: true });
const STATE_FILE = path.join(DATA_DIR, 'screen-state.json');

const LID_KEYS = ['HandleLidSwitch', 'HandleLidSwitchExternalPower', 'HandleLidSwitchDocked'];

// 真实屏幕状态来自帧缓冲 blank 节点：0=点亮，1=熄灭（与 setterm poke/force 一致）
const FB_BLANK = '/sys/class/graphics/fb0/blank';

// ---------- 状态读取 ----------

// 优先读取硬件真实状态（fb0/blank），不可用时回退状态文件缓存，最终兜底"点亮"
function readScreenState() {
  try {
    const v = fs.readFileSync(FB_BLANK, 'utf8').trim();
    if (v === '0') return true;  // 屏幕点亮
    if (v === '1') return false; // 屏幕熄灭
  } catch { /* sysfs 不可用，回退状态文件 */ }
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).screen !== false;
  } catch {
    return true; // 默认屏幕点亮
  }
}

// 仅在 sysfs 不可用时作为缓存兜底；真实状态以 fb0/blank 为准
function writeScreenState(on) {
  try {
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ screen: !!on, updatedAt: new Date().toISOString() }), 'utf8');
    fs.renameSync(tmp, STATE_FILE);
  } catch { /* 缓存写入失败不影响真实检测 */ }
}

// 合盖状态直接以系统文件为准（三个键全部为未注释的 =ignore 才算开启）
function readLidState() {
  try {
    const text = fs.readFileSync(LOGIND_CONF, 'utf8');
    return LID_KEYS.every((k) => new RegExp(`^${k}=ignore\\s*$`, 'm').test(text));
  } catch {
    return false;
  }
}

// ---------- 特权执行 ----------

function runPriv(action) {
  if (MOCK || !HELPER) {
    console.log(`[mock] priv: ${action}`);
    return Promise.resolve({ ok: true, mock: true });
  }
  return new Promise((resolve) => {
    execFile('sudo', ['-n', HELPER, action], { timeout: 20000, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) {
        const lines = String(stderr || err.message).trim().split('\n');
        resolve({ ok: false, error: (lines[lines.length - 1] || '执行失败').slice(0, 200) });
      } else {
        resolve({ ok: true });
      }
    });
  });
}

// ---------- HTTP 工具 ----------

// 网关注入 X-Trim-Isadmin；无该头（本地直连调试）时放行
function isAdmin(req) {
  const v = req.headers['x-trim-isadmin'];
  return v === undefined || v === '' || v === '1' || v === 'true';
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req, limit = 4 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

// ---------- 路由 ----------

const routes = [];

function route(method, pattern, handler) {
  routes.push({ method, pattern, handler });
}

function matchRoute(method, pathname) {
  for (const r of routes) {
    if (r.method === method && r.pattern === pathname) return r.handler;
  }
  return null;
}

route('GET', `${GATEWAY_PREFIX}/api/state`, async (req, res) => {
  if (!isAdmin(req)) return sendJson(res, 403, { ok: false, error: '仅管理员可操作' });
  sendJson(res, 200, { ok: true, screen: readScreenState(), lid: readLidState(), mock: MOCK });
});

route('POST', `${GATEWAY_PREFIX}/api/screen`, async (req, res) => {
  if (!isAdmin(req)) return sendJson(res, 403, { ok: false, error: '仅管理员可操作' });
  const body = await readBody(req);
  const on = !!body.on;
  const r = await runPriv(on ? 'screen-on' : 'screen-off');
  if (!r.ok) return sendJson(res, 500, { ok: false, error: r.error || '执行失败' });
  writeScreenState(on);
  sendJson(res, 200, { ok: true, screen: readScreenState() });
});

route('POST', `${GATEWAY_PREFIX}/api/lid`, async (req, res) => {
  if (!isAdmin(req)) return sendJson(res, 403, { ok: false, error: '仅管理员可操作' });
  const body = await readBody(req);
  const on = !!body.on;
  const r = await runPriv(on ? 'lid-on' : 'lid-off');
  if (!r.ok) return sendJson(res, 500, { ok: false, error: r.error || '执行失败' });
  // 以系统文件实际状态为准，避免假成功
  sendJson(res, 200, { ok: true, lid: readLidState() });
});

route('POST', `${GATEWAY_PREFIX}/api/reboot`, async (req, res) => {
  if (!isAdmin(req)) return sendJson(res, 403, { ok: false, error: '仅管理员可操作' });
  const r = await runPriv('reboot');
  if (!r.ok) return sendJson(res, 500, { ok: false, error: r.error || '执行失败' });
  sendJson(res, 200, { ok: true, rebooting: true });
});

// ---------- 静态资源 ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8'
};

function serveStatic(req, res, pathname) {
  let rel = pathname;
  if (rel === '/' || rel === '') rel = '/index.html';
  rel = rel.replace(/^\/+/, '');

  let full = path.join(PUBLIC_DIR, rel);
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(full, (err, buf) => {
    if (err) {
      // 网关可能转发带前缀的路径（/app/screenctl/...），统一回退首页
      full = path.join(PUBLIC_DIR, 'index.html');
      fs.readFile(full, (e2, idx) => {
        if (e2) {
          res.writeHead(404);
          return res.end('Not found');
        }
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
        res.end(idx);
      });
      return;
    }
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(buf);
  });
}

// ---------- 服务器 ----------

const PUBLIC_DIR = path.join(__dirname, 'public');

const server = http.createServer(async (req, res) => {
  // 网关会把原始路径透传，也可能在剥离前缀后转发，两种都兼容
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    pathname = req.url;
  }

  const matched = matchRoute(req.method, pathname);
  const alt = !matched && pathname.startsWith('/api/')
    ? matchRoute(req.method, `${GATEWAY_PREFIX}${pathname}`)
    : null;
  const handler = matched || alt;

  if (handler) {
    try {
      await handler(req, res);
    } catch (err) {
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: err.message || '服务器内部错误' });
      else { try { res.end(); } catch { /* ignore */ } }
    }
    return;
  }

  serveStatic(req, res, pathname);
});

function listen() {
  if (SOCKET_PATH) {
    fs.rmSync(SOCKET_PATH, { force: true });
    server.listen(SOCKET_PATH, () => {
      console.log(`screenctl server running on unix socket ${SOCKET_PATH}`);
    });
  } else {
    server.listen(PORT, HOST, () => {
      console.log(`screenctl server running at http://${HOST}:${PORT}${GATEWAY_PREFIX}`);
    });
  }
}

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

listen();

module.exports = { server };
