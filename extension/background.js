importScripts('core.js');
'use strict';
const C = globalThis.DYCore;
const keyFor = (tab, author, id) => `record:${tab}:${author}:${id}`;
const jobKey = id => `download:${id}`;
const locks = new Set();
const pending = new Set();
function validSender(sender) {
  return sender.id === chrome.runtime.id && sender.tab?.id != null && sender.frameId === 0 && Boolean(C.authorFromURL(sender.url));
}
async function report(job, state, error = '') {
  try { await chrome.tabs.sendMessage(job.tab, { type: 'download-state', author: job.author, id: job.id, state, error, attempt: job.index + 1, total: job.urls.length }); } catch { /* Tab may have closed. */ }
}
// Probe a small MP4 prefix before creating any Chrome download task.
// Only direct video CDN hosts are accessible; no redirects or full-file buffering.
// TikTok checks use the browser's existing login, as the subsequent Chrome download does.
async function probeVideo(url, author) {
  const parsed = new URL(C.mediaURL(url));
  if (!C.downloadURL(url, author)) {
    throw new Error('没有可验证的视频直链，请重新读取作品。');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  let reader;
  try {
    const response = await fetch(parsed.href, {
      method: 'GET', headers: { Range: 'bytes=0-31', Accept: '*/*' },
      credentials: author.startsWith('tiktok:') ? 'include' : 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal
    });
    if (![200, 206].includes(response.status)) throw new Error(`视频地址不可用（HTTP ${response.status}）`);
    if (/(?:text\/|json|xml)/i.test(response.headers.get('content-type') || '')) throw new Error('地址返回错误页面，已跳过。');
    reader = response.body?.getReader();
    if (!reader) throw new Error('视频响应为空。');
    const prefix = new Uint8Array(12);
    let length = 0;
    while (length < prefix.length) {
      const { done, value } = await reader.read();
      if (done) break;
      const take = Math.min(value.length, prefix.length - length);
      prefix.set(value.subarray(0, take), length); length += take;
    }
    if (length < 12 || !['ftyp', 'styp'].includes(String.fromCharCode(...prefix.subarray(4, 8)))) {
      throw new Error('地址未返回 MP4 视频，已跳过。');
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (reader) await reader.cancel().catch(() => {});
  }
}
async function attempt(job) {
  while (job.index < job.urls.length) {
    try {
      await report(job, 'checking');
      await probeVideo(job.urls[job.index], job.author);
      const id = await chrome.downloads.download({ url: job.urls[job.index], filename: job.filename, conflictAction: 'uniquify', saveAs: false, headers: [{ name: 'Accept', value: '*/*' }] });
      await chrome.storage.session.set({ [jobKey(id)]: job });
      await report(job, 'in_progress');
      // Reconcile downloads that completed before the session record was stored.
      const [item] = await chrome.downloads.search({ id });
      if (item && item.state !== 'in_progress') await finish(id, item.state, item.error || '');
      return;
    } catch (error) { job.index++; job.lastError = error.message; }
  }
  await report(job, 'interrupted', job.lastError || '所有候选地址均下载失败，请重新读取作品后再试。');
}
async function finish(id, state, error) {
  if (locks.has(id)) return;
  locks.add(id);
  try {
    const key = jobKey(id), stored = await chrome.storage.session.get(key), job = stored[key];
    if (!job) return;
    if (!error && state === 'interrupted') {
      const [item] = await chrome.downloads.search({ id });
      error = item?.error || '';
    }
    await chrome.storage.session.remove(key);
    if (state === 'complete') {
      const [item] = await chrome.downloads.search({ id });
      if (!item || item.fileSize === 0 || /(?:text\/html|application\/json|text\/plain)/i.test(item.mime || '')) {
        // Keep the user's download history. A successful HTTP response is not necessarily a video.
        job.index++; job.lastError = '下载结果不是有效视频（空文件或错误页面）。请重新读取作品获取最新地址。';
        await attempt(job);
      } else await report(job, 'complete');
    } else if (error === 'USER_CANCELED' || error === 'USER_SHUTDOWN') await report(job, 'interrupted', '下载已取消。');
    else { job.index++; job.lastError = error || '下载中断'; await attempt(job); }
  } finally { locks.delete(id); }
}
chrome.downloads.onChanged.addListener(delta => {
  if (['complete', 'interrupted'].includes(delta.state?.current)) finish(delta.id, delta.state.current, delta.error?.current || '').catch(console.error);
});
chrome.runtime.onMessage.addListener((m, sender, respond) => {
  if (!validSender(sender)) return;
  (async () => {
    const author = C.authorFromURL(sender.url), tab = sender.tab.id;
    if (m.author !== author) throw new Error('作者页面已变化，请重新打开当前作者列表。');
    if (m.type === 'clear-records') {
      const all = await chrome.storage.session.get(null);
      await chrome.storage.session.remove(Object.keys(all).filter(k => k.startsWith(`record:${tab}:`)));
      return { ok: true };
    }
    if (m.type === 'register-download') {
      const r = m.record;
      if (!r || !/^\d{5,30}$/.test(r.id) || !Array.isArray(r.candidates)) throw new Error('作品数据无效。');
      // Also fixes candidate order for older content-script data until the page is refreshed.
      const urls = C.preferCandidates(r.candidates.slice(0, 100)).filter(url => C.downloadURL(url, author));
      if (!urls.length) throw new Error('没有受支持的视频地址，请在当前网站打开这条作品后重新读取。');
      const record = { urls, filename: `${C.platformFor(author)}作品/${C.safeFilename(r.title)}_${r.id}.mp4`, updated: Date.now() };
      const all = await chrome.storage.session.get(null);
      await chrome.storage.session.remove(Object.keys(all).filter(k => k.startsWith(`record:${tab}:`) || (k.startsWith('record:') && Date.now() - all[k].updated > 60000)));
      await chrome.storage.session.set({ [keyFor(tab, author, r.id)]: record });
      return { ok: true };
    }
    if (m.type === 'download') {
      if (!/^\d{5,30}$/.test(m.id)) throw new Error('作品 ID 无效。');
      const key = keyFor(tab, author, m.id), values = await chrome.storage.session.get(key), record = values[key];
      if (!record || Date.now() - record.updated > 60000) throw new Error('下载信息已过期，请再次点击下载。');
      if (pending.has(key)) throw new Error('此视频正在检查下载地址。');
      pending.add(key);
      try {
      await chrome.storage.session.remove(key);
      const all = await chrome.storage.session.get(null);
      if (Object.entries(all).some(([k, v]) => k.startsWith('download:') && v.tab === tab && v.author === author && v.id === m.id)) throw new Error('此视频正在下载，请查看 Chrome 下载列表。');
      await attempt({ tab, author, id: m.id, urls: record.urls, filename: record.filename, index: 0 });
      return { ok: true };
      } finally { pending.delete(key); }
    }
    throw new Error('不支持的操作。');
  })().then(respond).catch(error => respond({ ok: false, error: error.message }));
  return true;
});
chrome.tabs.onRemoved.addListener(async tab => {
  const all = await chrome.storage.session.get(null);
  await chrome.storage.session.remove(Object.keys(all).filter(k => k.startsWith(`record:${tab}:`)));
});
