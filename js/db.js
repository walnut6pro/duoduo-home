/* db.js —— 本地数据存储层（IndexedDB）
 * 设计目标：本机存储、离线可用、版本升级时数据不丢失。
 * 升级策略：onupgradeneeded 只“新增”对象仓库/索引，绝不删除已有数据，
 *           字段新增通过读取时补默认值兼容，因此每次部署新版本数据都会保留。
 */
(function (global) {
  'use strict';
  var DB_NAME = 'duoduo_home';
  var DB_VERSION = 2; // 后续迭代请 +1，并在 onupgradeneeded 中只做增量
  var STORES = ['food', 'boxes', 'items', 'chores', 'dailies', 'meta'];

  var _db = null;

  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise(function (resolve, reject) {
      if (!('indexedDB' in global)) {
        reject(new Error('当前浏览器不支持本地数据库（IndexedDB）'));
        return;
      }
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        // 首次创建各对象仓库（keyPath=id，自建 id）
        if (!db.objectStoreNames.contains('food')) {
          var s = db.createObjectStore('food', { keyPath: 'id' });
          s.createIndex('expiryDate', 'expiryDate', { unique: false });
          s.createIndex('room', 'room', { unique: false });
        }
        if (!db.objectStoreNames.contains('boxes')) {
          var b = db.createObjectStore('boxes', { keyPath: 'id' });
          b.createIndex('room', 'room', { unique: false });
        }
        if (!db.objectStoreNames.contains('items')) {
          var it = db.createObjectStore('items', { keyPath: 'id' });
          it.createIndex('boxId', 'boxId', { unique: false });
          it.createIndex('room', 'room', { unique: false });
          it.createIndex('category', 'category', { unique: false });
        }
        if (!db.objectStoreNames.contains('chores')) {
          var c = db.createObjectStore('chores', { keyPath: 'id' });
          c.createIndex('done', 'done', { unique: false });
          c.createIndex('room', 'room', { unique: false });
        }
        if (!db.objectStoreNames.contains('dailies')) {
          db.createObjectStore('dailies', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' });
        }
        // 自动本地备份快照仓库（独立于工作数据，clearAll 不清理，便于回滚）
        if (!db.objectStoreNames.contains('backups')) {
          db.createObjectStore('backups', { keyPath: 'id' });
        }
        // 未来升级：在此处用 e.oldVersion 判断后增量添加，勿删旧数据
      };
      req.onsuccess = function () { _db = req.result; resolve(_db); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function tx(store, mode) {
    return open().then(function (db) {
      return db.transaction(store, mode).objectStore(store);
    });
  }

  function getAll(store) {
    return tx(store, 'readonly').then(function (os) {
      return new Promise(function (res, rej) {
        var r = os.getAll();
        r.onsuccess = function () { res(r.result || []); };
        r.onerror = function () { rej(r.error); };
      });
    });
  }

  function get(store, id) {
    return tx(store, 'readonly').then(function (os) {
      return new Promise(function (res, rej) {
        var r = os.get(id);
        r.onsuccess = function () { res(r.result); };
        r.onerror = function () { rej(r.error); };
      });
    });
  }

  function put(store, obj) {
    return tx(store, 'readwrite').then(function (os) {
      return new Promise(function (res, rej) {
        var r = os.put(obj);
        r.onsuccess = function () { res(obj); };
        r.onerror = function () { rej(r.error); };
      });
    });
  }

  function del(store, id) {
    return tx(store, 'readwrite').then(function (os) {
      return new Promise(function (res, rej) {
        var r = os.delete(id);
        r.onsuccess = function () { res(true); };
        r.onerror = function () { rej(r.error); };
      });
    });
  }

  function getMeta(key, def) {
    return get('meta', key).then(function (v) { return v ? v.value : def; });
  }
  function setMeta(key, value) {
    return put('meta', { key: key, value: value });
  }

  function id() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  global.HDB = {
    open: open, getAll: getAll, get: get, put: put, del: del,
    getMeta: getMeta, setMeta: setMeta, id: id, STORES: STORES
  };
})(window);
