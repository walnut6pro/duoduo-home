/* app.js —— 多多管家 PWA 主程序
 * 六大模块：1食品保质期 2收纳(盒+物项) 3语音智能分类 4家务 5每日必做 6我的(设置/备份/版本)
 */
(function () {
  'use strict';
  var CloudDB = window.CloudDB, HClassify = window.HClassify, HSpeech = window.HSpeech, HShare = window.HShare;
  var APP_VERSION = '1.0';

  var ROOMS = ['厨房', '客厅', '卧室', '卫生间', '书房', '阳台', '储物间'];
  var BOX_TYPES = ['箱子', '收纳盒'];
  var PRIOS = ['高', '中', '低'];

  var state = {
    tab: 'food',
    food: [], boxes: [], items: [], chores: [], dailies: [],
    remindDays: 7, notifEnabled: false, _notifiedToday: ''
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
      CloudDB.getAll('chores'), CloudDB.getAll('dailies'), CloudDB.getMeta('remindDays', 7)
    ]).then(function (r) {
      state.food = r[0]; state.boxes = r[1]; state.items = r[2];
      state.chores = r[3]; state.dailies = r[4]; state.remindDays = +r[5] || 7;
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
  function openChoreModal() {
    openModal('添加家务', choreForm(), function (form) {
      var v = formVals(form);
      if (!v.title) { toast('请填写标题'); return false; }
      var obj = { id: CloudDB.id(), title: v.title, room: v.room, priority: v.priority, dueDate: v.dueDate || '', done: false, doneAt: '', createdAt: Date.now() };
      return CloudDB.put('chores', obj).then(function () { return afterSave('已添加'); });
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
  function openDailyModal() {
    openModal('添加每日必做', '<form>' +
      field('标题', '<input name="title" required placeholder="如：倒垃圾">') +
      field('备注', '<input name="note" placeholder="选填">') +
      '<button class="primary" type="submit">保存</button></form>', function (form) {
      var v = formVals(form);
      if (!v.title) { toast('请填写标题'); return false; }
      var obj = { id: CloudDB.id(), title: v.title, note: v.note, createdAt: Date.now(), lastDoneDate: '' };
      return CloudDB.put('dailies', obj).then(function () { return afterSave('已添加'); });
    });
  }

  /* ---------- 视图：我的 ---------- */
  function cloudCard() {
    if (CloudDB.mode() !== 'cloud') {
      return '<div class="card static"><div class="card-main"><div class="card-title">数据存储</div>' +
        '<div class="card-sub">本机存储（离线可用）· 启用云服务后自动切换云端同步</div></div></div>';
    }
    var u = CloudDB.currentUser();
    if (u) {
      var name = u.name || u.phone || (u.id ? ('用户 ' + u.id) : '已登录');
      return '<div class="card static"><div class="card-main"><div class="card-title">云端同步 · 已连接</div>' +
        '<div class="card-sub">账号：' + esc(name) + '</div></div>' +
        '<button class="row-act-b" data-act="cloudLogout">退出登录</button></div>';
    }
    return '<div class="card tap" data-act="cloudLogin"><div class="card-main"><div class="card-title">云端同步 · 未登录</div>' +
      '<div class="card-sub">点此手机号登录，开启多端同步</div></div><span class="chev">›</span></div>';
  }
  function viewMe() {
    var notif = ('Notification' in window) ? (Notification.permission === 'granted' ? '已开启' : '<button class="mini" data-act="enableNotif">开启通知</button>') : '当前浏览器不支持';
    return '<div class="head"><h1>我的</h1></div>' +
      '<div class="list">' +
      '<div class="card static"><div class="card-main"><div class="card-title">应用版本</div><div class="card-sub">多多管家 v' + APP_VERSION + '（PWA）</div></div></div>' +
      cloudCard() +
      '<div class="card tap" data-act="shareLink"><div class="card-main"><div class="card-title">共享给家人（生成链接）</div><div class="card-sub">把当前内容打包进链接，对方打开即可看到并合并</div></div><span class="chev">›</span></div>' +
      '<div class="card static"><div class="card-main"><div class="card-title">默认提前提醒</div><div class="card-sub">食品临期提前 ' + state.remindDays + ' 天提醒</div></div><button class="row-act-b" data-act="setRemind">设置</button></div>' +
      '<div class="card static"><div class="card-main"><div class="card-title">过期提醒通知</div><div class="card-sub">' + notif + '</div></div></div>' +
      '<div class="card tap" data-act="exportData"><div class="card-main"><div class="card-title">数据备份（导出）</div><div class="card-sub">导出 JSON 文件，换手机/重装可恢复</div></div><span class="chev">›</span></div>' +
      '<div class="card tap" data-act="importData"><div class="card-main"><div class="card-title">数据恢复（导入）</div><div class="card-sub">从备份文件恢复数据</div></div><span class="chev">›</span></div>' +
      '<div class="card tap" data-act="howto"><div class="card-main"><div class="card-title">如何添加到主屏幕</div><div class="card-sub">iPhone Safari 打开 → 分享 → 添加到主屏幕</div></div><span class="chev">›</span></div>' +
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
    });
  }

  /* ---------- 渲染 ---------- */
  var VIEWS = { food: viewFood, storage: viewStorage, voice: viewVoice, chores: viewChores, dailies: viewDailies, me: viewMe };
  function render() {
    var v = $('#view');
    v.innerHTML = (VIEWS[state.tab] || viewFood)();
    $all('.nav button').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-tab') === state.tab); });
    if (state.tab === 'voice') {
      bindVoice();
      // 停留在语音页时，保留上一次识别结果卡片，方便连续录入
      if (lastVoice && lastParse) showVoiceResult(lastVoice, true);
    }
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
            .then(function () { return CloudDB.del('boxes', id); }).then(function () { afterSave(); toast('已删除'); });
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
            expiryDate: expDate, remindDays: state.remindDays, note: '', createdAt: Date.now()
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
      case 'scanReceipt': scanReceipt(); break;
      case 'setRemind': openRemindModal(); break;
      case 'enableNotif':
        if ('Notification' in window) Notification.requestPermission().then(function (p) { toast('通知权限：' + p); render(); });
        break;
      case 'shareLink': openShareModal(); break;
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
    CloudDB.del(store, id).then(function () { afterSave(); toast('已删除'); });
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
    var payload = { food: state.food, boxes: state.boxes, items: state.items, chores: state.chores, dailies: state.dailies };
    var total = HShare.count(payload);
    if (!total) { toast('还没有可共享的内容'); return; }
    HShare.buildLink(payload).then(function (link) {
      openModal('共享给家人', '<div class="sharebox">' +
        '<p class="shint">本次共享 <b>' + total + '</b> 条：' + shareCountsHTML(state) + '</p>' +
        '<textarea id="shareLink" readonly rows="4">' + esc(link) + '</textarea>' +
        '<div class="row-act" style="margin-top:10px"><button data-act="copyShare">复制链接</button>' +
        (navigator.share ? '<button data-act="sysShare">系统分享</button>' : '') + '</div>' +
        '<p class="shint">对方用 <b>Safari</b> 打开该链接，即可看到这些内容并选择「合并到我的数据」。链接携带的是<b>此刻的数据快照</b>；对方合并后可再生成新链接继续分享。</p>' +
        (link.length > 60000 ? '<p class="shint warn">内容较多、链接较长（' + link.length + ' 字符），个别聊天软件可能截断，建议用系统分享。</p>' : '') +
        '</div>', function () { return false; });
      var cp = document.getElementById('copyShare');
      if (cp) cp.onclick = function () {
        HShare.copyText(link).then(function (ok) { toast(ok ? '链接已复制' : '复制失败，请长按手动选择'); });
      };
      var sy = document.getElementById('sysShare');
      if (sy) sy.onclick = function () {
        navigator.share({ title: '多多管家 · 家庭数据', text: '一起管理家里的食品保质期和收纳（共 ' + total + ' 条）', url: link })
          .catch(function () {});
      };
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
  function showIncomingShare(data) {
    var total = HShare.count(data);
    openModal('收到共享内容', '<div class="sharebox">' +
      '<p class="shint">这个链接里包含 <b>' + total + '</b> 条家庭数据：' + shareCountsHTML(data, '') + '</p>' +
      '<div class="row-act" style="margin-top:10px">' +
      '<button data-act="doMergeShare">合并到我的数据</button><button data-act="laterShare">暂不</button></div>' +
      '<p class="shint">合并会跳过你本地已有的重复条目，不会覆盖现有数据。</p>' +
      '</div>', function () { return false; });
    var mb = document.getElementById('doMergeShare');
    if (mb) mb.onclick = function () {
      mergeShared(data).then(function (n) {
        closeModal(); HShare.clearHash();
        afterSave(n ? ('已合并 ' + n + ' 条共享内容') : '这些内容你本地已经有了');
      });
    };
    var lb = document.getElementById('laterShare');
    if (lb) lb.onclick = function () { closeModal(); HShare.clearHash(); toast('已忽略，可再次打开原链接合并'); };
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
      setInterval(checkReminders, 60000); // 每 60 秒复检提醒
      // 链接里若带有共享内容，提示是否合并
      return HShare.readFromUrl();
    }).then(function (shared) {
      if (shared && HShare.has(shared)) showIncomingShare(shared);
    }).catch(function (e) {
      if (e && e.needLogin) return; // 已弹出登录框，无需报错
      toast('初始化失败：' + (e && e.message || e));
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
