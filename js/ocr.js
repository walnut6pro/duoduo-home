/* ocr.js —— 小票拍照识字
 * 懒加载 tesseract.js（仅在第一次拍照时联网下载，之后被浏览器缓存）；
 * 识别中文小票用 chi_sim+eng 语言包。无网络时会失败并提示。
 */
(function (global) {
  'use strict';
  var CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
  var loading = null;

  function load() {
    if (global.Tesseract) return Promise.resolve(global.Tesseract);
    if (loading) return loading;
    loading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = CDN;
      s.onload = function () {
        global.Tesseract ? resolve(global.Tesseract) : reject(new Error('识别引擎加载异常'));
      };
      s.onerror = function () {
        loading = null;
        reject(new Error('无法加载识别引擎，请检查网络后重试'));
      };
      document.head.appendChild(s);
    });
    return loading;
  }

  // file: File 对象；onProgress(status, progress)
  function recognize(file, onProgress) {
    return load().then(function (T) {
      return T.recognize(file, 'chi_sim+eng', {
        logger: function (m) {
          if (onProgress && m && m.status) onProgress(m.status, m.progress || 0);
        }
      });
    }).then(function (r) {
      return (r && r.data && r.data.text) || '';
    });
  }

  global.HOcr = { recognize: recognize, ready: function () { return !!global.Tesseract; } };
})(window);
