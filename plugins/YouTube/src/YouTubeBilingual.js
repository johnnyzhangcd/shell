/**
 * 作者：Johnny 自用
 * 文件：YouTubeBilingual.js
 * 功能：把 App 刚下载的原文字幕交给自建 yt-bilingual 后端，换回同格式的译文字幕（手机屏幕小，只显示译文，没译完的条目先显示原文）。
 * 更新时间：2026-11-21
 * 运行环境：Loon JavaScript（响应阶段，需要正文）
 */

/**
 * 功能：读取查询参数，不改动其余签名参数。
 * 更新时间：2026-11-21
 * @param {string} url 字幕请求地址。
 * @param {string} name 参数名（小写）。
 * @returns {string|null} 解码后的首个值；缺失或编码无效时为空值。
 */
function ytBilingualQuery(url, name) {
  var question = url.indexOf('?');
  if (question < 0) return null;
  var pieces = url.slice(question + 1).split('#')[0].split('&');
  for (var i = 0; i < pieces.length; i++) {
    var equal = pieces[i].indexOf('=');
    var key = equal < 0 ? pieces[i] : pieces[i].slice(0, equal);
    if (key.toLowerCase() !== name) continue;
    try { return decodeURIComponent(equal < 0 ? '' : pieces[i].slice(equal + 1).replace(/\+/g, '%20')); }
    catch (_) { return null; }
  }
  return null;
}

/**
 * 功能：只接受 HTTPS 根地址作为后端，避免令牌经明文或拼接错误的地址发出。
 * 更新时间：2026-11-21
 * @param {unknown} value 插件参数中的后端地址。
 * @returns {string|null} 去掉末尾斜杠的地址；无效时为空值。
 */
function ytBilingualBackend(value) {
  if (typeof value !== 'string') return null;
  var url = value.trim().replace(/\/+$/, '');
  return /^https:\/\/[a-z0-9.-]+(?::\d{1,5})?(?:\/[\w.-]+)*$/i.test(url) ? url : null;
}

/**
 * 功能：判断字幕轨道是否已是目标语言；中文视频不做双语，保持 App 原字幕。
 * 更新时间：2026-11-21
 * @param {string} lang 字幕轨道语言。
 * @param {string} target 目标语言。
 * @returns {boolean} 同语言时为真。
 */
function ytBilingualSameLanguage(lang, target) {
  var a = lang.toLowerCase(), b = target.toLowerCase();
  return b.indexOf('zh') === 0 ? a.indexOf('zh') === 0 : a.split('-')[0] === b.split('-')[0];
}

/**
 * 功能：响应阶段处理 /api/timedtext；任何条件不满足或后端失败时原样放行原字幕。
 * 更新时间：2026-11-21
 * @returns {void} 每次只调用一次完成接口。
 */
function ytBilingualMain() {
  var request = typeof $request === 'object' && $request ? $request : null;
  var response = typeof $response === 'object' && $response ? $response : null;
  var args = typeof $argument === 'object' && $argument ? $argument : {};
  var enabled = args.translation_enabled === true || args.translation_enabled === 'true';
  var backend = ytBilingualBackend(args.bilingual_backend);
  var token = typeof args.bilingual_token === 'string' ? args.bilingual_token.trim() : '';
  if (!request || !response || !enabled || !backend || !/^[\x21-\x7e]{16,256}$/.test(token) || typeof $httpClient === 'undefined') return $done({});
  var url = String(request.url || '');
  if (!/^https:\/\/(?:www\.|m\.)?youtube\.com\/api\/timedtext\?[^#]+$/i.test(url)) return $done({});
  if (Number(response.status || response.statusCode || 200) !== 200) return $done({});
  var body = response.body;
  if (typeof body !== 'string' || !body || body.length > 8 * 1024 * 1024) return $done({});
  var video = ytBilingualQuery(url, 'v'), lang = ytBilingualQuery(url, 'lang');
  var target = String(args.translation_target || 'zh-CN').toLowerCase() === 'en-us' ? 'en-US' : 'zh-CN';
  // 已经是 YouTube 机器翻译的字幕（tlang）不再叠加；视频 ID 与语言码格式不对时不发请求。
  if (ytBilingualQuery(url, 'tlang') || !video || !/^[\w-]{6,20}$/.test(video) || !lang || !/^[a-z0-9-]{1,20}$/i.test(lang)) return $done({});
  if (ytBilingualSameLanguage(lang, target)) return $done({});
  var finished = false;
  var finish = /** 功能：保证只提交一次。更新时间：2026-11-21。 */ function (value) { if (!finished) { finished = true; $done(value); } };
  $httpClient.post({
    url: backend + '/api/mobile/timedtext',
    headers: {'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token},
    body: JSON.stringify({video_id: video, lang: lang, target: target, body: body, wait: 10, display: 'translation'}),
    timeout: 30000
  }, /** 功能：用后端结果替换正文；失败时保留原字幕。更新时间：2026-11-21。 */ function (error, resp, data) {
    try {
      var status = resp ? Number(resp.status || resp.statusCode) : 0;
      if (error || status !== 200 || typeof data !== 'string') {
        if (status === 401 && typeof console !== 'undefined') console.log('YouTube 双语字幕：后端拒绝令牌');
        return finish({});
      }
      var result = JSON.parse(data);
      if (!result || typeof result.body !== 'string' || !result.body) return finish({});
      finish({body: result.body});
    } catch (_) { finish({}); }
  });
}

if (typeof $done === 'function') ytBilingualMain();
