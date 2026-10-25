const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
require('../extension/core.js');
class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.events = {}; this.style = {}; this.attributes = {}; this.textContent = ''; this.value = ''; this.className = ''; this.hidden = false; this.classList = { add() {}, toggle() {}, contains() { return false; } }; }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.append(child); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(k, v) { this.attributes[k] = v; }
  addEventListener(type, fn) { this.events[type] = fn; }
  attachShadow() { this.shadow = new Element('shadow'); return this.shadow; }
  focus() {}
  remove() {}
  click() { return this.events.click?.({ isTrusted: true }); }
}
function setup(href = 'https://www.douyin.com/user/author-one') {
  const html = new Element('html'), windowEvents = {}, posted = [], timers = [], runtime = {}, interval = {};
  const location = { href, origin: 'https://www.douyin.com' };
  const window = { postMessage: m => posted.push(m), addEventListener: (name, fn) => { windowEvents[name] = fn; } };
  const document = { readyState: 'complete', documentElement: html, body: new Element('body'), createElement: tag => new Element(tag) };
  const context = { window, document, location, crypto: { randomUUID }, DYCore, DYXlsx: {}, chrome: { runtime: { sendMessage: async () => ({ ok: true }), onMessage: { addListener: fn => { runtime.message = fn; } } } }, AbortController, DOMException, URL,
    setTimeout: (fn, ms) => { const entry = { fn, ms }; timers.push(entry); return entry; }, clearTimeout: e => { if (e) e.cancelled = true; }, setInterval: fn => { interval.fn = fn; }, console };
  vm.runInNewContext(fs.readFileSync(require.resolve('../extension/content.js'), 'utf8'), context);
  const all = () => { const list = []; const walk = e => { list.push(e); if (e.shadow) walk(e.shadow); e.children.forEach(walk); }; walk(html); return list; };
  const send = m => windowEvents.message({ source: window, origin: location.origin, data: { channel: 'dy-worklist-v1', from: 'page', ...m } });
  const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); const due = timers.filter(t => t.ms === 80 && !t.cancelled); due.forEach(t => { t.cancelled = true; t.fn(); }); };
  return { html, all, posted, location, send, flush, interval, timers, windowEvents, button: text => all().find(e => e.tagName === 'button' && e.textContent === text) };
}
const item = (id, author = 'author-one') => ({ aweme_id: id, desc: '测试作品', author: { sec_uid: author, nickname: '作者' }, statistics: { digg_count: 1 }, video: {} });
const observed = (items, author = 'author-one') => ({ type: 'observed', author, path: '/aweme/v1/web/aweme/post', data: { status_code: 0, aweme_list: items, has_more: 0 } });
test('content deduplicates observations, skips images and resets immediately on author navigation', async () => {
  const s = setup();
  s.button('▤ 作品清单').click();
  s.send(observed([item('12345'), item('12345'), { ...item('54321'), images: [{}] }])); await s.flush();
  assert.equal(s.all().find(e => e.tagName === 'strong').textContent, '1');
  assert.ok(s.all().some(e => e.textContent.startsWith('1 条图文已跳过')));
  s.location.href = 'https://www.douyin.com/user/author-two'; s.interval.fn(); await s.flush();
  assert.equal(s.all().find(e => e.tagName === 'strong').textContent, '0');
  s.send(observed([item('67890')])); await s.flush();
  assert.equal(s.all().find(e => e.tagName === 'strong').textContent, '0');
});
test('stop disables passive collection', async () => {
  const s = setup(); s.button('停止').click();
  s.send(observed([item('12345')])); await s.flush();
  assert.equal(s.all().find(e => e.tagName === 'strong').textContent, '0');
  assert.ok(s.all().some(e => e.textContent === '已停止收集，保留当前结果。'));
});
test('late active response cannot populate the next author', async () => {
  const s = setup(); const running = s.button('读取全部').click();
  const req = s.posted.find(m => m.kind === 'posts'); assert.ok(req);
  s.location.href = 'https://www.douyin.com/user/author-two'; s.interval.fn();
  s.send({ type: 'response', id: req.id, author: 'author-one', data: { status_code: 0, aweme_list: [item('12345')], has_more: 0 } });
  await running; await s.flush();
  assert.equal(s.all().find(e => e.tagName === 'strong').textContent, '0');
});
test('a successful full refresh removes stale records and confirms final page', async () => {
  const s = setup(); s.button('▤ 作品清单').click(); s.send(observed([item('99999')])); await s.flush();
  const running = s.button('重新读取全部').click();
  const req = s.posted.find(m => m.kind === 'posts');
  s.send({ type: 'response', id: req.id, author: 'author-one', data: { status_code: 0, aweme_list: [item('12345')], has_more: 0 } });
  await running; await s.flush();
  assert.equal(s.all().find(e => e.tagName === 'strong').textContent, '1');
  assert.ok(s.all().some(e => e.textContent.startsWith('读取结束：')));
  assert.equal(s.all().filter(e => e.tagName === 'a' && e.href?.includes('/video/99999')).length, 0);
});
test('closing and reopening the panel keeps records and never schedules timed cleanup', async () => {
  const s = setup(); s.button('▤ 作品清单').click();
  s.send(observed([item('12345')])); await s.flush();
  s.button('关闭 ×').click(); await s.flush();
  assert.equal(s.all().find(e => e.tagName === 'strong').textContent, '1');
  assert.equal(s.timers.some(t => t.ms >= 600000), false);
  s.button('▤ 作品清单').click(); await s.flush();
  assert.equal(s.all().find(e => e.tagName === 'strong').textContent, '1');
});
test('manual clear and pagehide release records and ignore late passive data', async () => {
  for (const action of ['clear', 'pagehide']) {
    const s = setup(); s.button('▤ 作品清单').click();
    s.send(observed([item('12345')])); await s.flush();
    if (action === 'clear') s.button('清理数据').click(); else s.windowEvents.pagehide();
    s.send(observed([item('67890')])); await s.flush();
    assert.equal(s.all().find(e => e.tagName === 'strong').textContent, '0');
    assert.equal(s.all().filter(e => e.tagName === 'a' && e.href?.includes('/video/')).length, 0);
  }
});
test('search covers records on other in-memory pages and pagination makes no network request', async () => {
  const s = setup(); s.button('▤ 作品清单').click();
  s.send(observed(Array.from({ length: 60 }, (_, i) => ({ ...item(String(10000 + i)), desc: `文案${i}` })))); await s.flush();
  const before = s.posted.filter(m => m.type === 'request').length;
  s.button('下一页').click(); await s.flush();
  assert.equal(s.posted.filter(m => m.type === 'request').length, before);
  const input = s.all().find(e => e.tagName === 'input'); input.value = '文案0'; input.events.input(); await s.flush();
  assert.ok(s.all().some(e => e.tagName === 'a' && e.textContent === '文案0'));
  assert.ok(s.all().some(e => e.textContent === '导出 Excel (1)'));
  assert.equal(s.all().some(e => e.tagName === 'th' && e.textContent.includes('播放')), false);
});
test('clearing during a request cancels it and late data cannot restore the list', async () => {
  const s = setup(); const running = s.button('读取全部').click();
  const req = s.posted.find(m => m.kind === 'posts');
  s.button('清理数据').click();
  s.send({ type: 'response', id: req.id, author: 'author-one', data: { status_code: 0, aweme_list: [item('12345')], has_more: 0 } });
  await running; await s.flush();
  assert.equal(s.all().find(e => e.tagName === 'strong').textContent, '0');
});
test('active reader requests all pages automatically and closing the panel does not clear or abort it', async () => {
  const s = setup(); const running = s.button('读取全部').click();
  let req = s.posted.find(m => m.kind === 'posts');
  s.send({ type: 'response', id: req.id, author: 'author-one', data: { status_code: 0, aweme_list: [item('12345')], has_more: 1, max_cursor: 10 } });
  await s.flush(); s.button('关闭 ×').click();
  const delay = s.timers.find(t => t.ms === 1000 && !t.cancelled); assert.ok(delay); delay.fn(); await s.flush();
  req = s.posted.filter(m => m.kind === 'posts').at(-1); assert.equal(req.cursor, '10');
  s.send({ type: 'response', id: req.id, author: 'author-one', data: { status_code: 0, aweme_list: [item('67890')], has_more: 0 } });
  await running; await s.flush();
  assert.equal(s.all().find(e => e.tagName === 'strong').textContent, '2');
  assert.ok(s.all().some(e => e.textContent.startsWith('读取结束：')));
});

