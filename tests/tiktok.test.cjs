const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
require('../extension/core.js');
const C = globalThis.DYCore;
const author = 'tiktok:creator.test';
const item = (overrides = {}) => ({ id: '7700569887021763854', desc: 'Lesson 96\nFull description', createTime: 1792920000,
  author: { uniqueId: 'Creator.Test', secUid: 'SEC_PUBLIC', nickname: 'Creator' },
  stats: { diggCount: 0, shareCount: 5, commentCount: 3, playCount: 100 }, statsV2: { diggCount: '0', shareCount: '5', commentCount: '3' },
  video: { downloadAddr: 'https://v16-webapp-prime.us.tiktok.com/video/download.mp4', playAddr: 'https://v16-webapp-prime.us.tiktok.com/video/play.mp4',
    PlayAddrStruct: { UrlList: ['https://v19-webapp-prime.us.tiktok.com/video/play.mp4'] },
    bitrateInfo: [{ CodecType: 'h264', PlayAddr: { UrlList: ['https://v16m.tiktokcdn.com/video/rate.mp4'] } }],
    bitrateAudioInfo: [{ UrlList: { MainUrl: 'https://v16-webapp-prime.us.tiktok.com/audio' } }] }, ...overrides });

test('TikTok profile URL matching excludes video, live, unrelated and spoofed pages', () => {
  assert.equal(C.authorFromURL('https://www.tiktok.com/@Creator.Test/?lang=en'), author);
  for (const url of ['https://www.tiktok.com/', 'https://www.tiktok.com/foryou', 'https://www.tiktok.com/@creator.test/video/12345', 'https://www.tiktok.com/@creator.test/live', 'https://www.tiktok.com.evil.test/@creator.test', 'http://www.tiktok.com/@creator.test']) assert.equal(C.authorFromURL(url), '');
  assert.equal(C.profileURL(author), 'https://www.tiktok.com/@creator.test');
  assert.equal(C.platformFor(author), 'TikTok');
});
test('TikTok normalizes actual camelCase fields and V2 numeric strings without retaining plays', () => {
  const row = C.normalize(item(), author);
  assert.equal(row.id, '7700569887021763854'); assert.equal(row.likes, 0); assert.equal(row.shares, 5); assert.equal(row.comments, 3);
  assert.equal(row.title, 'Lesson 96'); assert.equal(row.description, 'Lesson 96\nFull description');
  assert.equal(row.url, 'https://www.tiktok.com/@Creator.Test/video/7700569887021763854');
  assert.equal(row.candidates.length, 4); assert.equal(row.candidates.some(u => u.endsWith('/audio')), false);
  assert.equal('playCount' in row, false); assert.equal('stats' in row, false);
  const exported = C.exportRows([row]); assert.equal(exported[1][8], row.url); assert.equal(exported[0].some(h => h.includes('播放')), false);
});
test('TikTok rejects other authors and unsafe IDs, skips photo posts, preserves missing metrics', () => {
  assert.equal(C.normalize(item({ author: { uniqueId: 'other' } }), author), null);
  assert.equal(C.normalize(item({ author: {} }), author), null);
  assert.equal(C.normalize(item({ id: Number('7700569887021763854') }), author), null);
  assert.equal(C.normalize(item({ imagePost: { images: [{}] } }), author).image, true);
  const row = C.normalize(item({ statsV2: undefined, stats: { diggCount: 0 } }), author);
  assert.equal(row.likes, 0); assert.equal(row.shares, null);
  assert.deepEqual(C.normalize(item({ video: { PlayAddrStruct: { UrlList: {} } } }), author).candidates, []);
});
test('TikTok download URLs are restricted to video CDNs and cannot cross platform boundaries', () => {
  for (const url of ['https://www.tiktok.com/api/post/item_list/', 'https://evil.tiktok.com/x', 'https://v16-webapp-prime.us.tiktok.com.evil.test/x', 'https://v16.tiktokcdn.com:3000/x', 'https://x:y@v16.tiktokcdn.com/x', 'http://v16.tiktokcdn.com/x', 'https://v3.douyinvod.com/x']) assert.equal(C.downloadURL(url, author), '');
  for (const url of ['https://v16-webapp-prime.us.tiktok.com/x', 'https://v19-webapp-prime.tiktok.com/x', 'https://v16m.tiktokcdn-us.com/x', 'https://v16m.tiktokcdn.com/x']) assert.equal(C.downloadURL(url, author), url);
  assert.equal(C.downloadURL('https://v16-webapp-prime.us.tiktok.com/x', 'douyin-author'), '');
});
test('TikTok pagination validates camelCase status, explicit completion and cursor progress', () => {
  const page = C.validatePage({ statusCode: 0, itemList: [item()], hasMore: true, cursor: '1791072327537' });
  assert.equal(page.aweme_list.length, 1); assert.equal(page.has_more, true);
  assert.deepEqual(C.pageDecision(page, '0', new Set(['0']), 0), { complete: false, next: '1791072327537' });
  assert.equal(C.pageDecision({ statusCode: 0, hasMore: false, cursor: 0 }, '1', new Set(), 1).complete, true);
  assert.throws(() => C.validatePage({ statusCode: 0, hasMore: true, cursor: 1 }), /列表缺失/);
  assert.throws(() => C.validatePage({ statusCode: 0, itemList: [] }), /分页状态缺失/);
  assert.throws(() => C.validatePage({ statusCode: 10216, hasMore: false, itemList: [] }));
  assert.throws(() => C.pageDecision({ ...page, max_cursor: '0' }, '0', new Set(), 0), /重复/);
});

