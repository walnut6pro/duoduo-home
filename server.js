/* server.js —— 多多管家「轻量共享房间」后端（零依赖，仅用 Node 内置模块）
 *
 * 作用：
 *  1) 托管本目录的静态文件（让 PWA 可以从同一域名访问，共享链接与接口同域）。
 *  2) 提供极简的「共享房间」接口，无需账号体系：
 *       POST /api/room/:id   发布/更新一个房间的共享快照（body: { data, updatedAt }）
 *       GET  /api/room/:id   读取该房间的共享快照（404 表示尚无内容）
 *
 * 安全：
 *  - roomId 仅允许 [A-Za-z0-9_-]{6,48}，杜绝路径穿越。
 *  - 请求体限制 3MB，避免滥用。
 *  - 静态服务禁止访问 dotfile、.git、server.js 与 rooms/ 目录本身。
 *
 * 运行：node server.js   （端口可用 PORT 环境变量覆盖，默认 3000）
 */
'use strict';
var http = require('http');
var fs = require('fs');
var path = require('path');

var ROOT = __dirname;
var ROOMS_DIR = path.join(ROOT, 'rooms');
var SHARED_DIR = path.join(ROOT, 'shared');
var SHARED_FILE = path.join(SHARED_DIR, 'data.json');
var PORT = process.env.PORT || 3000;
var MAX_BODY = 3 * 1024 * 1024; // 3MB
var ROOM_ID_RE = /^[A-Za-z0-9_-]{6,48}$/;

var MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8'
};

try { if (!fs.existsSync(ROOMS_DIR)) fs.mkdirSync(ROOMS_DIR, { recursive: true }); } catch (e) { /* ignore */ }
try { if (!fs.existsSync(SHARED_DIR)) fs.mkdirSync(SHARED_DIR, { recursive: true }); } catch (e) { /* ignore */ }

function sendJSON(res, code, obj) {
  var s = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(s);
}

