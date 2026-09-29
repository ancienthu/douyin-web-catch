const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
require('../extension/core.js');
function setup(probe) {
  const probes = [];
  const store = {}, downloads = [], reports = [], items = {}, handlers = {};
  const chrome = {
    runtime: { id: 'test-extension', onMessage: { addListener: fn => { handlers.message = fn; } } },
    storage: { session: {
      get: async k => k === null ? { ...store } : { [k]: store[k] },
      set: async values => Object.assign(store, values), remove: async keys => { for (const k of [keys].flat()) delete store[k]; }
    } },
    downloads: {
      download: async options => { const id = downloads.length + 1; downloads.push(options); items[id] = { id, state: 'in_progress' }; return id; },
      search: async ({ id }) => items[id] ? [items[id]] : [], onChanged: { addListener: fn => { handlers.change = fn; } }
    },
    tabs: { sendMessage: async (tab, message) => reports.push({ tab, ...message }), onRemoved: { addListener: () => {} } }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../extension/background.js'), 'utf8'), { chrome, importScripts() {}, DYCore: globalThis.DYCore, console, Date, Set, URL, AbortController, setTimeout, clearTimeout,
    fetch: async (url, options) => {
      probes.push({ url, options });
      if (probe) return probe(url, options);
      return new Response(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]), { status: 206, headers: { 'Content-Type': 'video/mp4' } });
    } });
  const sender = { id: 'test-extension', frameId: 0, tab: { id: 7 }, url: 'https://www.douyin.com/user/author-test' };
  const send = message => new Promise(resolve => handlers.message({ author: 'author-test', ...message }, sender, resolve));
  return { downloads, reports, items, send, handlers, sender, probes };
}
const record = { id: '7690524354895421946', title: '../测试视频', candidates: ['https://v1.douyinvod.com/one', 'https://v2.douyinvod.com/two'] };
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };
test('downloads require registered records and reject unsupported hosts', async () => {
  const s = setup();
  assert.equal((await s.send({ type: 'download', id: record.id })).ok, false);
  assert.equal((await s.send({ type: 'register-download', record: { ...record, candidates: ['https://evil.test/a'] } })).ok, false);
  assert.equal(s.downloads.length, 0);
});
test('accepted download is in_progress until Chrome reports completion', async () => {
  const s = setup();
  assert.equal((await s.send({ type: 'register-download', record })).ok, true);
  assert.equal((await s.send({ type: 'download', id: record.id })).ok, true);
  assert.equal(s.reports.at(-1).state, 'in_progress');
  s.items[1] = { state: 'complete', mime: 'video/mp4' };
  s.handlers.change({ id: 1, state: { current: 'complete' } }); await settle();
  assert.equal(s.reports.at(-1).state, 'complete');
  assert.match(s.downloads[0].filename, /^抖音作品\//);
  assert.doesNotMatch(s.downloads[0].filename, /\.\.\//);
});
test('interrupted download retries another candidate but user cancellation does not', async () => {
  const s = setup();
  await s.send({ type: 'register-download', record }); await s.send({ type: 'download', id: record.id });
  s.handlers.change({ id: 1, state: { current: 'interrupted' }, error: { current: 'SERVER_FORBIDDEN' } }); await settle();
  assert.equal(s.downloads.length, 2); assert.equal(s.downloads[1].url, record.candidates[1]);
  s.items[2] = { state: 'interrupted', error: 'USER_CANCELED' };
  s.handlers.change({ id: 2, state: { current: 'interrupted' } }); await settle();
  assert.equal(s.downloads.length, 2); assert.equal(s.reports.at(-1).error, '下载已取消。');
});
test('HTML error pages fall back to another candidate and never report video success', async () => {
  const s = setup();
  await s.send({ type: 'register-download', record }); await s.send({ type: 'download', id: record.id });
  s.items[1] = { state: 'complete', mime: 'text/html' };
  s.handlers.change({ id: 1, state: { current: 'complete' } }); await settle();
  assert.equal(s.downloads.length, 2); assert.equal(s.reports.at(-1).state, 'in_progress');
  s.items[2] = { state: 'complete', mime: 'text/html' };
  s.handlers.change({ id: 2, state: { current: 'complete' } }); await settle();
  assert.equal(s.reports.at(-1).state, 'interrupted'); assert.match(s.reports.at(-1).error, /不是有效视频/);
});
test('background reorders legacy records so CDN is attempted before the forbidden play endpoint', async () => {
  const s = setup();
  await s.send({ type: 'register-download', record: { ...record, candidates: ['https://www.douyin.com/aweme/v1/play/?video_id=abc', record.candidates[0]] } });
  await s.send({ type: 'download', id: record.id });
  assert.equal(s.downloads[0].url, record.candidates[0]);
  assert.equal(s.downloads[0].headers[0].name, 'Accept');
});

test('forbidden CDN and HTML responses are skipped before creating a Chrome download', async () => {
  let attempt = 0;
  const s = setup(() => {
    attempt++;
    if (attempt === 1) return new Response('<html>Forbidden</html>', { status: 403 });
    if (attempt === 2) return new Response('<html>Error</html>', { headers: { 'Content-Type': 'text/html' } });
    return new Response(new Uint8Array([0,0,0,24,102,116,121,112,105,115,111,109]), { status: 206 });
  });
  await s.send({ type: 'register-download', record: { ...record, candidates: [...record.candidates, 'https://v11-weba.douyinvod.com/good'] } });
  await s.send({ type: 'download', id: record.id });
  assert.equal(s.probes.length, 3);
  assert.equal(s.downloads.length, 1);
  assert.equal(s.downloads[0].url, 'https://v11-weba.douyinvod.com/good');
  assert.equal(s.probes[0].options.credentials, 'omit');
  assert.equal(s.probes[0].options.redirect, 'error');
  assert.equal(s.probes[0].options.headers.Range, 'bytes=0-31');
});
test('HTML disguised as binary never creates download tasks', async () => {
  const s = setup(() => new Response('<html>not video</html>', { headers: { 'Content-Type': 'application/octet-stream' } }));
  await s.send({ type: 'register-download', record });
  await s.send({ type: 'download', id: record.id });
  assert.equal(s.downloads.length, 0);
  assert.equal(s.reports.at(-1).state, 'interrupted');
});
test('network errors fail closed and non-CDN endpoints are never fetched', async () => {
  const s = setup(() => { throw new Error('network failure'); });
  await s.send({ type: 'register-download', record: { ...record, candidates: [...record.candidates, 'https://www.douyin.com/aweme/v1/play/?video_id=abc'] } });
  await s.send({ type: 'download', id: record.id });
  assert.equal(s.probes.length, 2);
  assert.equal(s.downloads.length, 0);
  assert.equal(s.reports.at(-1).state, 'interrupted');
});
test('probe accepts a split MP4 header and cancels a server that ignores Range', async () => {
  let canceled = false;
  const chunks = [new Uint8Array([0,0,0,24,102]), new Uint8Array([116,121,112,105,115,111,109])];
  const s = setup(() => new Response(new ReadableStream({
    pull(controller) { if (chunks.length) controller.enqueue(chunks.shift()); },
    cancel() { canceled = true; }
  }), { status: 200 }));
  await s.send({ type: 'register-download', record });
  await s.send({ type: 'download', id: record.id });
  assert.equal(canceled, true);
  assert.equal(s.downloads.length, 1);
});

test('empty MP4 responses never create download tasks', async () => {
  const s = setup(() => new Response(new Uint8Array(), { headers: { 'Content-Type': 'video/mp4' } }));
  await s.send({ type: 'register-download', record });
  await s.send({ type: 'download', id: record.id });
  assert.equal(s.downloads.length, 0);
  assert.equal(s.reports.at(-1).state, 'interrupted');
});
