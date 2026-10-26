/* speech.js —— 语音输入封装（Web Speech API）
 * iOS Safari 自 14.3 起支持 webkitSpeechRecognition，需用户点击触发、且需联网。
 * 识别为中文(zh-CN)，返回最终文本。失败/不支持时回调 onError。
 */
(function (global) {
  'use strict';
  var SR = global.SpeechRecognition || global.webkitSpeechRecognition;

  function supported() { return !!SR; }

  // 返回 { stop } 控制句柄
  // onEnd：识别自然结束（超时/静音）也会触发，用于把界面复位
  function start(onFinal, onError, onStart, onEnd) {
    if (!SR) { onError && onError({ error: 'not-supported' }); return null; }
    var rec = new SR();
    rec.lang = 'zh-CN';
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.continuous = false;
    var stopped = false;
    rec.onstart = function () { onStart && onStart(); };
    rec.onresult = function (e) {
      var txt = '';
      try { txt = e.results[0][0].transcript || ''; } catch (err) { txt = ''; }
      onFinal && onFinal(txt.trim());
    };
    rec.onerror = function (e) {
      var msg = e && e.error ? e.error : 'unknown';
      onError && onError({ error: msg });
    };
    rec.onend = function () { stopped = true; onEnd && onEnd(); };
    try { rec.start(); } catch (err) { onError && onError({ error: 'start-failed', detail: String(err) }); }
    return {
      stop: function () { try { if (!stopped) rec.stop(); } catch (e) {} }
    };
  }

  global.HSpeech = { supported: supported, start: start };
})(window);
