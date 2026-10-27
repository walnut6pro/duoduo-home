/* app.js —— 多多管家 PWA 主程序
 * 六大模块：1食品保质期 2收纳(盒+物项) 3语音智能分类 4家务 5每日必做 6我的(设置/备份/版本)
 */
(function () {
  'use strict';
  var CloudDB = window.CloudDB, HClassify = window.HClassify, HSpeech = window.HSpeech, HShare = window.HShare, HDB = window.HDB;
  var APP_VERSION = '1.0';

  var ROOMS = ['厨房', '客厅', '卧室', '卫生间', '书房', '阳台', '储物间'];
  var BOX_TYPES = ['箱子', '收纳盒'];
  var PRIOS = ['高', '中', '低'];

  var state = {
    tab: 'food',
    food: [], boxes: [], items: [], chores: [], dailies: [], bills: [],
    remindDays: 7, notifEnabled: false, _notifiedToday: '',
    shareRoomId: '', shareAuto: false,
    autoBackup: false, autoBackupDays: 1
  };

  /* ---------- 工具 ---------- */
  function $(s, r) { return (r || document).querySelector(s); }
  function $all(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function today() { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function daysBetween(a, b) { return Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000); }

  var toastTimer;
  function toast(msg, ms) {
    var t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.remove('show'); }, ms || 2000);
  }

  /* ---------- 模态弹窗 ---------- */
  function openModal(title, bodyHTML, onSubmit, opts) {
    opts = opts || {};
    var overlay = $('#modal');
    overlay.innerHTML =
      '<div class="sheet">' +
      '<div class="sheet-head"><span>' + esc(title) + '</span><button class="x" data-close="1">✕</button></div>' +
      '<div class="sheet-body">' + bodyHTML + '</div>' +
      '</div>';
    overlay.classList.add('show');
    overlay.onclick = function (e) { if (e.target === overlay || e.target.getAttribute('data-close')) closeModal(); };
    var form = $('#modal form');
    if (form) {
      form.onsubmit = function (e) {
        e.preventDefault();
        var ok = onSubmit(form);
        if (ok !== false) closeModal();
      };
    }
  }
  function closeModal() { var o = $('#modal'); o.classList.remove('show'); o.innerHTML = ''; o.onclick = null; }

  function field(label, html) {
    return '<label class="f"><span>' + esc(label) + '</span>' + html + '</label>';
  }
  function opt(list, sel) {
    return list.map(function (x) { return '<option' + (x === sel ? ' selected' : '') + '>' + esc(x) + '</option>'; }).join('');
  }
  function boxOptList(room, sel) {
    var list = state.boxes.filter(function (b) { return !room || b.room === room; });
    if (room && !list.length) list = state.boxes; // 该房间暂无盒子时回退为全部，避免下拉为空
    return '<option value="">— 不指定 —</option>' + list.map(function (b) {
      return '<option value="' + esc(b.id) + '"' + (b.id === sel ? ' selected' : '') + '>' + esc(b.name) + '（' + esc(b.room) + '）</option>';
    }).join('');
  }
  function roomSelect(sel) { return '<select name="room">' + opt(ROOMS, sel) + '</select>'; }

  /* ---------- 数据加载 ---------- */
  function loadAll() {
    return Promise.all([
      CloudDB.getAll('food'), CloudDB.getAll('boxes'), CloudDB.getAll('items'),
      CloudDB.getAll('chores'), CloudDB.getAll('dailies'), CloudDB.getAll('bills'),
      CloudDB.getMeta('remindDays', 7),
      CloudDB.getMeta('shareRoomId', ''), CloudDB.getMeta('shareAutoPublish', false),
      CloudDB.getMeta('autoBackup', false), CloudDB.getMeta('autoBackupDays', 0),
      CloudDB.getMeta('autoBackupMin', 0) // 旧版「分钟」设置，仅用于迁移
    ]).then(function (r) {
      state.food = r[0]; state.boxes = r[1]; state.items = r[2];
      state.chores = r[3]; state.dailies = r[4]; state.bills = r[5];
      state.remindDays = +r[6] || 7;
      state.shareRoomId = r[7] || ''; state.shareAuto = !!r[8];
      state.autoBackup = !!r[9];
      // 备份间隔统一以「天」为单位；兼容旧版分钟设置（15 分钟 ≈ 1 天）
      var days = +r[10] || 0;
      if (!days) { var oldMin = +r[11] || 0; days = oldMin ? Math.max(1, Math.round(oldMin / 1440)) : 1; }
      state.autoBackupDays = Math.min(365, Math.max(1, days));
    });
  }

  /* ---------- 提醒检测（过期/临期） ---------- */
  function expiringFood() {
    return state.food.filter(function (f) {
      var d = daysBetween(today(), f.expiryDate || '9999-12-31');
      return d <= (f.remindDays != null ? f.remindDays : state.remindDays);
    }).sort(function (a, b) { return (a.expiryDate || '').localeCompare(b.expiryDate || ''); });
  }
  function foodStatus(f) {
    var d = daysBetween(today(), f.expiryDate || '9999-12-31');
    if (d < 0) return { cls: 'exp', txt: '已过期 ' + Math.abs(d) + ' 天' };
    if (d <= (f.remindDays != null ? f.remindDays : state.remindDays)) return { cls: 'warn', txt: '还剩 ' + d + ' 天' };
    return { cls: 'ok', txt: '还剩 ' + d + ' 天' };
  }
  function checkReminders() {
    var list = expiringFood();
    try { if (navigator.setAppBadge) navigator.setAppBadge(list.length); } catch (e) {}
    if (list.length && 'Notification' in window && Notification.permission === 'granted') {
      if (state._notifiedToday !== today()) {
        var names = list.slice(0, 3).map(function (f) { return f.name; }).join('、');
        try { new Notification('多多管家 · 食品提醒', { body: '有 ' + list.length + ' 件食品临期/过期：' + names + (list.length > 3 ? ' 等' : '') }); } catch (e) {}
        state._notifiedToday = today();
      }
    }
    return list;
  }

  /* ---------- 视图：食品保质期 ---------- */
  function viewFood() {
    var exp = expiringFood();
    var banner = exp.length ? '<div class="banner">⏰ 有 <b>' + exp.length + '</b> 件食品临期或已过期，请及时查看</div>' : '';
    var rows = state.food.slice().sort(function (a, b) { return (a.expiryDate || '').localeCompare(b.expiryDate || ''); });
    var list = rows.length ? rows.map(function (f) {
      var st = foodStatus(f);
      var box = f.boxId ? (state.boxes.find(function (b) { return b.id === f.boxId; }) || {}) : null;
      return '<div class="card">' +
        '<div class="card-main">' +
        '<div class="card-title">' + esc(f.name) + ' <span class="tag">' + esc(f.category || '食品') + '</span></div>' +
        '<div class="card-sub">' + esc(f.room || '') + (box ? ' · ' + esc(box.name) : '') + '　' + esc(f.quantity || '') + esc(f.unit || '') + '</div>' +
        '<div class="card-sub">保质期至 ' + esc(f.expiryDate || '—') + '</div>' +
        '</div>' +
        '<div class="card-side">' +
        '<span class="badge ' + st.cls + '">' + st.txt + '</span>' +
        '<div class="row-act"><button data-act="editFood" data-id="' + f.id + '">编辑</button><button data-act="delFood" data-id="' + f.id + '">删除</button></div>' +
        '</div></div>';
    }).join('') : '<div class="empty">还没有食品记录，点右上角“添加”开始管理保质期～</div>';
    return '<div class="head"><h1>食品保质期</h1><div class="head-act">' +
      '<button class="add" data-act="addFood">＋ 添加</button>' +
      '<button class="add ghost" data-act="scanReceipt">🧾 拍小票</button></div></div>' +
      banner + '<div class="list">' + list + '</div>';
  }

  function foodForm(prefill, editObj) {
    var f = editObj || {};
    var p = prefill || {};
    return '<form>' +
      field('名称', '<input name="name" required value="' + esc(p.name || f.name || '') + '" placeholder="如：牛奶">') +
      field('类别', '<input name="category" value="' + esc(p.category || f.category || '食品') + '" list="catlist"><datalist id="catlist">' + opt(['食品', '生鲜', '零食', '饮料', '调料', '速冻'], '') + '</datalist>') +
      field('房间', roomSelect(p.room || f.room || '厨房')) +
      field('收纳于', '<select name="boxId">' + boxOptList(p.room || f.room, p.boxId || f.boxId) + '</select>') +
      '<div class="grid2">' +
      field('数量', '<input name="quantity" value="' + esc(f.quantity || '') + '" placeholder="选填">') +
      field('单位', '<input name="unit" value="' + esc(f.unit || '') + '" placeholder="如：盒/袋">') +
      '</div>' +
      '<div class="grid2">' +
      field('购入日期', '<input type="date" name="purchaseDate" value="' + esc(f.purchaseDate || today()) + '">') +
      field('保质期至', '<input type="date" name="expiryDate" required value="' + esc(f.expiryDate || '') + '">') +
      '</div>' +
      field('提前提醒(天)', '<input type="number" name="remindDays" min="0" value="' + esc(f.remindDays != null ? f.remindDays : state.remindDays) + '">') +
      field('备注', '<input name="note" value="' + esc(f.note || '') + '">') +
      '<button class="primary" type="submit">' + (editObj ? '保存修改' : '保存') + '</button>' +
      '</form>';
  }
  function openFoodModal(prefill, editObj, msg) {
    openModal(editObj ? '编辑食品' : '添加食品', foodForm(prefill, editObj), function (form) {
      var v = formVals(form);
      if (!v.name || !v.expiryDate) { toast('请填写名称和保质期'); return false; }
      var obj = Object.assign({}, editObj, {
        name: v.name, category: v.category || '食品', room: v.room, boxId: v.boxId || '',
        quantity: v.quantity, unit: v.unit, purchaseDate: v.purchaseDate, expiryDate: v.expiryDate,
        remindDays: v.remindDays !== '' ? +v.remindDays : state.remindDays, note: v.note
      });
      if (!editObj) obj.id = CloudDB.id();
      obj.createdAt = editObj ? editObj.createdAt : Date.now();
      obj.updatedAt = Date.now();
      return CloudDB.put('food', obj).then(function () { return afterSave(msg); });
    });
  }

  /* ---------- 视图：收纳（盒 + 物项） ---------- */
  var storageSub = 'boxes';
  function viewStorage() {
    var tabs = '<div class="subtabs">' +
      '<button data-sub="boxes" class="' + (storageSub === 'boxes' ? 'on' : '') + '">收纳盒/箱 (' + state.boxes.length + ')</button>' +
      '<button data-sub="items" class="' + (storageSub === 'items' ? 'on' : '') + '">物项 (' + state.items.length + ')</button>' +
      '</div>';
    var body = storageSub === 'boxes' ? storageBoxes() : storageItems();
    return '<div class="head"><h1>收纳管理</h1><button class="add" data-act="add' + (storageSub === 'boxes' ? 'Box' : 'Item') + '">＋ 添加</button></div>' + tabs + body;
  }
  function storageBoxes() {
    if (!state.boxes.length) return '<div class="empty">还没有收纳盒。可提前把家里的箱子/收纳盒录入数据库，方便物项归类。</div>';
    return '<div class="list">' + state.boxes.map(function (b) {
      var cnt = state.items.filter(function (i) { return i.boxId === b.id; }).length;
      return '<div class="card"><div class="card-main">' +
        '<div class="card-title">' + esc(b.name) + ' <span class="tag">' + esc(b.type || '收纳盒') + '</span></div>' +
        '<div class="card-sub">' + esc(b.room || '') + '　内含物项 ' + cnt + ' 件</div>' +
        (b.note ? '<div class="card-sub">' + esc(b.note) + '</div>' : '') +
        '</div><div class="row-act"><button data-act="editBox" data-id="' + b.id + '">编辑</button><button data-act="delBox" data-id="' + b.id + '">删除</button></div></div>';
    }).join('') + '</div>';
  }
  function storageItems() {
    if (!state.items.length) return '<div class="empty">还没有物项记录，点右上角“添加”并按房间归入收纳盒。</div>';
    var rows = state.items.slice().sort(function (a, b) { return (a.room || '').localeCompare(b.room || ''); });
    return '<div class="list">' + rows.map(function (it) {
      var box = it.boxId ? (state.boxes.find(function (b) { return b.id === it.boxId; }) || {}) : null;
      return '<div class="card"><div class="card-main">' +
        '<div class="card-title">' + esc(it.name) + ' <span class="tag">' + esc(it.category || '杂物') + '</span></div>' +
        '<div class="card-sub">' + esc(it.room || '') + (box ? ' · ' + esc(box.name) : '') + '　' + esc(it.quantity || '') + '</div>' +
        (it.note ? '<div class="card-sub">' + esc(it.note) + '</div>' : '') +
        '</div><div class="row-act"><button data-act="editItem" data-id="' + it.id + '">编辑</button><button data-act="delItem" data-id="' + it.id + '">删除</button></div></div>';
    }).join('') + '</div>';
  }
  function boxForm(editObj, prefill) {
    var b = editObj || {}; var p = prefill || {};
    return '<form>' +
      field('名称', '<input name="name" required value="' + esc(p.name || b.name || '') + '" placeholder="如：卧室衣柜上层盒">') +
      field('类型', '<select name="type">' + opt(BOX_TYPES, b.type || '收纳盒') + '</select>') +
      field('房间', roomSelect(p.room || b.room || '卧室')) +
      field('备注', '<input name="note" value="' + esc(b.note || '') + '">') +
      '<button class="primary" type="submit">' + (editObj ? '保存修改' : '保存') + '</button></form>';
  }
  function openBoxModal(editObj) {
    openModal(editObj ? '编辑收纳盒' : '添加收纳盒', boxForm(editObj), function (form) {
      var v = formVals(form);
      if (!v.name) { toast('请填写名称'); return false; }
      var obj = Object.assign({}, editObj, { name: v.name, type: v.type, room: v.room, note: v.note });
      if (!editObj) obj.id = CloudDB.id();
      obj.createdAt = editObj ? editObj.createdAt : Date.now();
      obj.updatedAt = Date.now();
      return CloudDB.put('boxes', obj).then(function () { return afterSave('已保存'); });
    });
  }
  function itemForm(prefill, editObj) {
    var it = editObj || {}; var p = prefill || {};
    return '<form>' +
      field('名称', '<input name="name" required value="' + esc(p.name || it.name || '') + '" placeholder="如：螺丝刀">') +
      field('类别', '<input name="category" value="' + esc(p.category || it.category || '杂物') + '" list="catlist2"><datalist id="catlist2">' + opt(['工具', '文具', '数码', '衣物', '洗护', '药品', '玩具', '杂物'], '') + '</datalist>') +
      field('房间', roomSelect(p.room || it.room || '储物间')) +
      field('收纳于', '<select name="boxId">' + boxOptList(p.room || it.room, p.boxId || it.boxId) + '</select>') +
      field('数量', '<input name="quantity" value="' + esc(it.quantity || '') + '" placeholder="选填">') +
      field('备注', '<input name="note" value="' + esc(it.note || '') + '">') +
      '<button class="primary" type="submit">' + (editObj ? '保存修改' : '保存') + '</button></form>';
  }
  function openItemModal(prefill, editObj, msg) {
    openModal(editObj ? '编辑物项' : '添加物项', itemForm(prefill, editObj), function (form) {
      var v = formVals(form);
      if (!v.name) { toast('请填写名称'); return false; }
      var obj = Object.assign({}, editObj, { name: v.name, category: v.category || '杂物', room: v.room, boxId: v.boxId || '', quantity: v.quantity, note: v.note });
      if (!editObj) obj.id = CloudDB.id();
      obj.createdAt = editObj ? editObj.createdAt : Date.now();
      obj.updatedAt = Date.now();
      return CloudDB.put('items', obj).then(function () { return afterSave(msg); });
    });
  }

  /* ---------- 视图：语音智能分类 ---------- */
  var voiceHandle = null, lastVoice = '', lastParse = null, voiceBoxSel = '';
  var voiceMode = '', voiceModeFixed = false;           // 空=自动；点击模式按钮后固定
  var autoBoxPrompted = false;                          // 同一句话只自动提示一次新建收纳位置
  var MODES = [['items', '增加物项收纳位置'], ['food', '添加食品保质期']];
  function viewVoice() {
    var sup = HSpeech.supported();
    var mic = sup
      ? '<button class="mic" id="micBtn"><span class="mic-ic">🎤</span><span id="micTxt">点击说话</span></button>'
      : '<div class="banner">当前浏览器不支持语音识别，可用下方文字输入。</div>';
    var modes = '<div class="modes">' + MODES.map(function (m) {
      return '<button data-act="voiceMode" data-mode="' + m[0] + '" class="' + (voiceMode === m[0] ? 'on' : '') + '">' +
        (m[0] === 'items' ? '📦 ' : '🥛 ') + m[1] + '</button>';
    }).join('') + '</div>';
    return '<div class="head"><h1>语音智能分类</h1></div>' +
      '<div class="voice">' + mic +
      '<p class="hint">点麦克风说话，<b>说完再点一下结束</b>。如“螺丝刀放储物间”“一盒牛奶还有三天过期”，自动识别物项、放置位置与保质期。</p>' +
      modes +
      '<div id="voiceResult"></div>' +
      '<div class="divider">或手动输入</div>' +
      '<form id="textForm" class="inline"><input name="t" placeholder="如：苹果 还有一周过期"><button type="submit">分类</button></form>' +
      '</div>';
  }
  // 保质期快捷天数 → 中文标签
  var EXP_QUICK = [[3, '+3天'], [7, '+1周'], [15, '+半月'], [30, '+1个月'], [90, '+3个月'], [180, '+半年'], [365, '+1年']];
  function addDays(n) {
    var d = new Date(); d.setDate(d.getDate() + n);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  // keepBox=true 表示重绘（保存后回到本页），保留用户刚选/刚建的收纳位置
  function showVoiceResult(text, keepBox) {
    if (!keepBox) { voiceBoxSel = ''; autoBoxPrompted = false; }
    lastVoice = text;
    // 综合解析：物项名称 + 类别 + 放置房间 + 关联的收纳盒（来自“收纳”模块）
    var p = HClassify.parse(text, state.boxes);
    lastParse = p;
    // 未手动选模式时，按识别结果自动判定归入食品还是物项
    if (!voiceModeFixed) voiceMode = p.target;
    if (voiceMode !== 'items' && voiceMode !== 'food') voiceMode = p.target;
    var mode = voiceMode;
    var target = mode === 'food' ? '食品保质期' : '收纳物项';
    var selId = voiceBoxSel || p.boxId;

    // 收纳于：与「收纳」模块同一份盒子数据，并可直接新建
    var boxRow = state.boxes.length
      ? '<div class="vrow"><span>收纳于</span><select id="voiceBox">' + boxOptList(p.room, selId) +
        '<option value="__new__">＋ 新建收纳位置…</option></select></div>'
      : '<div class="vrow"><span>收纳于</span><button class="mini" data-act="newBoxFromVoice">＋ 新建收纳位置</button></div>';

    // 食品模式：保质期（语音里说到就自动带入）+ 快捷按钮，填了即可一键存入
    var expRow = '';
    if (mode === 'food') {
      expRow = '<div class="vrow"><span>保质期至</span><input type="date" id="voiceExp" value="' + esc(p.expiry || '') + '"></div>' +
        '<div class="chips">' + EXP_QUICK.map(function (q) {
          return '<button data-act="expQuick" data-d="' + q[0] + '">' + q[1] + '</button>';
        }).join('') + '</div>' +
        (p.expiry ? '<div class="card-sub">已从语音识别到保质期：<b>' + esc(p.expiry) + '</b></div>' : '');
    }

    // 按所选模式联动对应模块：物项→收纳，食品→食品保质期
    var actBtn = mode === 'food'
      ? '<button data-act="voiceSaveFood">存入「食品保质期」</button>'
      : '<button data-act="voiceSaveItem">存入「收纳物项」</button>';

    $('#voiceResult').innerHTML =
      '<div class="card"><div class="card-main">' +
      '<div class="card-title">“' + esc(text) + '”</div>' +
      '<div class="card-sub">识别物项：<b>' + esc(p.name) + '</b></div>' +
      '<div class="card-sub">识别类别：<b>' + esc(p.cat) + '</b>　放置位置：<b>' + esc(p.room) + '</b></div>' +
      '<div class="card-sub">将存入：<b>' + target + '</b></div>' +
      boxRow + expRow +
      '</div><div class="row-act">' + actBtn + '</div></div>';

    // 物项模式下，若语音说了一个库里没有的收纳位置 → 自动弹出新建弹窗
    if (mode === 'items' && !autoBoxPrompted) {
      var unknown = HClassify.unknownLocation(text, state.boxes);
      if (unknown) {
        autoBoxPrompted = true;
        openNewBoxModal(p.room, unknown);
      }
    }
  }

  // 读取语音结果里选中的收纳盒（用户可临时改）
  function pickedVoiceBox() {
    var sel = document.getElementById('voiceBox');
    if (!sel) return (lastParse && lastParse.boxId) || '';
    var v = sel.value;
    return (v && v !== '__new__') ? v : '';
  }

  // 直接从语音页新建一个收纳位置（盒子/箱），建完自动选中它
  // defaultName：语音里提到但库里没有的位置名，会自动带入
  function openNewBoxModal(defaultRoom, defaultName) {
    var hint = defaultName
      ? '<p class="hint">语音里说的“' + esc(defaultName) + '”还没录入过，确认后就会新增为收纳位置并自动选中。</p>'
      : '';
    openModal(defaultName ? '发现新的收纳位置' : '新建收纳位置',
      hint + boxForm(null, { room: defaultRoom || '储物间', name: defaultName || '' }), function (form) {
      var v = formVals(form);
      if (!v.name) { toast('请填写名称'); return false; }
      var obj = { id: CloudDB.id(), name: v.name, type: v.type, room: v.room, note: v.note, createdAt: Date.now() };
      return CloudDB.put('boxes', obj).then(function () {
        voiceBoxSel = obj.id;                 // 回到语音页时默认选中新建的这个
        return afterSave('已新增收纳位置：' + v.name + '（' + v.room + '）');
      });
    });
  }

  /* ---------- 视图：家务列表 ---------- */
  function viewChores() {
    var prioRank = { '高': 0, '中': 1, '低': 2 };
    var rows = state.chores.slice().sort(function (a, b) {
      if (!!a.done !== !!b.done) return a.done ? 1 : -1;
      if ((a.done ? 0 : 1) && (b.done ? 0 : 1)) {
        var pa = prioRank[a.priority] != null ? prioRank[a.priority] : 9, pb = prioRank[b.priority] != null ? prioRank[b.priority] : 9;
        if (pa !== pb) return pa - pb;
      }
      return (b.createdAt || 0) - (a.createdAt || 0);
    });
    var list = rows.length ? rows.map(function (c) {
      var due = c.dueDate ? ('　截止 ' + esc(c.dueDate)) : '';
      return '<div class="card chore ' + (c.done ? 'done' : '') + '">' +
        '<label class="chk"><input type="checkbox" data-act="toggleChore" data-id="' + c.id + '"' + (c.done ? ' checked' : '') + '><span></span></label>' +
        '<div class="card-main"><div class="card-title">' + esc(c.title) + (c.priority ? ' <span class="tag prio-' + esc(c.priority) + '">' + esc(c.priority) + '</span>' : '') + '</div>' +
        '<div class="card-sub">' + esc(c.room || '') + due + (c.done && c.doneAt ? '　✓ ' + esc(c.doneAt) : '') + '</div></div>' +
        '<button class="row-act-b" data-act="delChore" data-id="' + c.id + '">删除</button></div>';
    }).join('') : '<div class="empty">家务列表是空的，添加今天要做的家务吧。</div>';
    return '<div class="head"><h1>家务列表</h1><button class="add" data-act="addChore">＋ 添加</button></div><div class="list">' + list + '</div>';
  }
  function choreForm(editObj) {
    var c = editObj || {};
    return '<form>' +
      field('标题', '<input name="title" required value="' + esc(c.title || '') + '" placeholder="如：拖地">') +
      field('房间', roomSelect(c.room || '客厅')) +
      field('优先级', '<select name="priority">' + opt(PRIOS, c.priority || '中') + '</select>') +
      field('截止日期', '<input type="date" name="dueDate" value="' + esc(c.dueDate || '') + '">') +
      '<button class="primary" type="submit">保存</button></form>';
  }
  function openChoreModal(editObj) {
    openModal(editObj ? '编辑家务' : '添加家务', choreForm(editObj), function (form) {
      var v = formVals(form);
      if (!v.title) { toast('请填写标题'); return false; }
      var obj = editObj ? Object.assign({}, editObj, { title: v.title, room: v.room, priority: v.priority, dueDate: v.dueDate || '' })
                        : { id: CloudDB.id(), title: v.title, room: v.room, priority: v.priority, dueDate: v.dueDate || '', done: false, doneAt: '', createdAt: Date.now() };
      obj.updatedAt = Date.now();
      return CloudDB.put('chores', obj).then(function () { return afterSave('已保存'); });
    });
  }

  /* ---------- 视图：每日必做 ---------- */
  function viewDailies() {
    var t = today();
    var doneCnt = state.dailies.filter(function (d) { return d.lastDoneDate === t; }).length;
    var list = state.dailies.length ? state.dailies.map(function (d) {
      var done = d.lastDoneDate === t;
      return '<div class="card daily ' + (done ? 'done' : '') + '">' +
        '<div class="card-main"><div class="card-title">' + esc(d.title) + '</div>' +
        (d.note ? '<div class="card-sub">' + esc(d.note) + '</div>' : '') + '</div>' +
        '<button class="' + (done ? 'row-act-b undo' : 'row-act-b') + '" data-act="toggleDaily" data-id="' + d.id + '">' + (done ? '已完成·撤销' : '完成今日') + '</button>' +
        '<button class="row-act-b del" data-act="delDaily" data-id="' + d.id + '">删除</button></div>';
    }).join('') : '<div class="empty">还没有每日必做项，添加后每天都可打卡。</div>';
    return '<div class="head"><h1>每日必做</h1><button class="add" data-act="addDaily">＋ 添加</button></div>' +
      '<div class="banner ok">今日已完成 ' + doneCnt + ' / ' + state.dailies.length + ' 项</div>' +
      '<div class="list">' + list + '</div>';
  }
  function openDailyModal(editObj) {
    var d = editObj || {};
    openModal(editObj ? '编辑每日必做' : '添加每日必做', '<form>' +
      field('标题', '<input name="title" required value="' + esc(d.title || '') + '" placeholder="如：倒垃圾">') +
      field('备注', '<input name="note" value="' + esc(d.note || '') + '" placeholder="选填">') +
      '<button class="primary" type="submit">保存</button></form>', function (form) {
      var v = formVals(form);
      if (!v.title) { toast('请填写标题'); return false; }
      var obj = editObj ? Object.assign({}, editObj, { title: v.title, note: v.note }) : { id: CloudDB.id(), title: v.title, note: v.note, createdAt: Date.now(), lastDoneDate: '' };
      obj.updatedAt = Date.now();
      return CloudDB.put('dailies', obj).then(function () { return afterSave('已保存'); });
    });
  }

  /* ---------- 视图：记账（家庭账本） ---------- */
  // 主流记账分类（支出 / 收入分开，符合日常记账习惯）
  var BILL_EXPENSE_CATS = ['餐饮', '买菜', '交通', '购物', '居住', '通讯', '水电燃气', '娱乐', '医疗', '教育', '人情', '宠物', '旅行', '其他支出'];
  var BILL_INCOME_CATS = ['工资', '奖金', '理财', '兼职', '红包', '退款', '其他收入'];
  var BILL_CAT_ICON = {
    '餐饮': '🍜', '买菜': '🥬', '交通': '🚌', '购物': '🛍️', '居住': '🏠', '通讯': '📱', '水电燃气': '💡',
    '娱乐': '🎮', '医疗': '💊', '教育': '📚', '人情': '🧧', '宠物': '🐾', '旅行': '✈️', '其他支出': '💸',
    '工资': '💰', '奖金': '🎁', '理财': '📈', '兼职': '💼', '红包': '🧧', '退款': '↩️', '其他收入': '💵'
  };
  function num(x) { var n = parseFloat(x); return isNaN(n) ? 0 : n; }
  function fmt(x) {
    var n = num(x); var s = (Math.round(n * 100) / 100).toFixed(2);
    var p = s.split('.'); p[0] = p[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return p.join('.');
  }
  function prevDay() { var d = new Date(); d.setDate(d.getDate() - 1); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }

  function viewBill() {
    var bills = state.bills.slice().sort(function (a, b) {
      if ((b.date || '') !== (a.date || '')) return (b.date || '').localeCompare(a.date || '');
      return (b.createdAt || 0) - (a.createdAt || 0);
    });
    var ym = today().slice(0, 7);
    var inc = 0, exp = 0;
    bills.forEach(function (b) {
      var amt = num(b.amount);
      if ((b.date || '').slice(0, 7) === ym) { if (b.type === 'income') inc += amt; else exp += amt; }
    });
    var summary = '<div class="bill-summary">' +
      '<div class="bs-item"><span class="bs-label">本月收入</span><span class="bs-val inc">+¥' + fmt(inc) + '</span></div>' +
      '<div class="bs-item"><span class="bs-label">本月支出</span><span class="bs-val exp">-¥' + fmt(exp) + '</span></div>' +
      '<div class="bs-item"><span class="bs-label">结余</span><span class="bs-val">¥' + fmt(inc - exp) + '</span></div>' +
      '</div>';

    // 按日期分组
    var groups = [], map = {};
    bills.forEach(function (b) {
      var d = b.date || '未知日期';
      if (!map[d]) { map[d] = []; groups.push(d); }
      map[d].push(b);
    });
    var list = groups.length ? groups.map(function (d) {
      var rows = map[d], dayExp = 0, dayInc = 0;
      var items = rows.map(function (b) {
        var amt = num(b.amount); if (b.type === 'income') dayInc += amt; else dayExp += amt;
        var icon = BILL_CAT_ICON[b.category] || (b.type === 'income' ? '💵' : '💸');
        var amountCls = b.type === 'income' ? 'inc' : 'exp';
        var amountTxt = (b.type === 'income' ? '+' : '-') + '¥' + fmt(amt);
        return '<div class="card bill-row">' +
          '<div class="card-main">' +
          '<div class="card-title">' + icon + ' ' + esc(b.category || (b.type === 'income' ? '其他收入' : '其他支出')) +
          (b.note ? ' <span class="tag">' + esc(b.note) + '</span>' : '') + '</div>' +
          '</div>' +
          '<div class="card-side">' +
          '<span class="bill-amt ' + amountCls + '">' + amountTxt + '</span>' +
          '<div class="row-act"><button data-act="editBill" data-id="' + b.id + '">编辑</button>' +
          '<button data-act="delBill" data-id="' + b.id + '">删除</button></div>' +
          '</div></div>';
      }).join('');
      var dLabel = d === today() ? '今天' : (d === prevDay() ? '昨天' : d);
      var daySum = (dayInc ? '收 ¥' + fmt(dayInc) + ' ' : '') + (dayExp ? '支 ¥' + fmt(dayExp) : '');
      return '<div class="day-group"><div class="day-head"><span>' + esc(dLabel) + '</span><span class="day-sum">' + daySum + '</span></div>' + items + '</div>';
    }).join('') : '<div class="empty">还没有记账，点右下角“＋”开始，或点🎤语音记账～</div>';

    return '<div class="head"><h1>记账</h1><div class="head-act">' +
      (HSpeech.supported() ? '<button class="add" id="billMic">🎤 语音记账</button>' : '') +
      '<button class="add" data-act="addBill">＋ 记一笔</button></div></div>' +
      summary + '<div class="list">' + list + '</div>';
  }

  function billForm(editObj) {
    var b = editObj || {};
    var type = b.type || 'expense';
    var catOpts = (type === 'income' ? BILL_INCOME_CATS : BILL_EXPENSE_CATS).map(function (c) {
      return '<option' + (c === (b.category || (type === 'income' ? '其他收入' : '其他支出')) ? ' selected' : '') + '>' + c + '</option>';
    }).join('');
    return '<form>' +
      '<div class="seg">' +
      '<label class="seg-item' + (type === 'expense' ? ' on' : '') + '"><input type="radio" name="type" value="expense"' + (type === 'expense' ? ' checked' : '') + '>支出</label>' +
      '<label class="seg-item' + (type === 'income' ? ' on' : '') + '"><input type="radio" name="type" value="income"' + (type === 'income' ? ' checked' : '') + '>收入</label>' +
      '</div>' +
      field('金额（元）', '<input name="amount" type="number" step="0.01" min="0" required value="' + esc(b.amount != null ? b.amount : '') + '" placeholder="0.00">') +
      field('分类', '<select name="category">' + catOpts + '</select>') +
      field('日期', '<input type="date" name="date" value="' + esc(b.date || today()) + '">') +
      field('备注', '<input name="note" value="' + esc(b.note || '') + '" placeholder="选填，如：和老婆吃饭">') +
      '<button class="primary" type="submit">' + (editObj ? '保存修改' : '保存') + '</button></form>';
  }
  function openBillModal(editObj) {
    openModal(editObj ? '编辑账单' : '记一笔', billForm(editObj), function (form) {
      var v = formVals(form);
      var amt = parseFloat(v.amount);
      if (isNaN(amt) || amt <= 0) { toast('请输入有效金额'); return false; }
      var obj = editObj ? Object.assign({}, editObj, {
        type: v.type, amount: amt, category: v.category, date: v.date || today(), note: v.note || '', updatedAt: Date.now()
      }) : {
        id: CloudDB.id(), type: v.type, amount: amt, category: v.category,
        date: v.date || today(), note: v.note || '', createdAt: Date.now(), updatedAt: Date.now()
      };
      return CloudDB.put('bills', obj).then(function () { return afterSave('已保存'); });
    });
    // 切换「支出/收入」时刷新分类下拉选项
    var f = $('#modal form');
    if (f) f.addEventListener('change', function (e) {
      if (e.target && e.target.name === 'type') {
        var cats = f.type.value === 'income' ? BILL_INCOME_CATS : BILL_EXPENSE_CATS;
        var sel = f.category;
        if (sel) {
          var cur = sel.value;
          sel.innerHTML = cats.map(function (c) { return '<option' + (c === cur ? ' selected' : '') + '>' + c + '</option>'; }).join('');
        }
      }
    });
  }

  // 中文数字兜底（语音偶尔返回「一千」「五十」而不是阿拉伯数字）
  function cnNum(s) {
    var map = { '零': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
    var unit = { '十': 10, '百': 100, '千': 1000, '万': 10000 };
    if (!/[零一二两三四五六七八九十百千万]/.test(s)) return 0;
    var total = 0, num = 0;
    for (var k = 0; k < s.length; k++) {
      var ch = s[k];
      if (map[ch] !== undefined) num = map[ch];
      else if (unit[ch]) { if (num === 0) num = 1; total += num * unit[ch]; num = 0; }
    }
    return total + num;
  }
  // 语音记账：把自然语言解析为 {type, amount, category}
  function parseVoiceBill(text) {
    var t = (text || '').replace(/\s+/g, '');
    var incomeKw = ['收入', '工资', '薪水', '月薪', '奖金', '年终', '理财', '利息', '基金', '分红', '兼职', '副业', '外快', '退款', '报销', '提成', '收到', '进账', '领红包', '转账收入'];
    var isIncome = incomeKw.some(function (k) { return t.indexOf(k) >= 0; });
    var type = isIncome ? 'income' : 'expense';
    var m = t.match(/(\d+(\.\d+)?)\s*(万|千)?/);
    var amount = 0;
    if (m) { amount = parseFloat(m[1]); if (m[3] === '万') amount *= 10000; else if (m[3] === '千') amount *= 1000; }
    if (!amount) { // 语音有时返回中文数字（一千/五十），兜底转换
      var cn = t.match(/[零一二两三四五六七八九十百千万]+/);
      if (cn) { var c = cnNum(cn[0]); if (c > 0) amount = c; }
    }
    var cat = type === 'income' ? '其他收入' : '其他支出';
    var rules = type === 'income'
      ? [['工资', '工资'], ['薪水', '工资'], ['月薪', '工资'], ['奖金', '奖金'], ['年终', '奖金'], ['理财', '理财'], ['利息', '理财'], ['基金', '理财'], ['分红', '理财'], ['兼职', '兼职'], ['副业', '兼职'], ['外快', '兼职'], ['退款', '退款'], ['报销', '退款'], ['红包', '红包'], ['转账', '红包']]
      : [['吃', '餐饮'], ['饭', '餐饮'], ['餐', '餐饮'], ['外卖', '餐饮'], ['奶茶', '餐饮'], ['咖啡', '餐饮'], ['饮料', '餐饮'], ['早饭', '餐饮'], ['午饭', '餐饮'], ['晚饭', '餐饮'], ['夜宵', '餐饮'], ['菜', '买菜'], ['水果', '买菜'], ['打车', '交通'], ['车', '交通'], ['地铁', '交通'], ['公交', '交通'], ['加油', '交通'], ['停车', '交通'], ['高铁', '交通'], ['火车', '交通'], ['飞机', '交通'], ['买', '购物'], ['购', '购物'], ['淘宝', '购物'], ['京东', '购物'], ['超市', '购物'], ['衣服', '购物'], ['鞋', '购物'], ['房租', '居住'], ['物业', '居住'], ['房贷', '居住'], ['话费', '通讯'], ['电话', '通讯'], ['流量', '通讯'], ['宽带', '通讯'], ['水', '水电燃气'], ['电', '水电燃气'], ['燃气', '水电燃气'], ['电影', '娱乐'], ['游戏', '娱乐'], ['娱乐', '娱乐'], ['ktv', '娱乐'], ['药', '医疗'], ['医', '医疗'], ['医院', '医疗'], ['体检', '医疗'], ['书', '教育'], ['课', '教育'], ['学费', '教育'], ['培训', '教育'], ['学习', '教育'], ['红包', '人情'], ['礼金', '人情'], ['随礼', '人情'], ['宠物', '宠物'], ['猫', '宠物'], ['狗', '宠物'], ['旅游', '旅行'], ['旅行', '旅行'], ['酒店', '旅行'], ['景点', '旅行']];
    for (var i = 0; i < rules.length; i++) { if (t.indexOf(rules[i][0]) >= 0) { cat = rules[i][1]; break; } }
    if (t.indexOf('红包') >= 0 && (t.indexOf('发') >= 0 || t.indexOf('给') >= 0 || t.indexOf('送') >= 0) && !isIncome) cat = '人情';
    return { type: type, amount: amount, category: cat };
  }
  var billVoiceHandle = null;
  function setBillMic(on) {
    var b = $('#billMic');
    if (b) { b.textContent = on ? '⏹ 完成' : '🎤 语音记账'; b.classList.toggle('on', on); }
  }
  function bindBillVoice() {
    var mic = $('#billMic');
    if (!mic) return;
    mic.onclick = function () {
      if (billVoiceHandle) { billVoiceHandle.stop(); billVoiceHandle = null; setBillMic(false); return; }
      if (!HSpeech.supported()) { toast('当前浏览器不支持语音'); return; }
      setBillMic(true);
      billVoiceHandle = HSpeech.start(function (txt) {
        billVoiceHandle = null; setBillMic(false);
        if (!txt) { toast('没听清，请再说一次'); return; }
        var p = parseVoiceBill(txt);
        if (!p.amount || p.amount <= 0) { toast('没识别到金额：' + txt); return; }
        var obj = { id: CloudDB.id(), type: p.type, amount: p.amount, category: p.category, date: today(), note: '', createdAt: Date.now(), updatedAt: Date.now() };
        CloudDB.put('bills', obj).then(function () {
          return afterSave('已记账：' + (p.type === 'income' ? '收入' : '支出') + ' ¥' + fmt(p.amount) + '（' + p.category + '）');
        });
      }, function (err) {
        billVoiceHandle = null; setBillMic(false);
        toast('语音识别失败：' + (err && err.error || '未知'));
      });
    };
  }

  /* ---------- 视图：我的 ---------- */
  function viewMe() {
    var notif = ('Notification' in window) ? (Notification.permission === 'granted' ? '已开启' : '<button class="mini" data-act="enableNotif">开启通知</button>') : '当前浏览器不支持';
    return '<div class="head"><h1>我的</h1></div>' +
      '<div class="list">' +
      '<div class="card static"><div class="card-main"><div class="card-title">应用版本</div><div class="card-sub">多多管家 v' + APP_VERSION + '（PWA）</div></div></div>' +
      '<div class="card static"><div class="card-main"><div class="card-title">👪 家庭实时同步</div><div class="card-sub">已开启 · 每 8 秒自动同步（你和家人打开同一公网链接即可互看实时数据）</div></div><button class="row-act-b" data-act="syncNow">立即同步</button></div>' +
      '<div class="card static stack"><div class="card-main"><div class="card-title">📥 自动本地备份</div><div class="card-sub">每 ' + state.autoBackupDays + ' 天自动把数据存到本机（防平台数据丢失）</div></div>' +
        '<div class="row-act">' +
        '<button class="row-act-b wide" data-act="toggleAutoBackup">' + (state.autoBackup ? '● 已开启' : '○ 未开启') + '</button>' +
        '<button class="row-act-b" data-act="setAutoBackup">间隔 ' + state.autoBackupDays + ' 天</button>' +
        '<button class="row-act-b" data-act="backupNow">立即备份</button>' +
        '<button class="row-act-b" data-act="exportLatestBackup">导出文件</button>' +
        '<button class="row-act-b" data-act="restoreBackup">恢复最近</button>' +
        '</div></div>' +
      '<div class="card static"><div class="card-main"><div class="card-title">默认提前提醒</div><div class="card-sub">食品临期提前 ' + state.remindDays + ' 天提醒</div></div><button class="row-act-b" data-act="setRemind">设置</button></div>' +
      '<div class="card static"><div class="card-main"><div class="card-title">过期提醒通知</div><div class="card-sub">' + notif + '</div></div></div>' +
      '<div class="card tap" data-act="exportData"><div class="card-main"><div class="card-title">数据备份（导出）</div><div class="card-sub">导出 JSON 文件，换手机/重装可恢复</div></div><span class="chev">›</span></div>' +
      '<div class="card tap" data-act="importData"><div class="card-main"><div class="card-title">数据恢复（导入）</div><div class="card-sub">从备份文件恢复数据</div></div><span class="chev">›</span></div>' +
      '<div class="card danger tap" data-act="clearAll"><div class="card-main"><div class="card-title">清空全部数据</div><div class="card-sub">删除本机所有记录（不可恢复）</div></div><span class="chev">›</span></div>' +
      '</div>';
  }

  /* ---------- 表单取值 ---------- */
  function formVals(form) {
    var o = {}, els = $all('[name]', form);
    els.forEach(function (e) { o[e.name] = e.type === 'checkbox' ? e.checked : e.value; });
    return o;
  }
  // 保存后停留在当前所在页面，不再跳转到别的标签页
  function afterSave(msg) {
    return loadAll().then(function () {
      render(); checkReminders();
      if (msg) toast(msg);
    }).then(function () {
      pushLocalAll();
      if (state.shareAuto && state.shareRoomId) publishRoomSilently(state.shareRoomId);
    });
  }

  /* ---------- 家庭实时同步（共享数据表，双向） ---------- */
  var SYNC_TYPES = ['food', 'boxes', 'items', 'chores', 'dailies', 'bills'];
  var SYNC_PULL_MS = 8000;
  var _syncTimer = null;
  function upsertLocal(type, it) {
    var arr = state[type] || (state[type] = []);
    var i = arr.findIndex(function (x) { return x.id === it.id; });
    if (i >= 0) arr[i] = it; else arr.push(it);
  }
  // 把本地所有数据增量推送到云端共享库（按 updatedAt last-write-wins，不会错误覆盖对方较新的内容）
  function pushLocalAll() {
    var changes = [];
    SYNC_TYPES.forEach(function (type) {
      (state[type] || []).forEach(function (it) {
        if (!it || !it.id) return;
        var u = it.updatedAt || it.createdAt || Date.now();
        changes.push({ type: type, op: 'upsert', updatedAt: u, item: Object.assign({}, it, { updatedAt: u }) });
      });
    });
    return HShare.pushChanges(changes);
  }
  // 本地删除某条后，立即把删除传播到云端
  function syncPushDelete(type, id) {
    return HShare.pushChanges([{ type: type, op: 'delete', id: id, updatedAt: Date.now() }]);
  }
  // 从云端拉取并合并到本地（更新较新项、应用删除）
  function pullAndMerge() {
    return HShare.pullShared().then(function (j) {
      if (!j || j._error) return;
      var changed = false;
      SYNC_TYPES.forEach(function (type) {
        (j.data[type] || []).forEach(function (it) {
          var local = (state[type] || []).find(function (x) { return x.id === it.id; });
          if (!local || (local.updatedAt || local.createdAt || 0) < (it.updatedAt || 0)) {
            upsertLocal(type, it); CloudDB.put(type, it); changed = true;
          }
        });
      });
      (j.deleted || []).forEach(function (d) {
        if (!d.type) return;
        var arr = state[d.type] || [];
        var local = arr.find(function (x) { return x.id === d.id; });
        if (local && (local.updatedAt || local.createdAt || 0) < d.t) {
          state[d.type] = arr.filter(function (x) { return x.id !== d.id; });
          CloudDB.del(d.type, d.id); changed = true;
        }
      });
      if (changed) { render(); checkReminders(); }
    });
  }
  // 启动：先拉云端（拿到家人已有数据），再推本地（初始化或补上自己独有数据），之后定时拉取
  function initSync() {
    pullAndMerge().then(function () { return pushLocalAll(); }).then(function () { startAutoSync(); });
  }
  function startAutoSync() {
    if (_syncTimer) return;
    _syncTimer = setInterval(function () { pullAndMerge(); }, SYNC_PULL_MS);
  }

  /* ---------- 渲染 ---------- */
  var VIEWS = { food: viewFood, storage: viewStorage, voice: viewVoice, chores: viewChores, dailies: viewDailies, bill: viewBill, me: viewMe };
  function render() {
    var v = $('#view');
    v.innerHTML = (VIEWS[state.tab] || viewFood)();
    $all('.nav button').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-tab') === state.tab); });
    if (state.tab === 'voice') {
      bindVoice();
      // 停留在语音页时，保留上一次识别结果卡片，方便连续录入
      if (lastVoice && lastParse) showVoiceResult(lastVoice, true);
    }
    if (state.tab === 'bill') bindBillVoice();
  }

  /* ---------- 语音绑定 ---------- */
  function setMicIdle() {
    var b = $('#micBtn'), t = $('#micTxt');
    if (b) b.classList.remove('on');
    if (t) t.textContent = '点击说话';
  }
  function setMicListening() {
    var b = $('#micBtn'), t = $('#micTxt');
    if (b) b.classList.add('on');
    if (t) t.textContent = '聆听中… 点击结束';
  }
  function bindVoice() {
    var mic = $('#micBtn');
    if (mic) mic.onclick = function () {
      if (voiceHandle) {                       // 再次点击 = 结束说话
        voiceHandle.stop(); voiceHandle = null;
        setMicIdle();
        return;
      }
      if (!HSpeech.supported()) { toast('当前浏览器不支持语音'); return; }
      setMicListening();
      voiceHandle = HSpeech.start(function (txt) {
        voiceHandle = null; setMicIdle();
        if (txt) showVoiceResult(txt); else toast('没听清，请再说一次');
      }, function (err) {
        voiceHandle = null; setMicIdle();
        toast('语音识别失败：' + (err && err.error || '未知'));
      }, function () { setMicListening(); },
        function () { voiceHandle = null; setMicIdle(); });   // 静音自动结束也要复位
    };
    var tf = $('#textForm');
    if (tf) tf.onsubmit = function (e) {
      e.preventDefault();
      var t = tf.t.value.trim();
      if (t) showVoiceResult(t); else toast('请输入内容');
    };
  }

  /* ---------- 事件委托 ---------- */
  function onViewClick(e) {
    var t = e.target.closest('[data-act],[data-tab],[data-sub]');
    if (!t) return;
    if (t.hasAttribute('data-tab')) { state.tab = t.getAttribute('data-tab'); render(); return; }
    if (t.hasAttribute('data-sub')) { storageSub = t.getAttribute('data-sub'); render(); return; }
    var act = t.getAttribute('data-act'); var id = t.getAttribute('data-id');
    switch (act) {
      case 'addFood': openFoodModal(null, null, '已保存'); break;
      case 'editFood': CloudDB.get('food', id).then(function (o) { openFoodModal(null, o, '已保存'); }); break;
      case 'delFood': confirmDel('food', id, '食品'); break;
      case 'addBox': openBoxModal(); break;
      case 'editBox': CloudDB.get('boxes', id).then(function (o) { openBoxModal(o); }); break;
      case 'delBox':
        // 删除盒子时解除物项关联
        CloudDB.get('boxes', id).then(function (b) {
          if (!confirm('确定删除收纳盒“' + (b ? b.name : '') + '”吗？其下属物项的“收纳于”会置空。')) return;
          Promise.all(state.items.filter(function (i) { return i.boxId === id; }).map(function (i) { i.boxId = ''; return CloudDB.put('items', i); }))
            .then(function () { return CloudDB.del('boxes', id); }).then(function () { syncPushDelete('boxes', id); afterSave(); toast('已删除'); });
        });
        break;
      case 'addItem': openItemModal(null, null, '已保存'); break;
      case 'editItem': CloudDB.get('items', id).then(function (o) { openItemModal(null, o, '已保存'); }); break;
      case 'delItem': confirmDel('items', id, '物项'); break;
      case 'voiceMode':
        voiceMode = t.getAttribute('data-mode') || '';
        voiceModeFixed = true;
        render();                       // 重绘并按新模式恢复结果卡
        break;
      case 'expQuick': {
        var dd = +(t.getAttribute('data-d') || 0);
        var expEl0 = document.getElementById('voiceExp');
        if (expEl0 && dd) expEl0.value = addDays(dd);
        break;
      }
      case 'newBoxFromVoice':
        openNewBoxModal(lastParse ? lastParse.room : '储物间');
        break;
      case 'voiceSaveFood':
        if (!lastParse) break;
        var expEl = document.getElementById('voiceExp');
        var expDate = expEl ? expEl.value : '';
        if (expDate) {
          // 已填保质期 → 直接存入食品库，不再弹窗
          var fobj = {
            id: CloudDB.id(), name: lastParse.name, category: lastParse.cat, room: lastParse.room,
            boxId: pickedVoiceBox(), quantity: '', unit: '', purchaseDate: today(),
            expiryDate: expDate, remindDays: state.remindDays, note: '', createdAt: Date.now(), updatedAt: Date.now()
          };
          CloudDB.put('food', fobj).then(function () {
            return afterSave('已添加「' + fobj.name + '」，保质期至 ' + expDate);
          });
        } else {
          openFoodModal({ name: lastParse.name, category: lastParse.cat, room: lastParse.room, boxId: pickedVoiceBox() },
            null, '已保存到「食品保质期」');
        }
        break;
      case 'voiceSaveItem':
        if (lastParse) {
          var bid = pickedVoiceBox();
          var bn = bid ? (state.boxes.find(function (b) { return b.id === bid; }) || {}).name : '';
          openItemModal({ name: lastParse.name, category: lastParse.cat, room: lastParse.room, boxId: bid }, null,
            '已保存到「收纳物项」' + (bn ? ' · ' + bn : ''));
        }
        break;
      case 'addChore': openChoreModal(); break;
      case 'delChore': confirmDel('chores', id, '家务'); break;
      case 'toggleChore':
        CloudDB.get('chores', id).then(function (c) { c.done = !c.done; c.doneAt = c.done ? today() : ''; return CloudDB.put('chores', c); }).then(function () { afterSave(); });
        break;
      case 'addDaily': openDailyModal(); break;
      case 'delDaily': confirmDel('dailies', id, '每日必做'); break;
      case 'toggleDaily':
        CloudDB.get('dailies', id).then(function (d) { d.lastDoneDate = (d.lastDoneDate === today()) ? '' : today(); return CloudDB.put('dailies', d); }).then(function () { afterSave(); });
        break;
      case 'addBill': openBillModal(null); break;
      case 'editBill': CloudDB.get('bills', id).then(function (o) { openBillModal(o); }); break;
      case 'delBill': confirmDel('bills', id, '账单'); break;
      case 'scanReceipt': scanReceipt(); break;
      case 'setRemind': openRemindModal(); break;
      case 'enableNotif':
        if ('Notification' in window) Notification.requestPermission().then(function (p) { toast('通知权限：' + p); render(); });
        break;
      case 'syncNow': pullAndMerge().then(function () { toast('已同步'); }); break;
      case 'toggleAutoBackup':
        state.autoBackup = !state.autoBackup;
        CloudDB.setMeta('autoBackup', state.autoBackup); startAutoBackup(); render();
        toast(state.autoBackup ? '已开启自动备份' : '已关闭自动备份'); break;
      case 'setAutoBackup': openAutoBackupModal(); break;
      case 'backupNow': saveLocalBackup().then(function () { toast('已备份到本机'); }); break;
      case 'exportLatestBackup': exportLatestBackup(); break;
      case 'restoreBackup': restoreBackup(); break;
      case 'shareLink': openShareModal(); break;
      case 'openSearch': openSearchModal(); break;
      case 'exportData': exportData(); break;
      case 'importData': importData(); break;
      case 'howto': showHowto(); break;
      case 'clearAll': clearAll(); break;
      case 'cloudLogin': showLoginModal(); break;
      case 'cloudLogout': doCloudLogout(); break;
    }
  }
  // 下拉切换：选中「＋ 新建收纳位置…」时直接弹出新建表单
  function onAppChange(e) {
    var el = e.target;
    if (el && el.id === 'voiceBox' && el.value === '__new__') {
      openNewBoxModal(lastParse ? lastParse.room : '储物间');
    }
  }
  function confirmDel(store, id, label) {
    if (!confirm('确定删除该' + label + '吗？')) return;
    CloudDB.del(store, id).then(function () { syncPushDelete(store, id); afterSave(); toast('已删除'); });
  }

  function openRemindModal() {
    openModal('默认提前提醒天数', '<form>' +
      field('提前提醒(天)', '<input type="number" min="0" name="d" value="' + state.remindDays + '">') +
      '<button class="primary" type="submit">保存</button></form>', function (form) {
      var d = +form.d.value; if (isNaN(d) || d < 0) d = 7;
      return CloudDB.setMeta('remindDays', d).then(function () { state.remindDays = d; render(); checkReminders(); toast('已保存'); });
    });
  }

  /* ---------- 云端登录（仅云端模式可用） ---------- */
  function showLoginModal() {
    if (CloudDB.mode() !== 'cloud') { toast('当前为本地模式，无需登录'); return; }
    var pending = null;
    openModal('登录云端账号', '<form id="loginForm">' +
      field('手机号', '<input name="phone" inputmode="numeric" maxlength="11" placeholder="11 位手机号">') +
      '<button type="button" class="mini" id="sendCode" style="margin:2px 0 10px">获取验证码</button>' +
      field('验证码', '<input name="code" inputmode="numeric" maxlength="6" placeholder="6 位验证码">') +
      '<button class="primary" type="submit">登录 / 注册</button></form>',
      function () { return false; });
    var form = $('#loginForm');
    $('#sendCode').onclick = function () {
      var phone = form.phone.value.trim();
      if (!/^1\d{10}$/.test(phone)) { toast('请输入正确的 11 位手机号'); return; }
      CloudDB.loginWithPhone(phone).then(function (ch) {
        pending = ch; pending.phone = phone; toast('验证码已发送（手机号登录）');
      }).catch(function (e) { toast('发送失败：' + (e.message || '未知错误')); });
    };
    form.onsubmit = function (e) {
      e.preventDefault();
      if (!pending) { toast('请先获取验证码'); return; }
      var code = form.code.value.trim();
      CloudDB.verifyPhone(pending.phone, pending, code).then(function () {
        closeModal();
        toast('登录成功，云端同步已开启');
        loadAll().then(function () { state.tab = 'food'; render(); checkReminders(); });
      }).catch(function (err) { toast('登录失败：' + (err.message || '未知错误')); });
    };
  }
  function doCloudLogout() {
    CloudDB.logout().then(function () { toast('已退出登录'); render(); });
  }

  /* ---------- 拍照识别小票 → 批量加入食品 ---------- */
  function scanReceipt() {
    if (!window.HOcr || !window.HReceipt) { toast('识别模块未加载'); return; }
    var inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*'; inp.capture = 'environment';
    inp.onchange = function () {
      var file = inp.files && inp.files[0];
      if (!file) return;
      toast('首次使用需下载识文字引擎（约十几 MB），请稍候…', 30000);
      window.HOcr.recognize(file, function (status, p) {
        if (status === 'recognizing text') toast('正在识别文字… ' + Math.round(p * 100) + '%', 30000);
        else if (status === 'loading language traineddata') toast('正在加载中文识别模型…', 30000);
      }).then(function (text) {
        var items = window.HReceipt.parse(text, today());
        if (!items.length) {
          toast('没识别出食品条目，可手动添加', 3000);
          return;
        }
        openReceiptModal(items);
      }).catch(function (e) {
        toast('识别失败：' + (e && e.message || e), 3500);
      });
    };
    inp.click();
  }
  function openReceiptModal(items) {
    var rows = items.map(function (it, i) {
      return '<div class="rcpt-row">' +
        '<input name="n' + i + '" value="' + esc(it.name) + '" aria-label="名称">' +
        '<input type="date" name="e' + i + '" value="' + esc(it.expiryDate) + '" aria-label="保质期至">' +
        '<span class="rcpt-tag">' + esc(it.category) + ' · ' + it.days + '天</span>' +
        '</div>';
    }).join('');
    openModal('小票识别到 ' + items.length + ' 项', '<form>' +
      '<p class="hint">已按品类<b>估算</b>保质期（生鲜 2-7 天、蛋奶 7-30 天、零食饮料 180 天、米面调料 365 天），可逐条修改；清空名称即不添加。</p>' +
      '<div class="rcpt">' + rows + '</div>' +
      '<button class="primary" type="submit">全部加入食品库</button></form>', function (form) {
      var v = formVals(form), tasks = [], n = 0;
      items.forEach(function (it, i) {
        var nm = (v['n' + i] || '').trim();
        var ex = v['e' + i] || '';
        if (!nm || !ex) return;
        tasks.push(CloudDB.put('food', {
          id: CloudDB.id(), name: nm, category: it.category || '食品', room: it.room || '厨房',
          boxId: '', quantity: '', unit: '', purchaseDate: today(), expiryDate: ex,
          remindDays: state.remindDays, note: '小票识别', createdAt: Date.now()
        }));
        n++;
      });
      if (!n) { toast('没有可添加的条目'); return false; }
      return Promise.all(tasks).then(function () { return afterSave('已从发票添加 ' + n + ' 项食品'); });
    });
  }

  /* ---------- 链接共享（免服务器快照共享） ---------- */
  function shareCountsHTML(d, prefix) {
    var s = d || state;
    return (prefix || '') + '食品 ' + (s.food || []).length + ' · 收纳盒 ' + (s.boxes || []).length +
      ' · 物项 ' + (s.items || []).length + ' · 家务 ' + (s.chores || []).length +
      ' · 每日必做 ' + (s.dailies || []).length;
  }
  function openShareModal() {
    var payload = currentPayload();
    var total = HShare.count(payload);
    if (!total) { toast('还没有可共享的内容'); return; }
    ensureRoom().then(function (rid) {
      var roomLink = location.origin + location.pathname + '#room=' + rid;
      var auto = !!state.shareAuto;
      openModal('共享给家人', '<div class="sharebox">' +
        '<div class="ssec-h">方式一 · 实时共享房间（推荐）</div>' +
        '<p class="shint">对方打开下方链接即可查看你的最新数据；开启自动发布后，你每次修改都会自动同步，无需重发。</p>' +
        '<textarea id="shareRoom" readonly rows="3">' + esc(roomLink) + '</textarea>' +
        '<label class="f" style="margin-top:10px"><input type="checkbox" id="autoPub"' + (auto ? ' checked' : '') + '> 自动发布（数据变更时同步）</label>' +
        '<div class="row-act" style="margin-top:8px">' +
        '<button data-act="copyRoom">复制房间链接</button>' +
        (navigator.share ? '<button data-act="sysShareRoom">系统分享</button>' : '') +
        '<button data-act="publishRoom">发布 / 更新</button></div>' +
        '<div class="ssec-h" style="margin-top:16px">本次将分享的内容（只读预览）</div>' +
        sharedReadOnlyHTML(payload) +
        '<div class="divider">或</div>' +
        '<div class="ssec-h">方式二 · 离线快照链接</div>' +
        '<p class="shint">无需服务器，把数据打包进链接（此刻快照），对方打开即可看。</p>' +
        '<div class="row-act"><button data-act="makeSnapshot">生成离线链接</button></div>' +
        '</div>', function () { return false; });
      var cp = document.getElementById('copyRoom');
      if (cp) cp.onclick = function () { HShare.copyText(roomLink).then(function (ok) { toast(ok ? '房间链接已复制' : '复制失败，请长按手动选择'); }); };
      var sy = document.getElementById('sysShareRoom');
      if (sy) sy.onclick = function () { navigator.share({ title: '多多管家 · 家庭共享', text: '一起管理家里的食品保质期和收纳（实时更新）', url: roomLink }).catch(function () {}); };
      var pb = document.getElementById('publishRoom');
      if (pb) pb.onclick = function () { publishRoomNow(rid); };
      var ap = document.getElementById('autoPub');
      if (ap) ap.onchange = function () {
        state.shareAuto = ap.checked;
        CloudDB.setMeta('shareAutoPublish', ap.checked).then(function () {
          toast(ap.checked ? '已开启自动发布' : '已关闭自动发布');
          if (ap.checked) publishRoomNow(rid);
        });
      };
      var ms = document.getElementById('makeSnapshot');
      if (ms) ms.onclick = function () { showSnapshotLink(payload, total); };
    });
  }
  // 合并共享内容：按 id 去重，不覆盖本地已有数据
  function mergeShared(data) {
    var tasks = [], added = 0;
    HShare.KEYS.forEach(function (k) {
      var exist = {};
      (state[k] || []).forEach(function (o) { exist[o.id] = 1; });
      (data[k] || []).forEach(function (o) {
        if (!o.id) o.id = CloudDB.id();
        if (exist[o.id]) return;
        exist[o.id] = 1;
        if (!o.createdAt) o.createdAt = Date.now();
        tasks.push(CloudDB.put(k, o));
        added++;
      });
    });
    return Promise.all(tasks).then(function () { return added; });
  }
  // 只读渲染共享内容（家人打开链接后直接查看，无需先合并）
  function sharedReadOnlyHTML(d) {
    var boxMap = {};
    (d.boxes || []).forEach(function (b) { boxMap[b.id] = b; });
    function sec(icon, title, rows) {
      if (!rows.length) return '';
      return '<div class="ssec"><div class="ssec-h">' + icon + ' ' + esc(title) + '（' + rows.length + '）</div><ul class="slist">' + rows.join('') + '</ul></div>';
    }
    var food = (d.food || []).slice().sort(function (a, b) { return (a.expiryDate || '').localeCompare(b.expiryDate || ''); })
      .map(function (f) {
        var st = foodStatus(f);
        var meta = [f.category, f.room, (f.quantity ? (f.quantity + (f.unit || '')) : '')].filter(Boolean).join(' · ');
        return '<li class="srow"><div class="sname">' + esc(f.name || '未命名') + '</div>' +
          (meta ? '<div class="smeta">' + esc(meta) + '</div>' : '') +
          (f.expiryDate ? '<div class="smeta st-' + st.cls + '">📅 ' + esc(f.expiryDate) + '（' + st.txt + '）</div>' : '');
      });
    var boxes = (d.boxes || []).map(function (b) {
      var items = (d.items || []).filter(function (i) { return i.boxId === b.id; });
      var sub = [b.type, b.room].filter(Boolean).join(' · ');
      var inner = (b.note ? '<div class="smeta">' + esc(b.note) + '</div>' : '') +
        (items.length ? '<div class="smeta">内含：' + esc(items.map(function (i) { return i.name; }).join('、')) + '</div>' : '');
      return '<li class="srow"><div class="sname">📦 ' + esc(b.name || '未命名') + '</div>' +
        (sub ? '<div class="smeta">' + esc(sub) + '</div>' : '') + inner + '</li>';
    });
    var items = (d.items || []).filter(function (i) { return !i.boxId || !boxMap[i.boxId]; })
      .map(function (i) {
        var meta = [i.category, i.room, (i.boxId && boxMap[i.boxId] ? ('属 ' + boxMap[i.boxId].name) : '')].filter(Boolean).join(' · ');
        return '<li class="srow"><div class="sname">' + esc(i.name || '未命名') + '</div>' +
          (meta ? '<div class="smeta">' + esc(meta) + '</div>' : '') +
          (i.note ? '<div class="smeta">' + esc(i.note) + '</div>' : '');
      });
    var chores = (d.chores || []).map(function (c) {
      var meta = [c.room, c.priority, (c.done ? '已完成' : '待办')].filter(Boolean).join(' · ');
      return '<li class="srow"><div class="sname">' + esc(c.title || '未命名') + '</div>' +
        (meta ? '<div class="smeta">' + esc(meta) + '</div>' : '') +
        (c.dueDate ? '<div class="smeta">截止 ' + esc(c.dueDate) + '</div>' : '');
    });
    var dailies = (d.dailies || []).map(function (x) {
      return '<li class="srow"><div class="sname">' + esc(x.title || '未命名') + '</div>' +
        (x.note ? '<div class="smeta">' + esc(x.note) + '</div>' : '');
    });
    return sec('🥫', '食品保质期', food) + sec('📦', '收纳盒', boxes) + sec('🧺', '零散物项', items) +
      sec('✅', '家务', chores) + sec('📅', '每日必做', dailies);
  }
  function showIncomingShare(data) {
    var total = HShare.count(data);
    openModal('家人共享内容（只读）', '<div class="sharebox">' +
      '<p class="shint">以下是家人分享的 <b>' + total + '</b> 条家庭数据，可直接查看（只读）：' + shareCountsHTML(data, '') + '</p>' +
      sharedReadOnlyHTML(data) +
      '<div class="row-act" style="margin-top:14px">' +
      '<button data-act="laterShare">关闭</button>' +
      '<button data-act="doMergeShare">合并到我的数据</button></div>' +
      '<p class="shint">若想把这些内容存入你自己的多多管家，点「合并到我的数据」即可（会跳过已有重复项，不覆盖现有数据）。</p>' +
      '</div>', function () { return false; });
    var mb = document.getElementById('doMergeShare');
    if (mb) mb.onclick = function () {
      mergeShared(data).then(function (n) {
        closeModal(); HShare.clearHash();
        afterSave(n ? ('已合并 ' + n + ' 条共享内容') : '这些内容你本地已经有了');
      });
    };
    var lb = document.getElementById('laterShare');
    if (lb) lb.onclick = function () { closeModal(); HShare.clearHash(); toast('已关闭预览'); };
  }

  /* ---------- 共享房间（方案 B）辅助 ---------- */
  function currentPayload() {
    return { food: state.food, boxes: state.boxes, items: state.items, chores: state.chores, dailies: state.dailies, bills: state.bills };
  }
  function ensureRoom() {
    if (state.shareRoomId) return Promise.resolve(state.shareRoomId);
    var rid = HShare.genRoomId();
    return CloudDB.setMeta('shareRoomId', rid).then(function () { state.shareRoomId = rid; return rid; });
  }
  function publishRoomNow(rid, silent) {
    return HShare.publishRoom(rid, currentPayload()).then(function () {
      if (!silent) toast('已发布到共享房间');
    }).catch(function (e) {
      toast('发布失败：' + (e && e.message || '网络错误'));
    });
  }
  function publishRoomSilently(rid) {
    HShare.publishRoom(rid, currentPayload()).catch(function (e) { console.warn('自动发布失败', e); });
  }
  function showSnapshotLink(payload, total) {
    HShare.buildLink(payload).then(function (link) {
      openModal('离线快照链接', '<div class="sharebox">' +
        '<p class="shint">本次快照 <b>' + total + '</b> 条，已打包进下方链接（此刻数据）。</p>' +
        '<textarea id="shareLink" readonly rows="4">' + esc(link) + '</textarea>' +
        '<div class="row-act" style="margin-top:10px"><button data-act="copyShare">复制链接</button>' +
        (navigator.share ? '<button data-act="sysShare">系统分享</button>' : '') + '</div>' +
        (link.length > 60000 ? '<p class="shint warn">内容较多、链接较长（' + link.length + ' 字符），个别聊天软件可能截断，建议用系统分享。</p>' : '') +
        '</div>', function () { return false; });
      var cp = document.getElementById('copyShare');
      if (cp) cp.onclick = function () { HShare.copyText(link).then(function (ok) { toast(ok ? '链接已复制' : '复制失败，请长按'); }); };
      var sy = document.getElementById('sysShare');
      if (sy) sy.onclick = function () { navigator.share({ title: '多多管家 · 家庭数据', text: '一起管理家里的食品保质期和收纳（共 ' + total + ' 条）', url: link }).catch(function () {}); };
    });
  }
  // 家人打开 #room= 链接：只读实时视图（刷新 / 合并 / 关闭）
  function showRoomView(rid) {
    openModal('家人共享内容（实时）', '<div class="sharebox">' +
      '<p class="shint" id="roomStatus">正在加载共享数据…</p><div id="roomBody"></div></div>', function () { return false; });
    renderRoom(rid);
  }
  function renderRoom(rid) {
    var st = document.getElementById('roomStatus');
    var body = document.getElementById('roomBody');
    HShare.fetchRoom(rid).then(function (res) {
      if (!res) { if (st) st.textContent = '该共享房间还没有内容，或链接已失效。'; if (body) body.innerHTML = ''; return; }
      if (res._error) { if (st) st.textContent = res._error; if (body) body.innerHTML = ''; return; }
      if (st) st.textContent = '更新于 ' + new Date(res.updatedAt || Date.now()).toLocaleString();
      if (body) body.innerHTML = sharedReadOnlyHTML(res.data) +
        '<div class="row-act" style="margin-top:14px">' +
        '<button data-act="refreshRoom">刷新</button>' +
        '<button data-act="doMergeShare">合并到我的数据</button>' +
        '<button data-act="closeRoom">关闭</button></div>' +
        '<p class="shint">这是对方实时发布的只读内容；点「刷新」获取最新。合并会跳过你本地已有的重复项。</p>';
      var rf = document.getElementById('refreshRoom');
      if (rf) rf.onclick = function () { renderRoom(rid); };
      var cl = document.getElementById('closeRoom');
      if (cl) cl.onclick = closeModal;
      var mg = document.getElementById('doMergeShare');
      if (mg) mg.onclick = function () { mergeShared(res.data).then(function (n) { closeModal(); afterSave(n ? ('已合并 ' + n + ' 条') : '这些内容你本地已经有了'); }); };
    }).catch(function (e) {
      if (st) st.textContent = '读取失败：' + (e && e.message || '网络错误');
    });
  }

  /* ---------- 全局搜索 ---------- */
  function runSearch(q) {
    q = (q || '').trim().toLowerCase();
    if (!q) return [];
    var m = [];
    function scan(store, type, label, nameOf, extra) {
      (state[store] || []).forEach(function (o) {
        var hay = [nameOf(o), extra ? extra(o) : '', o.note || '', o.room || ''].join(' ').toLowerCase();
        if (hay.indexOf(q) >= 0) m.push({ type: type, label: label, store: store, id: o.id, name: nameOf(o), sub: extra ? extra(o) : '' });
      });
    }
    scan('food', 'food', '食品', function (o) { return o.name; }, function (o) { return [o.category, o.room, o.expiryDate].filter(Boolean).join(' · '); });
    scan('boxes', 'box', '收纳盒', function (o) { return o.name; }, function (o) { return [o.type, o.room].filter(Boolean).join(' · '); });
    scan('items', 'item', '物项', function (o) { return o.name; }, function (o) { return [o.category, o.room].filter(Boolean).join(' · '); });
    scan('chores', 'chore', '家务', function (o) { return o.title; }, function (o) { return [o.room, o.priority, (o.done ? '已完成' : '待办')].filter(Boolean).join(' · '); });
    scan('dailies', 'daily', '每日必做', function (o) { return o.title; }, function (o) { return o.note || ''; });
    return m;
  }
  function openSearchModal() {
    openModal('全局搜索', '<div class="sharebox">' +
      '<input id="searchInput" class="sinput" placeholder="搜索食品 / 收纳 / 家务 / 每日必做…" autofocus>' +
      '<div id="searchResults"></div></div>', function () { return false; });
    var si = document.getElementById('searchInput');
    if (si) {
      si.oninput = function () { renderSearchResults(si.value); };
      renderSearchResults('');
      setTimeout(function () { try { si.focus(); } catch (e) {} }, 60);
    }
  }
  function renderSearchResults(q) {
    var box = document.getElementById('searchResults');
    if (!box) return;
    var m = runSearch(q);
    if (!q || !q.trim()) { box.innerHTML = '<p class="shint">输入关键词，跨「食品 / 收纳 / 家务 / 每日必做」搜索。</p>'; return; }
    if (!m.length) { box.innerHTML = '<p class="shint">没有找到匹配「' + esc(q.trim()) + '」的内容。</p>'; return; }
    box.innerHTML = '<ul class="slist">' + m.map(function (x) {
      return '<li class="srow tap" data-jump="1" data-type="' + x.type + '" data-id="' + esc(x.id) + '">' +
        '<div class="sname">' + esc(x.name) + ' <span class="smeta">' + esc(x.label) + '</span></div>' +
        (x.sub ? '<div class="smeta">' + esc(x.sub) + '</div>' : '') + '</li>';
    }).join('') + '</ul>';
    $all('#searchResults [data-jump]').forEach(function (el) {
      el.onclick = function () { jumpSearch(el.getAttribute('data-type'), el.getAttribute('data-id')); };
    });
  }
  function jumpSearch(type, id) {
    closeModal();
    if (type === 'food') { state.tab = 'food'; render(); CloudDB.get('food', id).then(function (o) { if (o) openFoodModal(null, o, '已保存'); }); }
    else if (type === 'box') { state.tab = 'storage'; storageSub = 'boxes'; render(); CloudDB.get('boxes', id).then(function (o) { if (o) openBoxModal(o); }); }
    else if (type === 'item') { state.tab = 'storage'; storageSub = 'items'; render(); CloudDB.get('items', id).then(function (o) { if (o) openItemModal(null, o, '已保存'); }); }
    else if (type === 'chore') { state.tab = 'chores'; render(); CloudDB.get('chores', id).then(function (o) { if (o) openChoreModal(o); }); }
    else if (type === 'daily') { state.tab = 'dailies'; render(); CloudDB.get('dailies', id).then(function (o) { if (o) openDailyModal(o); }); }
  }

  function exportData() {
    var data = { app: 'duoduo-home', version: APP_VERSION, exportedAt: new Date().toISOString(),
      food: state.food, boxes: state.boxes, items: state.items, chores: state.chores, dailies: state.dailies };
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '多多管家备份_' + today() + '.json';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    toast('已导出备份');
  }
  function importData() {
    var inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'application/json';
    inp.onchange = function () {
      var file = inp.files[0]; if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var d = JSON.parse(reader.result);
          if (!confirm('将导入备份并合并到现有数据，确定继续？')) return;
          var tasks = [];
          ['food', 'boxes', 'items', 'chores', 'dailies'].forEach(function (k) {
            (d[k] || []).forEach(function (o) { tasks.push(CloudDB.put(k, o)); });
          });
          Promise.all(tasks).then(function () { afterSave(); toast('导入完成：' + tasks.length + ' 条'); });
        } catch (e) { toast('文件解析失败'); }
      };
      reader.readAsText(file);
    };
    inp.click();
  }

  /* ---------- 自动本地备份（防平台数据丢失） ---------- */
  var _backupTimer = null;
  function backupSnapshotData() {
    return { food: state.food, boxes: state.boxes, items: state.items, chores: state.chores, dailies: state.dailies, bills: state.bills };
  }
  // 把当前（已合并云端）数据存一份带时间戳的快照到本机 IndexedDB，仅保留最近 30 份
  function saveLocalBackup() {
    var snap = { id: Date.now(), ts: new Date().toISOString(), data: backupSnapshotData() };
    return HDB.put('backups', snap).then(function () {
      return HDB.getAll('backups').then(function (arr) {
        if (arr.length > 30) {
          arr.sort(function (a, b) { return b.id - a.id; });
          return Promise.all(arr.slice(30).map(function (x) { return HDB.del('backups', x.id); }));
        }
      });
    }).catch(function () { /* 备份失败静默忽略，不影响使用 */ });
  }
  function startAutoBackup() {
    if (_backupTimer) { clearInterval(_backupTimer); _backupTimer = null; }
    if (!state.autoBackup) return;
    saveLocalBackup();
    _backupTimer = setInterval(saveLocalBackup, Math.max(1, state.autoBackupDays) * 86400000);
  }
  function listBackups() {
    return HDB.getAll('backups').then(function (arr) { arr.sort(function (a, b) { return b.id - a.id; }); return arr; });
  }
  function exportLatestBackup() {
    listBackups().then(function (arr) {
      if (!arr.length) { toast('暂无备份'); return; }
      var snap = arr[0];
      var blob = new Blob([JSON.stringify({ app: 'duoduo-home', version: APP_VERSION, exportedAt: snap.ts, data: snap.data }, null, 2)], { type: 'application/json' });
      var a = document.createElement('a'); a.href = URL.createObjectURL(blob);
      a.download = '多多管家自动备份_' + today() + '.json'; a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
      toast('已导出最新备份');
    });
  }
  function restoreBackup() {
    listBackups().then(function (arr) {
      if (!arr.length) { toast('暂无备份'); return; }
      var snap = arr[0];
      if (!confirm('将用最近一份备份（' + snap.ts + '）覆盖当前数据并同步到云端，确定继续？')) return;
      var tasks = [];
      SYNC_TYPES.forEach(function (k) { (snap.data[k] || []).forEach(function (o) { tasks.push(CloudDB.put(k, o)); }); });
      Promise.all(tasks).then(function () { return afterSave(); }).then(function () { return pushLocalAll(); })
        .then(function () { toast('已从备份恢复'); });
    });
  }
  function openAutoBackupModal() {
    openModal('备份间隔（天）',
      '<form><label class="f"><span>自动备份间隔（天，1–365）</span>' +
      '<input type="number" name="days" min="1" max="365" value="' + state.autoBackupDays + '"></label>' +
      '<button class="primary" type="submit">保存</button></form>',
      function (form) {
        var v = parseInt(formVals(form).days, 10);
        if (!v || v < 1) { toast('请输入有效天数'); return false; }
        v = Math.min(365, v);
        state.autoBackupDays = v; CloudDB.setMeta('autoBackupDays', v); startAutoBackup(); render();
        toast('已设置每 ' + v + ' 天备份'); return true;
      });
  }
  function showHowto() {
    openModal('添加到主屏幕（iPhone）',
      '<div class="howto"><ol>' +
      '<li>用 <b>Safari</b> 打开本应用链接（微信里先“在浏览器打开”）。</li>' +
      '<li>点击底部 <b>分享</b> 按钮（方框向上箭头）。</li>' +
      '<li>滑动找到并点击 <b>“添加到主屏幕”</b>。</li>' +
      '<li>命名“多多管家”后点右上角<b>添加</b>。</li>' +
      '<li>桌面出现图标，像 App 一样离线使用，数据存本机不丢失。</li>' +
      '</ol><p class="hint">升级新版本时，只需用同一链接重新打开一次即可，本机数据会自动保留。</p></div>',
      function () { return false; });
  }
  function clearAll() {
    if (!confirm('将删除本机全部数据，且无法恢复！确定继续？')) return;
    if (!confirm('最后确认：真的要清空所有食品/收纳/家务/每日必做数据？')) return;
    Promise.all(CloudDB.STORES.filter(function (s) { return s !== 'meta'; }).map(function (s) {
      return CloudDB.getAll(s).then(function (arr) { return Promise.all(arr.map(function (o) { return CloudDB.del(s, o.id); })); });
    })).then(function () { afterSave(); toast('已清空全部数据'); });
  }

  /* ---------- 初始化 ---------- */
  function init() {
    $('#app').addEventListener('click', onViewClick);
    $('#app').addEventListener('change', onAppChange);
    CloudDB.onNeedLogin = function () { if (CloudDB.mode() === 'cloud') showLoginModal(); };
    CloudDB.open().then(function () { return loadAll(); }).then(function () {
      render();
      checkReminders();
      initSync(); // 首次：先拉云端、再推本地，之后每 8 秒自动拉取
      startAutoBackup(); // 按设置定时把数据快照存到本机
      setInterval(checkReminders, 60000); // 每 60 秒复检提醒
      // App 切到后台或被关闭时立即存一份备份，保证「按天备份」在平时也生效
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') saveLocalBackup();
      });
      window.addEventListener('pagehide', function () { saveLocalBackup(); });
      // 链接里若带有共享内容，提示是否合并
      return HShare.readFromUrl();
    }).then(function (shared) {
      if (shared && HShare.has(shared)) { showIncomingShare(shared); return; }
      var rid = HShare.roomFromUrl();
      if (rid) showRoomView(rid);
    }).catch(function (e) {
      if (e && e.needLogin) return; // 已弹出登录框，无需报错
      toast('初始化失败：' + (e && e.message || e));
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
