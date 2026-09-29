/* Shared pure data utilities. No network or DOM access. */
(function (root) {
  'use strict';
  const MEDIA_DOMAINS = ['douyin.com', 'douyinvod.com', 'douyincdn.com', 'bytecdn.cn', 'bytecdn.com', 'byteimg.com', 'ibytedtos.com'];
  function authorFromURL(value) {
    try {
      const url = new URL(value);
      return url.origin === 'https://www.douyin.com' ? (url.pathname.match(/^\/user\/([A-Za-z0-9._-]+)(?:\/|$)/)?.[1] || '') : '';
    } catch { return ''; }
  }
  function mediaURL(value) {
    try {
      if (typeof value !== 'string' || value.length > 4096) return '';
      const u = new URL(value);
      if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return '';
      return MEDIA_DOMAINS.some(d => u.hostname === d || u.hostname.endsWith('.' + d)) ? u.href : '';
    } catch { return ''; }
  }
  function count(value) {
    if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
    const n = Number(value);
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  }
  function string(value, limit = 32767) { return typeof value === 'string' ? value.slice(0, limit) : ''; }
  function preferCandidates(values) {
    const urls = [...new Set(values.map(mediaURL).filter(Boolean))];
    function rank(value) {
      const u = new URL(value);
      if (u.searchParams.get('watermark') === '1' || /playwm|tplv-dy-water|owner_watermark/i.test(u.pathname)) return 2;
      return u.hostname === 'douyin.com' || u.hostname.endsWith('.douyin.com') ? 1 : 0;
    }
    // Prefer actual CDN files to /aweme/v1/play/ redirects. Preserve mirrors.
    return urls.sort((a, b) => rank(a) - rank(b)).slice(0, 12);
  }
  function videoCandidates(video) {
    const rates = (Array.isArray(video.bit_rate) ? video.bit_rate : []).slice(0, 32).filter(b => b?.play_addr);
    const area = b => (Number(b.play_addr.width || b.width) || 0) * (Number(b.play_addr.height || b.height) || 0);
    rates.sort((a, b) => area(b) - area(a) || (Number(b.bit_rate) || 0) - (Number(a.bit_rate) || 0));
    const sources = [...rates.map(b => b.play_addr), video.play_addr_h264, video.play_addr_265, video.play_addr_256, video.play_addr, video.download_addr];
    return preferCandidates(sources.flatMap(v => Array.isArray(v?.url_list) ? v.url_list.slice(0, 20) : []));
  }
  function normalize(item, author) {
    if (!item || typeof item !== 'object') return null;
    // Never round a long ID received as an unsafe JavaScript number.
    if (typeof item.aweme_id === 'number' && !Number.isSafeInteger(item.aweme_id)) return null;
    const id = String(item.aweme_id || '');
    if (!/^\d{5,30}$/.test(id)) return null;
    if (item.author?.sec_uid && item.author.sec_uid !== author) return null;
    if (Array.isArray(item.images) && item.images.length) return { id, image: true };
    const video = item.video;
    if (!video || typeof video !== 'object') return null;
    const desc = string(item.desc);
    const explicitTitle = string(item.item_title, 200).trim();
    const title = explicitTitle || desc.split(/\r?\n/)[0].trim().slice(0, 80) || '无标题';
    const stats = item.statistics || {};
    const candidates = videoCandidates(video);
    return {
      id, author, nickname: string(item.author?.nickname, 100), title, description: desc,
      titleSource: explicitTitle ? '作品标题' : '文案截取',
      likes: count(stats.digg_count), shares: count(stats.share_count), comments: count(stats.comment_count),
      created: count(item.create_time), url: `https://www.douyin.com/video/${id}`,
      candidates, collectedAt: new Date().toISOString()
    };
  }
  function validatePage(data) {
    if (!data || data.status_code !== 0 || !Array.isArray(data.aweme_list)) throw new Error(data?.status_msg || '接口未返回有效作品列表，请确认登录状态，或滚动主页继续收集。');
    if (![0, 1, false, true].includes(data.has_more)) throw new Error('分页状态缺失，无法确认是否读取完整。');
    return data;
  }
  function pageDecision(data, current, seen, emptyStreak) {
    validatePage(data);
    if (data.has_more === false || data.has_more === 0) return { complete: true };
    if (emptyStreak >= 3) throw new Error('连续三页没有作品，读取已暂停；当前结果可能不完整。');
    const next = data.max_cursor;
    if ((typeof next !== 'string' && typeof next !== 'number') || !/^\d+$/.test(String(next))) throw new Error('下一页游标无效，当前结果可能不完整。');
    if (String(next) === String(current) || seen.has(String(next))) throw new Error('分页游标重复，读取已暂停；当前结果可能不完整。');
    return { complete: false, next: String(next) };
  }
  function selectRows(rows, query, sort) {
    const q = query.trim().toLocaleLowerCase();
    const list = [...rows].filter(r => !q || `${r.id} ${r.title} ${r.description}`.toLocaleLowerCase().includes(q));
    const [field, direction] = sort.split(':');
    const sign = direction === 'asc' ? 1 : -1;
    return list.sort((a, b) => {
      const x = a[field], y = b[field];
      if (x == null && y == null) return a.id.localeCompare(b.id);
      if (x == null) return 1;
      if (y == null) return -1;
      return (x < y ? -1 : x > y ? 1 : 0) * sign || a.id.localeCompare(b.id);
    });
  }
  function safeFilename(value) {
    return String(value).replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '_').replace(/^\.+|[.\s]+$/g, '').slice(0, 90) || '视频';
  }
  function dateText(seconds) { return seconds ? new Date(seconds * 1000).toLocaleString('zh-CN', { hour12: false }) : '未提供'; }
  function collectedTimeText(value) {
    if (!value) return '未提供';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '未提供';
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }
  function exportRows(rows) {
    const headers = ['名称', '简介', '点赞量', '分享量', '评论量', '作品ID', '作者', '发布时间', '作品链接', '采集时间', '名称来源'];
    return [headers, ...rows.map(r => [r.title, r.description, r.likes ?? '未提供', r.shares ?? '未提供', r.comments ?? '未提供', r.id, r.nickname, dateText(r.created), r.url, collectedTimeText(r.collectedAt), r.titleSource])];
  }
  // Approximation of retained JSON data (UTF-16), not total browser heap.
  class CapacityError extends Error {
    constructor() { super('已达到缓存上限（10,000 条视频或约 32 MiB 数据），已停止读取。当前结果不完整，请先导出，再清理数据。'); this.code = 'CAPACITY'; }
  }
  class BoundedRows extends Map {
    constructor(maxRows = 10000, maxBytes = 32 * 1024 * 1024) { super(); this.maxRows = maxRows; this.maxBytes = maxBytes; this.bytes = 0; this.sizes = new Map(); }
    set(id, value) {
      const bytes = JSON.stringify(value).length * 2;
      const nextBytes = this.bytes - (this.sizes.get(id) || 0) + bytes;
      if ((!this.has(id) && this.size >= this.maxRows) || nextBytes > this.maxBytes) throw new CapacityError();
      super.set(id, value); this.sizes.set(id, bytes); this.bytes = nextBytes; return this;
    }
    delete(id) { this.bytes -= this.sizes.get(id) || 0; this.sizes.delete(id); return super.delete(id); }
    clear() { super.clear(); this.sizes.clear(); this.bytes = 0; }
  }
  root.DYCore = { authorFromURL, mediaURL, count, normalize, validatePage, pageDecision, selectRows, safeFilename, dateText, exportRows, BoundedRows, CapacityError, preferCandidates, videoCandidates };
})(globalThis);
