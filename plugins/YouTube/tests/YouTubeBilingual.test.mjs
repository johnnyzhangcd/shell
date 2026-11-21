import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {test} from 'node:test';

const root = new URL('../', import.meta.url);
const source = fs.readFileSync(new URL('src/YouTubeBilingual.js', root), 'utf8');
const published = fs.readFileSync(new URL('dist/response.min.js', root), 'utf8');
const translation = fs.readFileSync(new URL('src/YouTubeTranslation.js', root), 'utf8');
const requestBundle = fs.readFileSync(new URL('dist/request.min.js', root), 'utf8');
const TOKEN = 'token-0123456789abcdef';
const SRV3 = '<?xml version="1.0" encoding="utf-8" ?><timedtext format="3"><body><p t="0" d="900">Hi</p></body></timedtext>';

/**
 * 功能：运行双语响应脚本，模拟后端返回；记录发出的请求。
 * 更新时间：2026-11-21
 */
function run(code, {url = 'https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=en&fmt=srv3&sig=PRIVATE', args = {}, reply, status = 200, body = SRV3} = {}) {
  let calls = 0, result;
  const sent = [];
  vm.runInNewContext(code, {
    $request: {url, method: 'GET', headers: {}},
    $response: {status, headers: {'Content-Type': 'text/xml'}, body},
    $argument: {translation_enabled: true, bilingual_backend: 'https://sub.example.com/', bilingual_token: TOKEN, translation_target: 'zh-CN', ...args},
    $persistentStore: {read() { return null; }, write() { throw Error('不应写存储'); }},
    $httpClient: {post(options, callback) { sent.push(options); const r = reply ?? [null, {status: 200}, JSON.stringify({body: 'BILINGUAL', done: true})]; callback(...r); }},
    console: {log() {}},
    $done(value) { calls++; result = value; }
  }, {timeout: 1000});
  assert.equal(calls, 1);
  return {result: JSON.parse(JSON.stringify(result)), sent};
}

for (const code of [source, published]) {
  const variant = code === source ? '源码' : '压缩入口';
  test(`${variant} 把原文字幕发给后端并替换为双语正文`, () => {
    const {result, sent} = run(code);
    assert.deepEqual(result, {body: 'BILINGUAL'});
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, 'https://sub.example.com/api/mobile/timedtext');
    assert.equal(sent[0].headers.Authorization, 'Bearer ' + TOKEN);
    const payload = JSON.parse(sent[0].body);
    assert.deepEqual({...payload, body: undefined}, {video_id: 'abcdefghijk', lang: 'en', target: 'zh-CN', body: undefined, wait: 10, display: 'translation'});
    assert.equal(payload.body, SRV3);
    assert.ok(!sent[0].body.includes('PRIVATE'), '不发送字幕签名');
  });
  test(`${variant} 后端失败、拒绝令牌或返回直通时保留原字幕`, () => {
    for (const reply of [['timeout', null, null], [null, {status: 401}, '{"error":"unauthorized"}'], [null, {status: 200}, '{"passthrough":true}'], [null, {status: 200}, 'not json']]) {
      assert.deepEqual(run(code, {reply}).result, {});
    }
  });
  test(`${variant} 未开启、缺少配置、中文轨道、机翻轨道和非 200 不请求后端`, () => {
    for (const options of [
      {args: {translation_enabled: false}},
      {args: {bilingual_backend: ''}},
      {args: {bilingual_backend: 'http://sub.example.com'}},
      {args: {bilingual_token: 'short'}},
      {url: 'https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=zh-Hans'},
      {url: 'https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=zh-Hant'},
      {url: 'https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=en&tlang=zh-Hans'},
      {url: 'https://www.youtube.com/api/timedtext?lang=en'},
      {url: 'https://evil.example/api/timedtext?v=abcdefghijk&lang=en'},
      {status: 404},
      {body: ''}
    ]) {
      const {result, sent} = run(code, options);
      assert.deepEqual(result, {});
      assert.equal(sent.length, 0, JSON.stringify(options));
    }
  });
  test(`${variant} 目标为英文时英文轨道直通、其他语言照常请求`, () => {
    assert.equal(run(code, {args: {translation_target: 'en-US'}}).sent.length, 0);
    const {sent} = run(code, {args: {translation_target: 'en-US'}, url: 'https://m.youtube.com/api/timedtext?v=abcdefghijk&lang=ja'});
    assert.equal(JSON.parse(sent[0].body).target, 'en-US');
  });
}

function request(code, url, args) {
  let result;
  vm.runInNewContext(code, {$request: {url, method: 'GET'}, $argument: args, $persistentStore: {read() { return null; }, write() { return true; }}, $done(v) { result = v; }}, {timeout: 1000});
  return JSON.parse(JSON.stringify(result));
}

for (const code of [translation, requestBundle]) {
  const variant = code === translation ? '源码' : '压缩入口';
  test(`${variant} 填写后端时请求原文字幕（去掉 tlang），留空则用原生翻译，关闭则不改`, () => {
    const url = 'https://www.youtube.com/api/timedtext?v=abc&lang=ja&tlang=zh-Hans&fmt=srv3&sig=xyz';
    const ai = {translation_enabled: true, translation_target: 'zh-CN', bilingual_backend: 'https://sub.example.com', bilingual_token: TOKEN};
    assert.deepEqual(request(code, url, ai), {url: 'https://www.youtube.com/api/timedtext?v=abc&lang=ja&fmt=srv3&sig=xyz'});
    assert.deepEqual(request(code, 'https://www.youtube.com/api/timedtext?v=abc&lang=ja', ai), {});
    assert.deepEqual(request(code, 'https://www.youtube.com/api/timedtext?lang=ja&tlang=zh-Hans&sparams=expire%2Ctlang', ai), {});
    assert.deepEqual(request(code, 'https://www.youtube.com/api/timedtext?v=abc&lang=ja', {...ai, bilingual_backend: ''}), {url: 'https://www.youtube.com/api/timedtext?v=abc&lang=ja&tlang=zh-Hans'});
    assert.deepEqual(request(code, url, {...ai, translation_enabled: false}), {});
  });
}

test('插件只有一个字幕翻译开关：请求和响应规则都由它启用并传入后端和令牌', () => {
  const plugin = fs.readFileSync(new URL('YouTubeNoAds.plugin', root), 'utf8');
  for (const key of ['bilingual_backend = input,"",', 'bilingual_token = input,"",']) assert.ok(plugin.includes(key));
  assert.ok(!plugin.includes('bilingual_enabled') && !plugin.includes('bilingual_display'));
  const lines = plugin.split('\n');
  const req = lines.find(l => l.includes('tag=YouTube 字幕目标语言'));
  assert.match(req, /^http-request .*request\.min\.js,requires-body=false,.*enable=\{translation_enabled\},argument=\[\{translation_enabled\},\{translation_target\},\{bilingual_backend\},\{bilingual_token\}\]/);
  const resp = lines.find(l => l.includes('tag=YouTube AI 字幕翻译'));
  assert.match(resp, /^http-response .*response\.min\.js,requires-body=true,timeout=35,enable=\{translation_enabled\},argument=\[\{translation_enabled\},\{translation_target\},\{bilingual_backend\},\{bilingual_token\}\]/);
  assert.ok(!/bilingual_token = input,"[^"]/.test(plugin), '令牌不能有默认值');
});
