/* classify.js —— 纯本地规则的中文物项智能分类
 * 语音/文字输入后，根据关键词匹配 类别 + 推荐房间，并决定归入“食品保质期”还是“收纳物项”。
 * 不依赖网络与服务端，离线可用。
 */
(function (global) {
  'use strict';

  // 词库：每个条目含一组关键词，命中即归入对应 类别/房间
  var DICT = [
    { cat: '食品', room: '厨房', words: ['牛奶', '面包', '鸡蛋', '水果', '苹果', '香蕉', '橘子', '梨', '蔬菜', '青菜', '西红柿', '土豆', '肉', '猪肉', '牛肉', '鸡肉', '鱼', '虾', '米', '大米', '米面', '面', '面条', '方便面', '油', '盐', '糖', '酱油', '醋', '调料', '味精', '零食', '饼干', '薯片', '巧克力', '饮料', '可乐', '雪碧', '果汁', '水', '矿泉水', '咖啡', '茶', '酸奶', '奶酪', '黄油', '豆腐', '饺子', '速冻', '汤圆', '罐头', '酱', '辣酱', '蜂蜜', '坚果'] },
    { cat: '药品', room: '卫生间', words: ['药', '感冒', '退烧', '消炎', '创可贴', '碘伏', '酒精', '体温计', '口罩', '维生素', '止痛', '过敏', '肠胃', '棉签'] },
    { cat: '洗护', room: '卫生间', words: ['洗发', '沐浴', '牙膏', '牙刷', '洗衣液', '洗洁精', '洗手液', '纸巾', '厕纸', '毛巾', '香皂', '沐浴露', '护手霜', '护肤', '梳子'] },
    { cat: '清洁', room: '厨房', words: ['垃圾袋', '抹布', '消毒液', '拖把', '扫把', '保鲜膜', '保鲜袋', '清洁', '海绵'] },
    { cat: '工具', room: '储物间', words: ['螺丝刀', '锤子', '钳子', '胶带', '剪刀', '电池', '充电', '电线', '扳手', '电笔', '尺', '针线', '工具'] },
    { cat: '文具', room: '书房', words: ['笔', '纸', '本子', '订书机', '便利贴', '胶水', '尺子', '文件夹', '文具', '墨水'] },
    { cat: '衣物', room: '卧室', words: ['衣服', '衬衫', '裤子', '袜子', '鞋', '帽子', '内衣', '毛衣', '外套', '围巾', '皮带'] },
    { cat: '数码', room: '书房', words: ['耳机', '手机', '充电宝', '数据线', '路由器', '键盘', '鼠标', 'u盘', '充电线', '电源'] },
    { cat: '玩具', room: '客厅', words: ['玩具', '积木', '拼图', '娃娃', '球', '乐高'] },
    { cat: '书籍', room: '书房', words: ['书', '杂志', '绘本', '课本'] }
  ];

  var DEFAULT = { cat: '杂物', room: '储物间' };

  // 清洗：只去掉"的"和开头的数量词（一盒牛奶→牛奶；面包保持不变，避免误伤）
  function clean(t) {
    var s = (t || '').replace(/[的]/g, '');
    s = s.replace(/^\s*[0-9一二俩两三四五六七八九十百千万]+\s*(千克|公斤|斤|个|只|盒|箱|袋|瓶|包|件|把|条|根|支|双|套|杯|罐|听|桶|块|片|克|毫升|升)\s*/, '');
    return s.trim();
  }

  function classify(text) {
    var t = clean(text);
    var best = null, bestScore = 0;
    for (var i = 0; i < DICT.length; i++) {
      var d = DICT[i], score = 0;
      for (var j = 0; j < d.words.length; j++) {
        if (t.indexOf(d.words[j]) >= 0) score += d.words[j].length; // 长词权重更高
      }
      if (score > bestScore) { bestScore = score; best = d; }
    }
    var res = best ? { cat: best.cat, room: best.room, score: bestScore } : { cat: DEFAULT.cat, room: DEFAULT.room, score: 0 };
    // 食品类 → 进入“食品保质期”模块；其余 → “收纳物项”模块
    res.target = res.cat === '食品' ? 'food' : 'items';
    return res;
  }

  // 在给定收纳盒列表中，按房间推荐最合适的盒子
  function suggestBox(text, boxes) {
    var c = classify(text);
    if (!boxes || !boxes.length) return [];
    var sameRoom = boxes.filter(function (b) { return b.room === c.room; });
    return sameRoom.length ? sameRoom : boxes;
  }

  /* ===== 放置位置识别 ===== */

  // 房间别称 → 标准房间
  var ROOM_SYN = {
    '厨房': '厨房', '客厅': '客厅', '卧室': '卧室', '卫生间': '卫生间',
    '浴室': '卫生间', '洗手间': '卫生间', '厕所': '卫生间', '书房': '书房',
    '阳台': '阳台', '储物间': '储物间', '储藏室': '储物间', '杂物间': '储物间',
    '门口': '客厅', '玄关': '客厅'
  };

  // 从文本中识别房间（含别称）；无则返回 ''
  function roomFromText(text) {
    var t = text || '';
    for (var k in ROOM_SYN) { if (t.indexOf(k) >= 0) return ROOM_SYN[k]; }
    return '';
  }

  // 放置指示词：出现在这些词之后的通常是位置
  var PLACE_KEYS = ['放到', '放在', '放进', '放于', '置于', '收纳到', '收到', '摆放在', '摆到', '收纳', '摆放', '放', '置于', '收到'];
  // 保质期相关说法：遇到就从这里截断，保证物项名干净
  var EXP_KEYS = ['保质期', '有效期', '过期', '还有', '保质', '半年', '半月', '半个月'];

  // 抽取物项名称：去掉句首动词，在第一个"放置/保质期"指示词处截断，并剔除残留日期片段
  function cleanName(text) {
    var raw = (text || '').trim();
    var t = raw.replace(/^(帮我|麻烦|请|我要|把|将|记一下|记录|添加|记得)/, '');
    var keys = PLACE_KEYS.concat(EXP_KEYS).slice().sort(function (a, b) { return b.length - a.length; });
    var idx = -1;
    for (var i = 0; i < keys.length; i++) {
      var p = t.indexOf(keys[i]);
      if (p > 0 && (idx < 0 || p < idx)) idx = p;
    }
    if (idx > 0) t = t.slice(0, idx);
    // 去掉残留的日期 / 时长片断
    t = t.replace(/\d{4}\s*[-年/.]\s*\d{1,2}\s*[-月/.]\s*\d{1,2}/g, '');
    t = t.replace(/\d{1,2}\s*月\s*\d{1,2}\s*[日号]?/g, '');
    t = t.replace(/\d{1,2}\s*\/\s*\d{1,2}/g, '');
    t = t.replace(/[0-9零一二两三四五六七八九十]+\s*(个)?\s*(月|周|星期|礼拜|天|日|年)/g, '');
    var c = clean(t);
    return c || clean(raw) || raw;
  }

  // 在用户的收纳盒库中找出文本所指的盒子：① 盒子名被提及 ② 房间被提及则取该房间第一个盒
  function findBoxId(text, boxes) {
    if (!boxes || !boxes.length) return '';
    var i, b;
    for (i = 0; i < boxes.length; i++) {
      b = boxes[i];
      if (b && b.name && (text || '').indexOf(b.name) >= 0) return b.id;
    }
    var room = roomFromText(text);
    if (room) {
      for (i = 0; i < boxes.length; i++) { if (boxes[i] && boxes[i].room === room) return boxes[i].id; }
    }
    return '';
  }

  /* ===== 未识别的收纳位置 ===== */

  // 抽取“放到XX / 放在XX”里的 XX
  function extractLocation(text) {
    var t = (text || '').trim();
    var keys = PLACE_KEYS.slice().sort(function (a, b) { return b.length - a.length; });
    var idx = -1, key = '';
    for (var i = 0; i < keys.length; i++) {
      var p = t.indexOf(keys[i]);
      if (p >= 0 && (idx < 0 || p < idx)) { idx = p; key = keys[i]; }
    }
    if (idx < 0) return '';
    var rest = t.slice(idx + key.length).trim();
    rest = rest.replace(/[，,。.！!？?；;].*$/, '');           // 截掉后续句子
    rest = rest.replace(/(里面|里|内|中|上面|下面|上边|下边|上|下|那儿|那里|吧|哦|了)$/g, '').trim();
    return rest;
  }

  // 语音里说了一个既不是标准房间、也匹配不上已有盒子的位置 → 返回它，用于提示新建收纳位置
  function unknownLocation(text, boxes) {
    var loc = extractLocation(text);
    if (!loc) return '';
    if (loc.length > 20) return '';
    if (!/[A-Za-z\u4e00-\u9fa5]/.test(loc)) return '';       // 纯数字/符号不算位置（注意 \W 会误伤中文）
    if (ROOM_SYN[loc]) return '';                            // 就是房间名，无需新建
    var i, b;
    for (i = 0; i < (boxes || []).length; i++) {             // 已有盒子能对上
      b = boxes[i];
      if (!b || !b.name) continue;
      if (loc.indexOf(b.name) >= 0 || b.name.indexOf(loc) >= 0) return '';
    }
    return loc;
  }

  /* ===== 保质期识别 ===== */
  var CN_NUM = { '零': 0, '一': 1, '两': 2, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };
  function cn2num(s) {
    if (!s) return 0;
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    if (s.indexOf('十') >= 0) {
      var ps = s.split('十');
      var t = ps[0] === '' ? 1 : (CN_NUM[ps[0]] || 0);
      var u = ps[1] === '' ? 0 : (CN_NUM[ps[1]] || 0);
      return t * 10 + u;
    }
    return CN_NUM[s] || 0;
  }
  function fmtDate(y, m, d) { return y + '-' + (m < 10 ? '0' + m : m) + '-' + (d < 10 ? '0' + d : d); }
  function addDaysStr(n) {
    var d = new Date(); d.setDate(d.getDate() + n);
    return fmtDate(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }
  var REL_UNIT = { '月': 30, '周': 7, '星期': 7, '礼拜': 7, '天': 1, '日': 1, '年': 365 };

  // 从语音文本中识别保质期，返回 YYYY-MM-DD；识别不到返回 ''
  function parseExpiry(text) {
    var t = text || '';
    var now = new Date();
    var i;
    // 1) 绝对：2026-11-05 / 2026年11月5日
    var m = t.match(/(\d{4})\s*[-年/.]\s*(\d{1,2})\s*[-月/.]\s*(\d{1,2})/);
    if (m) return fmtDate(+m[1], +m[2], +m[3]);
    // 2) 绝对：11月5日/号（跨年自动取明年）
    m = t.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/);
    if (m) {
      var mo = +m[1], da = +m[2], y = now.getFullYear();
      if (mo < now.getMonth() + 1) y += 1;
      return fmtDate(y, mo, da);
    }
    // 2b) 绝对：11/20、11-20（月/日，跨年自动取明年）
    m = t.match(/(\d{1,2})\s*[\/\-]\s*(\d{1,2})(?!\d)/);
    if (m) {
      var mo2 = +m[1], da2 = +m[2];
      if (mo2 >= 1 && mo2 <= 12 && da2 >= 1 && da2 <= 31) {
        var y2 = now.getFullYear();
        if (mo2 < now.getMonth() + 1) y2 += 1;
        return fmtDate(y2, mo2, da2);
      }
    }
    // 3) 口头：半年 / 半月
    if (/半年/.test(t)) return addDaysStr(180);
    if (/半月|半个月/.test(t)) return addDaysStr(15);
    // 4) 相对：X天 / X周 / X个月 / X年（支持中文数字与"两个星期"）
    m = t.match(/(\d+|[零一二两三四五六七八九十]+)\s*(个)?\s*(月|周|星期|礼拜|天|日|年)/);
    if (m) {
      var n = cn2num(m[1]);
      if (n > 0) return addDaysStr(n * (REL_UNIT[m[3]] || 1));
    }
    return '';
  }

  // 综合解析：名称 + 类别 + 房间 + 目标模块 + 关联收纳盒 + 保质期
  // boxes 传用户已录入的收纳盒（state.boxes），无则传 []
  function parse(text, boxes) {
    boxes = boxes || [];
    var c = classify(text);
    var room = roomFromText(text) || c.room;
    var boxId = findBoxId(text, boxes);
    var box = null;
    if (boxId) {
      for (var i = 0; i < boxes.length; i++) { if (boxes[i] && boxes[i].id === boxId) { box = boxes[i]; break; } }
    }
    if (box && box.room) room = box.room; // 盒子所属房间优先，保证与收纳模块一致
    return {
      name: cleanName(text),
      cat: c.cat,
      room: room,
      target: c.target,
      boxId: boxId || '',
      boxName: box ? box.name : '',
      expiry: parseExpiry(text)
    };
  }

  global.HClassify = {
    classify: classify, suggestBox: suggestBox, parse: parse,
    roomFromText: roomFromText, parseExpiry: parseExpiry,
    extractLocation: extractLocation, unknownLocation: unknownLocation
  };
})(window);
