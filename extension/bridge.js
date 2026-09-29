/* Runs in the page world. Fixed endpoints, no retained response backlog or cookie reads. */
(() => {
  'use strict';
  const CHANNEL = 'dy-worklist-v1', controllers = new Map();
  const currentAuthor = () => location.pathname.match(/^\/user\/([A-Za-z0-9._-]+)(?:\/|$)/)?.[1] || '';
  const send = message => window.postMessage({ channel: CHANNEL, from: 'page', ...message }, location.origin);
  let observing = false;
  function route(value) {
    try {
      const url = new URL(value, location.href), path = url.pathname.replace(/\/$/, ''), author = url.searchParams.get('sec_user_id');
      return url.origin === location.origin && author && author === currentAuthor() && ['/aweme/v1/web/aweme/post', '/aweme/v1/web/user/profile/other'].includes(path) ? { path, author } : null;
    } catch { return null; }
  }
  function observe(value, data) {
    const info = route(value);
    if (observing && info && data?.status_code === 0) send({ type: 'observed', ...info, data });
  }
  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const result = Reflect.apply(originalFetch, this, args);
    const url = typeof args[0] === 'string' || args[0] instanceof URL ? String(args[0]) : args[0]?.url;
    if (observing && route(url)) result.then(response => {
      if (observing && response.ok) response.clone().json().then(data => observe(url, data)).catch(() => {});
    }).catch(() => {});
    return result;
  };
  const originalOpen = XMLHttpRequest.prototype.open, originalSend = XMLHttpRequest.prototype.send, requests = new WeakMap();
  XMLHttpRequest.prototype.open = function (method, url, ...rest) { requests.set(this, String(url)); return Reflect.apply(originalOpen, this, [method, url, ...rest]); };
  XMLHttpRequest.prototype.send = function (...args) {
    const url = requests.get(this);
    if (observing && route(url)) this.addEventListener('load', () => {
      if (!observing) return;
      try { observe(url, this.responseType === 'json' ? this.response : JSON.parse(this.responseText)); } catch { /* No valid JSON. */ }
    }, { once: true });
    return Reflect.apply(originalSend, this, args);
  };
  window.addEventListener('message', async event => {
    const m = event.data;
    if (event.source !== window || event.origin !== location.origin || m?.channel !== CHANNEL || m.from !== 'extension') return;
    if (m.type === 'observe') { observing = m.enabled === true; return; }
    if (m.type === 'cancel') { controllers.get(m.id)?.abort(); return; }
    if (m.type !== 'request' || typeof m.id !== 'string' || m.id.length > 80 || m.author !== currentAuthor() || !m.author || controllers.size >= 2 || controllers.has(m.id)) return;
    if (!['posts', 'profile'].includes(m.kind) || (m.kind === 'posts' && !/^\d{1,24}$/.test(String(m.cursor)))) return;
    const controller = new AbortController(); controllers.set(m.id, controller);
    const timer = setTimeout(() => controller.abort(), 18000);
    try {
      const path = m.kind === 'posts' ? '/aweme/v1/web/aweme/post/' : '/aweme/v1/web/user/profile/other/';
      const url = new URL(path, location.origin);
      url.searchParams.set('sec_user_id', m.author);
      url.searchParams.set('device_platform', 'webapp'); url.searchParams.set('aid', '6383');
      if (m.kind === 'posts') { url.searchParams.set('max_cursor', String(m.cursor)); url.searchParams.set('count', '35'); }
      else url.searchParams.set('channel', 'channel_pc_web');
      const response = await window.fetch(url.href, { credentials: 'include', signal: controller.signal });
      if (!response.ok) throw new Error(`请求失败（HTTP ${response.status}）。请在主页确认登录或验证提示。`);
      const data = await response.json();
      send({ type: 'response', id: m.id, author: m.author, data });
    } catch (error) {
      send({ type: 'response', id: m.id, author: m.author, error: error.name === 'AbortError' ? '请求已停止或超时。' : `无法读取接口：${error.message}` });
    } finally { clearTimeout(timer); controllers.delete(m.id); }
  });
})();
