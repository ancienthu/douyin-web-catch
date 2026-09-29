const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
function setup() {
  const messages = [], listeners = {}, calls = [];
  const author = 'MS4wLjAB_test';
  const data = { status_code: 0, aweme_list: [{ aweme_id: '12345' }], has_more: 0 };
  const window = {
    fetch: async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => data, clone: () => ({ json: async () => data }) }; },
    postMessage: m => messages.push(m), addEventListener: (name, fn) => { listeners[name] = fn; }
  };
  class XHR { open() {} send() {} addEventListener() {} }
  const location = { href: `https://www.douyin.com/user/${author}`, origin: 'https://www.douyin.com', pathname: `/user/${author}` };
  vm.runInNewContext(fs.readFileSync(require.resolve('../extension/bridge.js'), 'utf8'), { window, location, XMLHttpRequest: XHR, URL, AbortController, setTimeout, clearTimeout });
  return { messages, calls, window, location, author, send: m => listeners.message({ source: window, origin: location.origin, data: { channel: 'dy-worklist-v1', from: 'extension', ...m } }) };
}
test('bridge observes only while enabled, with no retained backlog after disabling', async () => {
  const s = setup();
  await s.window.fetch(`https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=${s.author}`);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(s.messages.length, 0);
  await s.send({ type: 'observe', enabled: true });
  assert.equal(s.messages.length, 0);
  await s.window.fetch(`https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=${s.author}`);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(s.messages[0].type, 'observed');
  await s.window.fetch(`https://evil.test/aweme/v1/web/aweme/post/?sec_user_id=${s.author}`);
  await s.window.fetch('https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=other');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(s.messages.length, 1);
  await s.send({ type: 'observe', enabled: false });
  await s.window.fetch(`https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=${s.author}`);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(s.messages.length, 1);
});
test('bridge refuses arbitrary URLs, unknown actions and wrong authors', async () => {
  const s = setup();
  await s.send({ type: 'request', kind: 'anything', author: s.author, id: '1', cursor: '0' });
  await s.send({ type: 'request', kind: 'posts', author: 'other', id: '2', cursor: '0' });
  assert.equal(s.calls.length, 0);
  await s.send({ type: 'request', kind: 'posts', author: s.author, id: '3', cursor: '123' });
  assert.equal(s.calls.length, 1);
  const url = new URL(s.calls[0].url);
  assert.equal(url.origin, 'https://www.douyin.com'); assert.equal(url.searchParams.get('max_cursor'), '123');
  assert.equal(s.calls[0].options.credentials, 'include');
  assert.equal(s.messages.at(-1).type, 'response');
});