test('ordinary pages hide the worklist and SPA navigation only shows it on profiles', async () => {
  for (const path of ['/', '/jingxuan', '/search/test', '/video/12345']) {
    const s = setup(`https://www.douyin.com${path}`);
    const host = s.html.children[0];
    assert.equal(host.hidden, true);
    s.button('▤ 作品清单').click();
    assert.equal(s.all().find(e => e.tagName === 'section').hidden, true);
    s.location.href = 'https://www.douyin.com/user/author-one';
    s.interval.fn(); await s.flush();
    assert.equal(host.hidden, false);
    s.button('▤ 作品清单').click();
    s.send(observed([item('12345')])); await s.flush();
    assert.equal(s.all().find(e => e.tagName === 'section').hidden, false);
    s.location.href = 'https://www.douyin.com/jingxuan';
    s.windowEvents.popstate(); await s.flush();
    assert.equal(host.hidden, true);
    assert.equal(s.all().find(e => e.tagName === 'section').hidden, true);
    assert.equal(s.all().find(e => e.tagName === 'strong').textContent, '0');
    s.location.href = 'https://www.douyin.com/user/author-two';
    s.interval.fn(); await s.flush();
    assert.equal(host.hidden, false);
    assert.equal(s.all().find(e => e.tagName === 'section').hidden, true);
    assert.equal(s.posted.filter(m => m.type === 'observe').at(-1).enabled, false);
  }
});

