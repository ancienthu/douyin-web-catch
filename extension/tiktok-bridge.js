/* TikTok page adapter. Uses the site's current fetch wrapper; no signature generation or cookie reads. */
(() => {
  'use strict';
  if (location.origin !== 'https://www.tiktok.com') return;
  const CHANNEL = 'dy-worklist-v1', controllers = new Map();
  const currentAuthor = () => {
    const name = location.pathname.match(/^\/@([A-Za-z0-9._]{1,24})\/?$/)?.[1];
    return name ? `tiktok:${name.toLowerCase()}` : '';
  };
  const send = m => window.postMessage({ channel: CHANNEL, from: 'page', ...m }, location.origin);
  // Keep one bounded, page-local request template. Session/signature tokens are excluded.
  const PARAMS = new Set('WebIdLastTime aid app_language app_name browser_language browser_name browser_online browser_platform browser_version channel clientABVersions cookie_enabled count coverFormat cursor device_id device_platform enable_cache focus_state from_page history_len is_fullscreen is_page_visible language needPinnedItemIds odinId os post_item_list_request_type priority_region referer region root_referer screen_height screen_width secUid tz_name user_is_login verifyFp video_encoding webcast_language'.split(' '));
  let author = '', secUid = '', template = null, initialInfo = null, observing = false;
  function sync() {
    const next = currentAuthor();
    if (next !== author) {
      for (const controller of controllers.values()) controller.abort();
      author = next; secUid = ''; template = null; initialInfo = null; observing = false;
    }
    return author;
  }
  function initialUser() {
    try {
      sync();
      if (initialInfo) return initialInfo;
      const text = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__')?.textContent;
      if (!text || text.length > 5 * 1024 * 1024) return null;
      const info = JSON.parse(text).__DEFAULT_SCOPE__?.['webapp.user-detail']?.userInfo;
      if (`tiktok:${String(info?.user?.uniqueId || '').toLowerCase()}` !== sync()) return null;
      if (typeof info.user.secUid !== 'string' || info.user.secUid.length > 256) return null;
      secUid = info.user.secUid;
      initialInfo = { user: { uniqueId: info.user.uniqueId, secUid, nickname: String(info.user.nickname || '').slice(0, 100) }, stats: { videoCount: info.statsV2?.videoCount ?? info.stats?.videoCount } };
      return initialInfo;
    } catch { return null; }
  }
  function profileData(info) {
    if (`tiktok:${String(info?.user?.uniqueId || '').toLowerCase()}` !== sync()) throw new Error('TikTok 作者资料未就绪，请刷新当前作者主页后重试。');
    if (typeof info.user.secUid !== 'string' || !info.user.secUid || info.user.secUid.length > 256) throw new Error('TikTok 作者标识缺失。');
    secUid = info.user.secUid;
    return { status_code: 0, user: { sec_uid: author, nickname: info.user.nickname, aweme_count: info.statsV2?.videoCount ?? info.stats?.videoCount } };
  }
  function route(value) {
    try {
      if (!sync()) return null;
      const url = new URL(value, location.href), path = url.pathname.replace(/\/$/, '');
      if (url.origin !== location.origin || !['/api/post/item_list', '/api/user/detail'].includes(path)) return null;
      initialUser();
      if (path === '/api/post/item_list' && secUid && url.searchParams.get('secUid') === secUid) return { url, path, author };
      if (path === '/api/user/detail' && `tiktok:${(url.searchParams.get('uniqueId') || '').toLowerCase()}` === author) return { url, path, author };
      return null;
    } catch { return null; }
  }
  function remember(info) {
    if (info?.path !== '/api/post/item_list' || info.url.href.length > 16384) return;
    const next = new URL('/api/post/item_list/', location.origin);
    for (const [key, value] of info.url.searchParams) if (PARAMS.has(key) && value.length <= 2048) next.searchParams.set(key, value);
    template = next;
  }
  function observe(info, data) {
    if (!observing || info.author !== sync()) return;
    if (info.path === '/api/post/item_list' && data?.statusCode === 0) send({ type: 'observed', path: info.path, author, data });
    if (info.path === '/api/user/detail' && data?.statusCode === 0) {
      try { send({ type: 'observed', path: info.path, author, data: profileData(data.userInfo) }); } catch { /* Another profile. */ }
    }
  }
  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const url = typeof args[0] === 'string' || args[0] instanceof URL ? String(args[0]) : args[0]?.url;
    const info = route(url); remember(info);
    const result = Reflect.apply(originalFetch, this, args);
    if (observing && info) result.then(response => {
      if (observing && response.ok) response.clone().json().then(data => observe(info, data)).catch(() => {});
    }).catch(() => {});
    return result;
  };
  const originalOpen = XMLHttpRequest.prototype.open, originalSend = XMLHttpRequest.prototype.send, requests = new WeakMap();
  XMLHttpRequest.prototype.open = function (method, url, ...rest) { requests.set(this, String(url)); return Reflect.apply(originalOpen, this, [method, url, ...rest]); };
  XMLHttpRequest.prototype.send = function (...args) {
    const info = route(requests.get(this)); remember(info);
    if (observing && info) this.addEventListener('load', () => {
      try { observe(info, this.responseType === 'json' ? this.response : JSON.parse(this.responseText)); } catch { /* Empty or non-JSON response. */ }
    }, { once: true });
    return Reflect.apply(originalSend, this, args);
  };
  function requestURL(kind, cursor) {
    const url = new URL(kind === 'posts' && template ? template.href : (kind === 'posts' ? '/api/post/item_list/' : '/api/user/detail/'), location.origin);
    if (!url.searchParams.has('aid')) url.searchParams.set('aid', '1988');
    if (!url.searchParams.has('app_name')) url.searchParams.set('app_name', 'tiktok_web');
    if (!url.searchParams.has('device_platform')) url.searchParams.set('device_platform', 'web_pc');
    if (!url.searchParams.has('channel')) url.searchParams.set('channel', 'tiktok_web');
    if (kind === 'posts') {
      url.searchParams.set('secUid', secUid); url.searchParams.set('cursor', cursor);
      url.searchParams.set('count', '30'); url.searchParams.set('needPinnedItemIds', 'true');
      // A previous page may have used the Popular/Oldest sort; collection always walks the latest feed.
      url.searchParams.set('post_item_list_request_type', '0');
    } else url.searchParams.set('uniqueId', author.slice(7));
    return url;
  }
  async function fetchJSON(url, signal) {
    const response = await window.fetch(url.href, { credentials: 'include', signal });
    if (!response.ok) throw new Error(`TikTok 请求失败（HTTP ${response.status}）。`);
    try { return await response.json(); }
    catch { throw new Error('TikTok 返回空响应或非 JSON 数据，请在网页确认登录/验证状态，或滚动主页收集作品。'); }
  }
  window.addEventListener('message', async event => {
    const m = event.data;
    if (event.source !== window || event.origin !== location.origin || m?.channel !== CHANNEL || m.from !== 'extension') return;
    sync();
    if (m.type === 'observe') { observing = Boolean(author && m.enabled === true); return; }
    if (m.type === 'reset') { template = null; secUid = ''; initialInfo = null; observing = false; return; }
    if (m.type === 'cancel') { controllers.get(m.id)?.abort(); return; }
    if (m.type !== 'request' || typeof m.id !== 'string' || m.id.length > 80 || !author || m.author !== author || controllers.has(m.id) || controllers.size >= 2) return;
    if (!['posts', 'profile'].includes(m.kind) || !/^\d{1,24}$/.test(String(m.cursor))) return;
    const expected = author, controller = new AbortController(); controllers.set(m.id, controller);
    const timer = setTimeout(() => controller.abort(), 18000);
    try {
      let info = initialUser();
      if (!info && (m.kind === 'profile' || !secUid)) {
        const data = await fetchJSON(requestURL('profile', '0'), controller.signal);
        if (data?.statusCode !== 0) throw new Error(data?.statusMsg || '无法读取 TikTok 作者资料。');
        info = data.userInfo; profileData(info);
      }
      if (expected !== sync() || controller.signal.aborted) throw new DOMException('已停止', 'AbortError');
      const data = m.kind === 'profile' ? profileData(info) : await fetchJSON(requestURL('posts', String(m.cursor)), controller.signal);
      if (expected === sync() && !controller.signal.aborted) send({ type: 'response', id: m.id, author: expected, data });
    } catch (error) {
      send({ type: 'response', id: m.id, author: expected, error: error.name === 'AbortError' ? '请求已停止或超时。' : error.message });
    } finally { clearTimeout(timer); controllers.delete(m.id); }
  });
  window.addEventListener('pagehide', () => { for (const c of controllers.values()) c.abort(); template = null; secUid = ''; initialInfo = null; observing = false; });
})();
