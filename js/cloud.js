/* cloud.js —— 云就绪统一数据服务
 * 提供与本地 db.js（IndexedDB）完全一致的接口：getAll / get / put / del / getMeta / setMeta / id / open / STORES。
 * 应用其余代码只依赖本服务，不关心底层是本地还是云端。
 *
 * 两种后端：
 *  - local：回落到现有 IndexedDB（window.HDB），离线可用，无需登录。
 *  - cloud：使用 @tencent-ai/workbuddy-cloud-sdk 的 Database + Auth 模块，
 *           用户数据按 owner_id 自动隔离（RLS），存储结构为每个表 (id, owner_id, data jsonb, created_at)，
 *           业务对象整体存入 data 字段，避免逐字段 DDL，升级更稳健。
 *
 * 切换方式：注入 CLOUD_CONFIG 并将 CLOUD_MODE 设为 'cloud' 即可，无需改动业务代码。
 */
(function (global) {
  'use strict';

  var HDB = global.HDB; // 本地后端
  var CONFIG = global.CLOUD_CONFIG || null;
  var MODE = (global.CLOUD_MODE === 'cloud' && CONFIG && CONFIG.endpoint && CONFIG.publishableKey)
    ? 'cloud' : 'local';

  var cloud = null;        // 云端客户端实例
  var sessionUser = null;  // 当前登录用户
  var loginShown = false;  // 防止重复弹出登录框

  var STORES = ['food', 'boxes', 'items', 'chores', 'dailies', 'bills', 'meta'];

  function id() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  // 动态加载云端 SDK（仅在云端模式、且需要时才联网，避免影响本地/离线体验）
  function loadScript(src) {
    return new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = function () { res(); };
      s.onerror = function () { rej(new Error('云服务脚本加载失败，请检查网络')); };
      document.head.appendChild(s);
    });
  }

  /* ---------------- 初始化 ---------------- */
  function init() {
    if (MODE !== 'cloud') return Promise.resolve(); // 本地模式无需初始化
    return loadScript('https://cdn.jsdelivr.net/npm/@tencent-ai/workbuddy-cloud-sdk@dev/lib/index.global.js')
      .then(function () {
        if (!global.WorkBuddyCloud) throw new Error('云服务 SDK 未就绪');
        cloud = global.WorkBuddyCloud.createWorkBuddyCloud({
          endpoint: CONFIG.endpoint,
          publishableKey: CONFIG.publishableKey,
          oauthRelayBaseUrl: CONFIG.oauthRelayBaseUrl || ''
        });
      })
      .then(restoreSession);
  }

  function restoreSession() {
    if (!cloud) return Promise.resolve(null);
    return cloud.auth.getSession().then(function (r) {
      sessionUser = (r && !r.error && r.data) ? r.data.user : null;
      return sessionUser;
    }).catch(function () { return null; });
  }

  /* ---------------- 鉴权门禁（仅云端模式） ---------------- */
  function authGate() {
    if (!cloud) return Promise.reject(new Error('云服务未初始化'));
    return cloud.auth.getSession().then(function (r) {
      if (r.error || !r.data) {
        var e = new Error('请先登录后再访问云端数据');
        e.needLogin = true;
        if (global.CloudDB && global.CloudDB.onNeedLogin && !loginShown) {
          loginShown = true;
          global.CloudDB.onNeedLogin();
        }
        return Promise.reject(e);
      }
      return r.data;
    });
  }

  /* ---------------- 本地实现（回落） ---------------- */
  function localAll(store) { return HDB.getAll(store); }
  function localGet(store, sid) { return HDB.get(store, sid); }
  function localPut(store, obj) { return HDB.put(store, obj); }
  function localDel(store, sid) { return HDB.del(store, sid); }
  function localGetMeta(k, d) { return HDB.getMeta(k, d); }
  function localSetMeta(k, v) { return HDB.setMeta(k, v); }

  /* ---------------- 云端实现 ---------------- */
  // 业务对象整体存入 data 字段；id 同时作为主键用于 upsert 冲突判定。
  function cloudAll(store) {
    return authGate().then(function () {
      return cloud.database.from(store).select('id, data').order('created_at', { ascending: false });
    }).then(function (r) {
      if (r.error) throw r.error;
      return (r.data || []).map(function (x) { return x.data; });
    });
  }
  function cloudGet(store, sid) {
    return authGate().then(function () {
      return cloud.database.from(store).select('id, data').eq('id', sid).maybeSingle();
    }).then(function (r) {
      if (r.error) throw r.error;
      return r.data ? r.data.data : null;
    });
  }
  function cloudPut(store, obj) {
    return authGate().then(function () {
      return cloud.database.from(store).upsert({ id: obj.id, data: obj }).select();
    }).then(function (r) {
      if (r.error) throw r.error;
      if (!r.data || !r.data.length) throw new Error('保存失败：数据未被服务端接受（可能是权限不足）');
      return obj;
    });
  }
  function cloudDel(store, sid) {
    return authGate().then(function () {
      return cloud.database.from(store).delete().eq('id', sid).select();
    }).then(function (r) {
      if (r.error) throw r.error;
      return true;
    });
  }
  function cloudGetMeta(k, d) {
    return cloudGet('meta', k).then(function (v) { return (v == null) ? d : v; });
  }
  function cloudSetMeta(k, v) { return cloudPut('meta', { id: k, data: v }); }

  /* ---------------- 统一接口 ---------------- */
  function getAll(store) { return MODE === 'cloud' ? cloudAll(store) : localAll(store); }
  function get(store, sid) { return MODE === 'cloud' ? cloudGet(store, sid) : localGet(store, sid); }
  function put(store, obj) { return MODE === 'cloud' ? cloudPut(store, obj) : localPut(store, obj); }
  function del(store, sid) { return MODE === 'cloud' ? cloudDel(store, sid) : localDel(store, sid); }
  function getMeta(k, d) { return MODE === 'cloud' ? cloudGetMeta(k, d) : localGetMeta(k, d); }
  function setMeta(k, v) { return MODE === 'cloud' ? cloudSetMeta(k, v) : localSetMeta(k, v); }
  function open() { return MODE === 'cloud' ? init() : HDB.open(); }

  /* ---------------- 登录（仅云端模式） ---------------- */
  // 采用手机号验证码（OTP）注册/登录，符合技能的默认登录契约。
  function loginWithPhone(phone) {
    if (MODE !== 'cloud' || !cloud) return Promise.reject(new Error('当前非云端模式'));
    return cloud.auth.sendOtp({ phone }).then(function (r) {
      if (r.error) throw r.error;
      return r.data; // { verificationId, isExistingUser }
    });
  }
  function verifyPhone(phone, challenge, code) {
    if (MODE !== 'cloud' || !cloud) return Promise.reject(new Error('当前非云端模式'));
    return cloud.auth.verifyOtp({
      phone: phone,
      verificationId: challenge.verificationId,
      isExistingUser: challenge.isExistingUser,
      token: code
    }).then(function (r) {
      if (r.error) throw r.error;
      sessionUser = r.data ? r.data.user : null;
      loginShown = false;
      return r.data;
    });
  }
  function logout() {
    if (!cloud) return Promise.resolve();
    return cloud.auth.signOut().then(function () { sessionUser = null; loginShown = false; });
  }

  global.CloudDB = {
    open: open, getAll: getAll, get: get, put: put, del: del,
    getMeta: getMeta, setMeta: setMeta, id: id, STORES: STORES,
    mode: function () { return MODE; },
    init: init,
    loginWithPhone: loginWithPhone,
    verifyPhone: verifyPhone,
    logout: logout,
    currentUser: function () { return sessionUser; },
    getSession: restoreSession,
    onNeedLogin: null
  };
})(window);