test('TikTok active pages share memory pagination, search, author cleanup and explicit completion', async () => {
  const s = setup('https://www.tiktok.com/@creator.one'); s.location.origin = 'https://www.tiktok.com';
  const author = 'tiktok:creator.one';
  const video = id => ({ id, desc: `TikTok ${id}`, author: { uniqueId: 'creator.one', nickname: 'TT Author' }, stats: { diggCount: 0, shareCount: 2, commentCount: 3 }, video: { playAddr: 'https://v16-webapp-prime.us.tiktok.com/test' } });
  assert.equal(s.html.children[0].hidden, false); s.button('▤ 作品清单').click();
  const running = s.button('读取全部').click();
  let req = s.posted.find(m => m.kind === 'posts'); assert.equal(req.author, author);
  s.send({ type: 'response', id: req.id, author, data: { statusCode: 0, itemList: [video('12345')], hasMore: true, cursor: '100' } }); await s.flush();
  s.button('关闭 ×').click();
  s.timers.find(t => t.ms === 1000 && !t.cancelled).fn(); await s.flush();
  req = s.posted.filter(m => m.kind === 'posts').at(-1); assert.equal(req.cursor, '100');
  s.send({ type: 'response', id: req.id, author, data: { statusCode: 0, itemList: [video('67890')], hasMore: false } }); await running; await s.flush();
  assert.equal(s.all().find(e => e.tagName === 'strong').textContent, '2'); assert.ok(s.all().some(e => e.textContent.startsWith('读取结束：')));
  s.button('▤ 作品清单').click(); const input = s.all().find(e => e.tagName === 'input'); input.value = '67890'; input.events.input(); await s.flush();
  assert.ok(s.all().some(e => e.tagName === 'a' && e.href === 'https://www.tiktok.com/@creator.one/video/67890'));
  assert.ok(s.all().some(e => e.textContent === '导出 Excel (1)'));
  s.location.href = 'https://www.tiktok.com/@creator.one/video/67890'; s.interval.fn(); await s.flush();
  assert.equal(s.html.children[0].hidden, true); assert.equal(s.all().find(e => e.tagName === 'strong').textContent, '0');
});
test('TikTok passive collection accepts matching author responses and keeps partial state', async () => {
  const s = setup('https://www.tiktok.com/@creator.one'); s.location.origin = 'https://www.tiktok.com'; s.button('▤ 作品清单').click();
  s.send({ type: 'observed', author: 'tiktok:creator.one', path: '/api/post/item_list', data: { statusCode: 0, hasMore: false, itemList: [
    { id: '12345', author: { uniqueId: 'other' }, video: {}, desc: 'Other' },
    { id: '67890', author: { uniqueId: 'creator.one' }, video: {}, desc: 'Current' }
  ] } }); await s.flush();
  assert.equal(s.all().find(e => e.tagName === 'strong').textContent, '1');
  assert.equal(s.all().some(e => e.textContent.startsWith('读取结束：')), false);
});
test('TikTok empty final page cannot erase existing rows when the profile reports published works', async () => {
  const s = setup('https://www.tiktok.com/@creator.one'); s.location.origin = 'https://www.tiktok.com'; const author = 'tiktok:creator.one';
  const running = s.button('读取全部').click(); const p = s.posted.find(m => m.kind === 'profile'), r = s.posted.find(m => m.kind === 'posts');
  s.send({ type: 'response', id: p.id, author, data: { status_code: 0, user: { sec_uid: author, nickname: 'TT', aweme_count: 2 } } }); await s.flush();
  s.send({ type: 'response', id: r.id, author, data: { statusCode: 0, hasMore: false } }); await running; await s.flush();
  assert.ok(s.all().some(e => e.textContent.includes('无法确认读取完整'))); assert.equal(s.all().some(e => e.textContent.startsWith('读取结束：')), false);
});
