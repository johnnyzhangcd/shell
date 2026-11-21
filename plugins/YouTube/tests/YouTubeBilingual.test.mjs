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
    $argument: {bilingual_enabled: true, bilingual_backend: 'https://sub.example.com/', bilingual_token: TOKEN, translation_target: 'zh-CN', ...args},
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
    assert.deepEqual({...payload, body: undefined}, {video_id: 'abcdefghijk', lang: 'en', target: 'zh-CN', body: undefined, wait: 20});
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
      {args: {bilingual_enabled: false}},
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
  test(`${variant} 双语模式请求原文字幕：去掉 tlang，优先于原生翻译`, () => {
    const url = 'https://www.youtube.com/api/timedtext?v=abc&lang=ja&tlang=zh-Hans&fmt=srv3&sig=xyz';
    assert.deepEqual(request(code, url, {bilingual_enabled: true}), {url: 'https://www.youtube.com/api/timedtext?v=abc&lang=ja&fmt=srv3&sig=xyz'});
    assert.deepEqual(request(code, url, {bilingual_enabled: 'true', translation_enabled: true, translation_target: 'zh-CN'}), {url: 'https://www.youtube.com/api/timedtext?v=abc&lang=ja&fmt=srv3&sig=xyz'});
    assert.deepEqual(request(code, 'https://www.youtube.com/api/timedtext?v=abc&lang=ja', {bilingual_enabled: true}), {});
    assert.deepEqual(request(code, 'https://www.youtube.com/api/timedtext?lang=ja&tlang=zh-Hans&sparams=expire%2Ctlang', {bilingual_enabled: true}), {});
  });
}

test('插件的双语规则：请求去 tlang 在原生翻译前，响应读取正文并传入后端和令牌参数', () => {
  const plugin = fs.readFileSync(new URL('YouTubeNoAds.plugin', root), 'utf8');
  for (const key of ['bilingual_enabled = switch,false,', 'bilingual_backend = input,"",', 'bilingual_token = input,"",']) assert.ok(plugin.includes(key));
  const lines = plugin.split('\n');
  const strip = lines.findIndex(l => l.includes('tag=YouTube 双语字幕请求原文'));
  const native = lines.findIndex(l => l.includes('tag=YouTube 字幕目标语言'));
  assert.ok(strip >= 0 && strip < native);
  assert.match(lines[strip], /^http-request .*request\.min\.js,requires-body=false,.*enable=\{bilingual_enabled\}/);
  const resp = lines.find(l => l.includes('tag=YouTube 中英双语字幕'));
  assert.match(resp, /^http-response .*response\.min\.js,requires-body=true,timeout=35,enable=\{bilingual_enabled\},argument=\[\{bilingual_enabled\},\{translation_target\},\{bilingual_backend\},\{bilingual_token\}\]/);
  assert.ok(!/bilingual_token = input,"[^"]/.test(plugin), '令牌不能有默认值');
});