function readBody(req, cb) {
  var chunks = [], size = 0, done = false;
  req.on('data', function (c) {
    if (done) return;
    size += c.length;
    if (size > MAX_BODY) { done = true; cb(new Error('PAYLOAD_TOO_LARGE')); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', function () { if (!done) cb(null, Buffer.concat(chunks)); });
  req.on('error', function (e) { if (!done) { done = true; cb(e); } });
}

function safeStatic(reqPath) {
  // 去掉查询串，归一化，禁止穿越到根目录之外
  var p = decodeURIComponent(reqPath.split('?')[0]);
  if (p === '/' || p === '') p = '/index.html';
  var full = path.normalize(path.join(ROOT, p));
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) return null;
  var rel = path.relative(ROOT, full);
  if (rel.startsWith('..')) return null;
  if (rel === 'server.js') return null;
  if (rel.split(path.sep).some(function (seg) { return seg.startsWith('.') || seg === 'rooms'; })) return null;
  return full;
}

function serveStatic(req, res, full) {
  fs.readFile(full, function (err, buf) {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404 Not Found'); return; }
    var ext = path.extname(full).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(buf);
  });
}

function handleRoom(req, res, id) {
  if (!ROOM_ID_RE.test(id)) { sendJSON(res, 400, { ok: false, error: 'invalid room id' }); return; }
  var file = path.join(ROOMS_DIR, id + '.json');

  if (req.method === 'GET') {
    fs.readFile(file, function (err, buf) {
      if (err) { sendJSON(res, 404, { ok: false }); return; }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(buf);
    });
    return;
  }
  if (req.method === 'POST' || req.method === 'PUT') {
    readBody(req, function (e, buf) {
      if (e) {
        if (e.message === 'PAYLOAD_TOO_LARGE') { sendJSON(res, 413, { ok: false, error: 'payload too large' }); }
        else { sendJSON(res, 400, { ok: false, error: 'bad request' }); }
        return;
      }
      var parsed;
      try { parsed = JSON.parse(buf.toString('utf8')); }
      catch (err2) { sendJSON(res, 400, { ok: false, error: 'invalid json' }); return; }
      if (!parsed || typeof parsed !== 'object' || !parsed.data || typeof parsed.data !== 'object') {
        sendJSON(res, 400, { ok: false, error: 'missing data' }); return;
      }
      var rec = { updatedAt: parsed.updatedAt || Date.now(), data: parsed.data };
      fs.writeFile(file, JSON.stringify(rec), function (we) {
        if (we) { sendJSON(res, 500, { ok: false, error: 'write failed' }); return; }
        sendJSON(res, 200, { ok: true, updatedAt: rec.updatedAt });
      });
    });
    return;
  }
  sendJSON(res, 405, { ok: false, error: 'method not allowed' });
}

/* ---------- 共享数据表（方案升级：多人双向实时同步） ----------
 * 所有家庭成员读写同一份云端数据（不再是一方发布一方接收）。
 *   GET  /api/shared        拉取全量（含已删除项列表，用于跨端传播删除）
 *   POST /api/shared/sync   推送一批变更（upsert/delete），按 id+updatedAt last-write-wins 合并，返回合并后全量
 */
var SHARED_TYPES = ['food', 'boxes', 'items', 'chores', 'dailies', 'bills'];
function emptyShared() { var o = {}; SHARED_TYPES.forEach(function (k) { o[k] = []; }); return o; }
// 归并去重：同一 id 只保留 updatedAt 最大的一行（相等时优先非删除），杜绝旧代码遗留的重复行
function defragShared(d) {
  SHARED_TYPES.forEach(function (k) {
    var arr = d[k]; if (!Array.isArray(arr)) { d[k] = []; return; }
    var byId = {};
    arr.forEach(function (it) {
      if (!it || !it.id) return;
      var cur = byId[it.id];
      if (!cur) { byId[it.id] = it; return; }
      var t1 = cur.updatedAt || 0, t2 = it.updatedAt || 0;
      if (t2 > t1) byId[it.id] = it;
      else if (t2 === t1 && !it.deleted && cur.deleted) byId[it.id] = it;
    });
    var out = [];
    Object.keys(byId).forEach(function (id) { out.push(byId[id]); });
    d[k] = out;
  });
  return d;
}
function readShared() {
  var d;
  try { d = JSON.parse(fs.readFileSync(SHARED_FILE, 'utf8')); } catch (e) { d = null; }
  if (!d || typeof d !== 'object') d = {};
  SHARED_TYPES.forEach(function (k) { if (!Array.isArray(d[k])) d[k] = []; });
  return defragShared(d);
}
function writeShared(obj) { try { fs.writeFileSync(SHARED_FILE, JSON.stringify(obj)); } catch (e) {} }
// 把内部存储（含 soft-delete 标记）转换为对外结构：正常条目 + 删除列表
function sharedSnapshot(d) {
  var out = emptyShared(), deleted = [];
  SHARED_TYPES.forEach(function (k) {
    (d[k] || []).forEach(function (it) {
      if (!it || !it.id) return;
      if (it.deleted) deleted.push({ id: it.id, type: k, t: it.updatedAt || 0 });
      else out[k].push(it);
    });
  });
  return { ok: true, data: out, deleted: deleted, serverTime: Date.now() };
}
function handleShared(req, res) {
  var pathOnly = (req.url || '/').split('?')[0];
  if (!/^\/api\/shared(\/sync)?$/.test(pathOnly)) { sendJSON(res, 404, { ok: false, error: 'not found' }); return; }
  if (req.method === 'GET') {
    sendJSON(res, 200, sharedSnapshot(readShared()));
    return;
  }
  if (req.method === 'POST') {
    readBody(req, function (e, buf) {
      if (e) { sendJSON(res, e.message === 'PAYLOAD_TOO_LARGE' ? 413 : 400, { ok: false, error: 'bad request' }); return; }
      var parsed;
      try { parsed = JSON.parse(buf.toString('utf8')); } catch (e2) { sendJSON(res, 400, { ok: false, error: 'invalid json' }); return; }
      // 显式清空（仅供初始化/重置共享表，需要正确的 sharecode）
      if (parsed && parsed.wipe === true) { var e2 = emptyShared(); defragShared(e2); writeShared(e2); sendJSON(res, 200, sharedSnapshot(e2)); return; }
      if (!parsed || !Array.isArray(parsed.changes)) { sendJSON(res, 400, { ok: false, error: 'missing changes' }); return; }
      var d = readShared();
      parsed.changes.forEach(function (c) {
        if (!c || SHARED_TYPES.indexOf(c.type) < 0) return;
        var arr = d[c.type] || (d[c.type] = []);
        var t = c.updatedAt || Date.now();
        var idx = -1, k;
        for (k = 0; k < arr.length; k++) { if (arr[k] && arr[k].id === c.id) { idx = k; break; } }
        if (c.op === 'delete') {
          // 找到同 id（含已删除）且较旧则标记删除；找不到则新增一条删除记录（保证单一 id）
          if (idx >= 0) { if ((arr[idx].updatedAt || 0) <= t) { arr[idx].deleted = true; arr[idx].updatedAt = t; } }
          else { arr.push({ id: c.id, deleted: true, updatedAt: t }); }
        } else { // upsert：按 id 定位单条，较新则覆盖并清除删除标记，否则保持
          var item = c.item || {}; item.updatedAt = t;
          if (idx >= 0) { if ((arr[idx].updatedAt || 0) <= t) { Object.assign(arr[idx], item); delete arr[idx].deleted; } }
          else { arr.push(item); }
        }
      });
      defragShared(d);
      writeShared(d);
      sendJSON(res, 200, sharedSnapshot(d));
    });
    return;
  }
  sendJSON(res, 405, { ok: false, error: 'method not allowed' });
}

var server = http.createServer(function (req, res) {
  var url = req.url || '/';
  var pathOnly = url.split('?')[0];
  var sm = pathOnly.match(/^\/api\/shared(\/sync)?$/);
  if (sm) { handleShared(req, res); return; }
  var m = url.match(/^\/api\/room\/([^/?#]+)/);
  if (m) { handleRoom(req, res, decodeURIComponent(m[1])); return; }

  if (req.method === 'GET' || req.method === 'HEAD') {
    var full = safeStatic(url);
    if (!full) { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('403 Forbidden'); return; }
    if (req.method === 'HEAD') { res.writeHead(200); res.end(); return; }
    serveStatic(req, res, full);
    return;
  }
  res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('405 Method Not Allowed');
});

server.listen(PORT, function () {
  console.log('多多管家共享服务已启动： http://localhost:' + PORT);
  console.log('（把此地址/局域网 IP 发给家人，即可通过「共享房间」实时查看数据）');
});