function bridgeSetup({ hydration = true, empty = false } = {}) {
  const messages = [], calls = [], listeners = {};
  const location = { href: 'https://www.tiktok.com/@creator.test', origin: 'https://www.tiktok.com', pathname: '/@creator.test' };
  const userInfo = { user: { uniqueId: 'creator.test', secUid: 'SEC_PUBLIC', nickname: 'Creator' }, stats: { videoCount: 60 } };
  const document = { getElementById: () => hydration ? { textContent: JSON.stringify({ __DEFAULT_SCOPE__: { 'webapp.user-detail': { userInfo } } }) } : null };
  const data = { statusCode: 0, itemList: [item()], hasMore: true, cursor: '100' };
  const window = { postMessage: m => messages.push(m), addEventListener: (name, fn) => { listeners[name] = fn; },
    fetch: async (url, options) => { calls.push({ url, options }); const value = url.includes('/api/user/detail/') ? { statusCode: 0, userInfo } : data;
      return { ok: true, json: async () => { if (empty) throw new SyntaxError('empty'); return value; }, clone: () => ({ json: async () => value }) }; } };
  class XHR { open() {} send() {} addEventListener() {} }
  vm.runInNewContext(fs.readFileSync(require.resolve('../extension/tiktok-bridge.js'), 'utf8'), { window, document, location, XMLHttpRequest: XHR, URL, AbortController, DOMException, setTimeout, clearTimeout });
  const send = m => listeners.message({ source: window, origin: location.origin, data: { channel: 'dy-worklist-v1', from: 'extension', ...m } });
  return { messages, calls, listeners, location, window, send, data };
}
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
test('TikTok bridge uses fixed signed-by-site requests and public hydration for profile', async () => {
  const s = bridgeSetup();
  await s.send({ type: 'request', kind: 'profile', id: 'p', author, cursor: '0' });
  assert.equal(s.calls.length, 0); assert.equal(s.messages[0].data.user.aweme_count, 60);
  await s.send({ type: 'request', kind: 'posts', id: 'r', author, cursor: '123' });
  const url = new URL(s.calls[0].url);
  assert.equal(url.origin, 'https://www.tiktok.com'); assert.equal(url.pathname, '/api/post/item_list/');
  assert.equal(url.searchParams.get('secUid'), 'SEC_PUBLIC'); assert.equal(url.searchParams.get('cursor'), '123');
  assert.equal(s.calls[0].options.credentials, 'include');
  await s.send({ type: 'request', kind: 'url', id: 'bad', author, cursor: '0', url: 'https://evil.test/' });
  await s.send({ type: 'request', kind: 'posts', id: 'wrong', author: 'tiktok:other', cursor: '0' });
  assert.equal(s.calls.length, 1);
});
test('TikTok bridge reuses bounded site parameters but never replays signatures, tokens or arbitrary destinations', async () => {
  const s = bridgeSetup();
  await s.window.fetch('https://www.tiktok.com/api/post/item_list/?secUid=SEC_PUBLIC&device_id=123&region=US&X-Bogus=secret&X-Gnarly=secret&msToken=secret&url=https://evil.test/&cursor=999&post_item_list_request_type=2');
  await s.send({ type: 'request', kind: 'posts', id: 'r', author, cursor: '123' });
  const url = new URL(s.calls.at(-1).url);
  assert.equal(url.searchParams.get('device_id'), '123'); assert.equal(url.searchParams.get('region'), 'US');
  for (const key of ['X-Bogus', 'X-Gnarly', 'msToken', 'url']) assert.equal(url.searchParams.has(key), false);
  assert.equal(url.searchParams.get('cursor'), '123'); assert.equal(url.searchParams.get('post_item_list_request_type'), '0');
  await s.send({ type: 'reset' });
  await s.send({ type: 'request', kind: 'posts', id: 'new', author, cursor: '0' });
  assert.equal(new URL(s.calls.at(-1).url).searchParams.has('device_id'), false);
});
test('TikTok bridge observes only the current creator posts while enabled, without response backlog', async () => {
  const s = bridgeSetup();
  const url = 'https://www.tiktok.com/api/post/item_list/?secUid=SEC_PUBLIC';
  await s.window.fetch(url); await settle(); assert.equal(s.messages.length, 0);
  await s.send({ type: 'observe', enabled: true });
  await s.window.fetch(url); await settle(); assert.equal(s.messages.length, 1);
  await s.window.fetch('https://www.tiktok.com/api/repost/item_list/?secUid=SEC_PUBLIC');
  await s.window.fetch('https://www.tiktok.com/api/post/item_list/?secUid=OTHER');
  await s.window.fetch('https://evil.test/api/post/item_list/?secUid=SEC_PUBLIC'); await settle();
  assert.equal(s.messages.length, 1);
  await s.send({ type: 'observe', enabled: false }); await s.window.fetch(url); await settle(); assert.equal(s.messages.length, 1);
});
test('TikTok SPA profiles resolve fresh public user info instead of reusing the old creator template', async () => {
  const s = bridgeSetup({ hydration: false });
  await s.send({ type: 'request', kind: 'posts', id: 'r', author, cursor: '0' });
  assert.equal(new URL(s.calls[0].url).pathname, '/api/user/detail/'); assert.equal(s.calls.length, 2);
  s.location.pathname = '/explore'; s.location.href = 'https://www.tiktok.com/explore';
  await s.send({ type: 'request', kind: 'posts', id: 'bad', author, cursor: '0' }); assert.equal(s.calls.length, 2);
  s.location.pathname = '/@other'; s.location.href = 'https://www.tiktok.com/@other';
  await s.send({ type: 'request', kind: 'posts', id: 'other', author: 'tiktok:other', cursor: '0' });
  assert.match(s.messages.at(-1).error, /资料未就绪/); assert.equal(s.calls.length, 3);
});
test('TikTok empty HTTP 200 response is a failure and cannot imply no videos', async () => {
  const s = bridgeSetup({ empty: true });
  await s.send({ type: 'request', kind: 'posts', id: 'r', author, cursor: '0' });
  assert.match(s.messages.at(-1).error, /空响应/); assert.equal(s.messages.at(-1).data, undefined);
});
