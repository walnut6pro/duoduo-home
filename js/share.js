/* share.js —— 免服务器的「链接共享」
 * 把家庭数据（食品/收纳盒/物项/家务/每日必做）压缩后放进链接的 #s= 片段，
 * 任何人用 Safari 打开该链接即可看到同样内容，并可选择合并到自己的应用中。
 * 说明：这是"随链接传播的快照"，不是实时双向同步；对方合并后可再生成新链接继续传播。
 */
(function (global) {
  'use strict';

  var KEYS = ['food', 'boxes', 'items', 'chores', 'dailies'];
  // 共享时只保留必要字段，缩短链接长度
  var FIELDS = {
    food: ['name', 'category', 'room', 'boxId', 'quantity', 'unit', 'purchaseDate', 'expiryDate', 'remindDays', 'note'],
    boxes: ['name', 'type', 'room', 'note'],
    items: ['name', 'category', 'room', 'boxId', 'quantity', 'note'],
    chores: ['title', 'room', 'priority', 'dueDate', 'done', 'doneAt'],
    dailies: ['title', 'note']
  };

  function b64url(bytes) {
    var s = '', i;
    for (i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function unb64url(str) {
    var s = String(str).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    var bin = atob(s), out = new Uint8Array(bin.length), i;
    for (i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function compact(data) {
    var out = {};
    KEYS.forEach(function (k) {
      out[k] = (data[k] || []).map(function (o) {
        var r = { i: o.id };
        (FIELDS[k] || []).forEach(function (f) {
          if (o[f] != null && o[f] !== '') r[f] = o[f];
        });
        return r;
      });
    });
    return out;
  }
  function expand(c) {
    var out = {};
    KEYS.forEach(function (k) {
      out[k] = ((c && c[k]) || []).map(function (r) {
        var o = {}, key;
        for (key in r) { if (Object.prototype.hasOwnProperty.call(r, key)) o[key] = r[key]; }
        o.id = o.i || o.id;
        delete o.i;
        return o;
      });
    });
    return out;
  }

  // 压缩：优先用浏览器内置 deflate-raw，不支持则原样 base64
  function pack(str) {
    var bytes = new TextEncoder().encode(str);
    if (typeof global.CompressionStream === 'function') {
      try {
        var cs = new global.CompressionStream('deflate-raw');
        var w = cs.writable.getWriter();
        w.write(bytes); w.close();
        return new Response(cs.readable).arrayBuffer().then(function (buf) {
          return 'z' + b64url(new Uint8Array(buf));
        }).catch(function () { return 'r' + b64url(bytes); });
      } catch (e) { /* 回落 */ }
    }
    return Promise.resolve('r' + b64url(bytes));
  }
  function unpack(s) {
    var mode = String(s).charAt(0);
    var bytes = unb64url(String(s).slice(1));
    if (mode === 'z' && typeof global.DecompressionStream === 'function') {
      try {
        var ds = new global.DecompressionStream('deflate-raw');
        var w = ds.writable.getWriter();
        w.write(bytes); w.close();
        return new Response(ds.readable).arrayBuffer().then(function (buf) {
          return new TextDecoder().decode(buf);
        });
      } catch (e) { /* 回落 */ }
    }
    return Promise.resolve(new TextDecoder().decode(bytes));
  }

  function count(d) {
    var n = 0;
    KEYS.forEach(function (k) { n += ((d && d[k]) || []).length; });
    return n;
  }
  function has(d) { return count(d) > 0; }

  // 生成可分享链接（把当前数据放进 hash）
  function buildLink(data) {
    return pack(JSON.stringify(compact(data))).then(function (s) {
      var base = location.origin + location.pathname + (location.search || '');
      return base + '#s=' + s;
    });
  }

  // 读取链接里携带的共享内容
  function readFromUrl() {
    var m = location.hash.match(/[#&]s=([A-Za-z0-9\-_]+)/);
    if (!m) return Promise.resolve(null);
    return unpack(m[1]).then(function (str) {
      try { return expand(JSON.parse(str)); } catch (e) { return null; }
    }).catch(function () { return null; });
  }

  // 合并后清掉 hash，避免刷新时反复提示
  function clearHash() {
    try { history.replaceState(null, '', location.pathname + (location.search || '')); }
    catch (e) { try { location.hash = ''; } catch (e2) {} }
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; }).catch(function () { return legacyCopy(text); });
    }
    return Promise.resolve(legacyCopy(text));
  }
  function legacyCopy(text) {
    try {
      var ta = document.getElementById('shareLink') || document.createElement('textarea');
      ta.value = text;
      if (!ta.parentNode) { ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); }
      ta.focus();
      ta.setSelectionRange(0, text.length);
      var ok = document.execCommand('copy');
      if (!ta.parentNode || ta.parentNode === document.body && ta.id !== 'shareLink') document.body.removeChild(ta);
      return ok;
    } catch (e) { return false; }
  }

  global.HShare = {
    buildLink: buildLink, readFromUrl: readFromUrl, clearHash: clearHash,
    count: count, has: has, copyText: copyText, KEYS: KEYS
  };
})(window);
