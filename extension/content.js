(() => {
  'use strict';
  const C = globalThis.DYCore, CHANNEL = 'dy-worklist-v1';
  const pending = new Map();
  const INITIAL = '点击「读取全部」开始，也可滚动主页收集已加载作品。';
  const state = { author: '', nickname: '', total: null, rows: new C.BoundedRows(), images: new Set(), phase: 'idle', message: INITIAL, query: '', sort: 'created:desc', page: 1, pageSize: 50, passive: true, generation: 0, opened: false, downloads: new Map(), complete: false };
  let host, shadow, refs = {}, renderQueued = false, activeController = null, exportURL = null;
  const post = m => window.postMessage({ channel: CHANNEL, from: 'extension', ...m }, location.origin);
  function request(kind, cursor, signal) {
    const id = crypto.randomUUID(), author = state.author;
    return new Promise((resolve, reject) => {
      const cancel = () => { post({ type: 'cancel', id }); done(new DOMException('已停止', 'AbortError')); };
      const timer = setTimeout(() => { post({ type: 'cancel', id }); done(new Error('请求超时。请确认网页已登录，或滚动主页收集作品。')); }, 20000);
      function done(error, data) { clearTimeout(timer); signal?.removeEventListener('abort', cancel); pending.delete(id); error ? reject(error) : resolve(data); }
      pending.set(id, { author, done });
      if (signal?.aborted) { cancel(); return; }
      signal?.addEventListener('abort', cancel, { once: true });
      post({ type: 'request', id, kind, author, cursor });
    });
  }
  function observe(enabled) { state.passive = enabled; post({ type: 'observe', enabled }); }
  function clearData(message = '已清理列表、下载状态及缓存。点击「读取全部」重新开始。') {
    state.generation++;
    activeController?.abort(); activeController = null;
    for (const [id, p] of pending) { post({ type: 'cancel', id }); p.done(new DOMException('已清理', 'AbortError')); }
    observe(false);
    post({ type: 'reset' });
    state.rows.clear(); state.images.clear(); state.downloads.clear();
    Object.assign(state, { nickname: '', total: null, phase: 'idle', message, page: 1, query: '', complete: false });
    if (exportURL) { URL.revokeObjectURL(exportURL); exportURL = null; }
    if (refs.search) refs.search.value = '';
    refs.body?.replaceChildren();
    if (state.author) chrome.runtime.sendMessage({ type: 'clear-records', author: state.author }).catch(() => {});
    scheduleRender();
  }
  function switchAuthor() {
    const author = C.authorFromURL(location.href);
    if (author === state.author) return;
    clearData(INITIAL); state.author = author;
    if (host) host.hidden = !author;
    if (!author) {
      state.opened = false;
      if (refs.panel) refs.panel.hidden = true;
      refs.launcher?.setAttribute('aria-expanded', 'false');
    }
    // Do not collect in the background before the panel has been opened.
    observe(Boolean(author && state.opened)); scheduleRender();
  }
  function ingest(data, author) {
    if (Object.hasOwn(data || {}, 'statusCode')) data = C.validatePage(data);
    if (author !== state.author || !Array.isArray(data.aweme_list)) return;
    if (data.aweme_list.length > 100) throw new Error('接口单页条数异常，停止读取以避免过量载入。');
    for (const item of data.aweme_list) {
      const row = C.normalize(item, author);
      if (!row) continue;
      if (row.image) {
        if (!state.images.has(row.id) && state.images.size >= 10000) throw new C.CapacityError();
        state.images.add(row.id); continue;
      }
      if (!state.nickname && row.nickname) state.nickname = row.nickname;
      const previous = state.rows.get(row.id);
      if (previous) {
        for (const field of ['likes', 'shares', 'comments']) if (row[field] === null && previous[field] !== null) row[field] = previous[field];
        if (!row.candidates.length) row.candidates = previous.candidates;
      }
      state.rows.set(row.id, row);
    }
    scheduleRender();
  }
  window.addEventListener('message', event => {
    const m = event.data;
    if (event.source !== window || event.origin !== location.origin || m?.channel !== CHANNEL || m.from !== 'page') return;
    switchAuthor();
    if (m.type === 'response') {
      const p = pending.get(m.id);
      if (p && m.author === p.author) p.done(m.error ? new Error(m.error) : null, m.data);
    } else if (m.type === 'observed' && m.author === state.author && state.passive && state.phase !== 'loading') {
      try {
        if (m.path === '/aweme/v1/web/aweme/post' || m.path === '/api/post/item_list') {
          ingest(m.data, m.author);
          if (state.phase === 'idle' && state.rows.size) state.message = '已收集网页加载的作品。点击「读取全部」尝试读取其余作品。';
        } else if (['/aweme/v1/web/user/profile/other', '/api/user/detail'].includes(m.path) && m.data?.user) profile(m.data.user);
      } catch (error) { observe(false); state.complete = false; state.phase = 'partial'; state.message = error.message; scheduleRender(); }
    }
  });
  function profile(user) {
    if (user.sec_uid && user.sec_uid !== state.author) return;
    state.nickname = typeof user.nickname === 'string' ? user.nickname.slice(0, 100) : state.nickname;
    state.total = C.count(user.aweme_count); scheduleRender();
  }
  function wait(ms, signal) {
    return new Promise((resolve, reject) => {
      const cancel = () => { clearTimeout(timer); reject(new DOMException('已停止', 'AbortError')); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, ms);
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
    });
  }
  async function readAll() {
    if (!state.author || state.phase === 'loading') return;
    activeController?.abort();
    const controller = new AbortController(), signal = controller.signal, generation = ++state.generation, author = state.author;
    activeController = controller;
    // Active pagination consumes its responses once; passive observation is paused.
    observe(false); state.phase = 'loading'; state.complete = false; state.message = '正在读取作者作品…'; scheduleRender();
    request('profile', 0, signal).then(data => { if (generation === state.generation && data?.status_code === 0 && data.user) profile(data.user); }).catch(() => {});
    let cursor = '0', empty = 0, page = 0;
    const seen = new Set(['0']), fetchedIds = new Set(), fetchedImages = new Set();
    try {
      while (!signal.aborted) {
        let data;
        for (let attempt = 0; attempt < 2; attempt++) {
          try { data = C.validatePage(await request('posts', cursor, signal)); break; }
          catch (error) {
            if (signal.aborted || attempt === 1) throw error;
            state.message = '本页暂未读取成功，稍后重试一次…'; scheduleRender(); await wait(1800, signal);
          }
        }
        if (generation !== state.generation || author !== C.authorFromURL(location.href)) return;
        ingest(data, author); page++;
        for (const item of data.aweme_list) {
          const row = C.normalize(item, author);
          if (row) (row.image ? fetchedImages : fetchedIds).add(row.id);
        }
        empty = data.aweme_list.length ? 0 : empty + 1;
        const next = C.pageDecision(data, cursor, seen, empty);
        state.message = `已读取 ${page} 页 · ${state.rows.size} 条视频`;
        if (next.complete) {
          if (author.startsWith('tiktok:') && state.total > 0 && fetchedIds.size + fetchedImages.size === 0) throw new Error('TikTok 主页有作品，但接口返回空列表，无法确认读取完整。请滚动主页收集作品后重试。');
          for (const id of state.rows.keys()) if (!fetchedIds.has(id)) state.rows.delete(id);
          state.images = fetchedImages;
          for (const id of state.downloads.keys()) if (!state.rows.has(id)) state.downloads.delete(id);
          state.phase = 'complete'; state.complete = true;
          state.message = '读取结束：接口已返回最后一页。范围为当前账号可访问的公开视频。'; break;
        }
        if (page >= 10000) throw new Error('达到 10,000 页请求上限，已停止读取，当前结果可能不完整。');
        cursor = next.next; seen.add(cursor); scheduleRender();
        // Release the raw response before the inter-page delay.
        data = null;
        await wait(1000, signal);
      }
    } catch (error) {
      if (generation !== state.generation) return;
      state.phase = signal.aborted ? 'stopped' : 'partial';
      state.message = signal.aborted ? '已停止，保留当前结果。再次读取会从首页检查并自动去重。' : `${error.message} 已保留当前结果。`;
      if (!signal.aborted && error.code !== 'CAPACITY' && state.opened) observe(true);
    } finally { controller.abort(); if (generation === state.generation) { activeController = null; scheduleRender(); } }
  }
  function stop() {
    observe(false);
    if (activeController) activeController.abort();
    else if (state.phase !== 'complete') { state.phase = 'stopped'; state.message = '已停止收集，保留当前结果。'; scheduleRender(); }
  }
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    setTimeout(() => { renderQueued = false; if (shadow) render(); }, 80);
  }
  function el(tag, text, className) { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (className) n.className = className; return n; }
  function button(text, handler, className = '') {
    const b = el('button', text, className); b.type = 'button'; b.addEventListener('click', handler); return b;
  }
  function open() {
    switchAuthor();
    if (!state.author) return false;
    state.opened = true;
    if (state.phase === 'idle' && state.message === INITIAL) observe(true);
    refs.panel.hidden = false; refs.launcher.setAttribute('aria-expanded', 'true'); refs.close.focus(); return true;
  }
  function close() {
    state.opened = false; refs.panel.hidden = true;
    refs.launcher.setAttribute('aria-expanded', 'false'); refs.launcher.focus();
  }
  async function download(row, event) {
    if (!event.isTrusted) return;
    const author = state.author;
    if (row.author !== author || !state.rows.has(row.id)) return;
    const generation = state.generation;
    state.downloads.set(row.id, { state: 'in_progress' }); scheduleRender();
    try {
      let response = await chrome.runtime.sendMessage({ type: 'register-download', author, record: { id: row.id, title: row.title, candidates: row.candidates } });
      if (!response?.ok) throw new Error(response?.error || '无法登记下载信息。');
      response = await chrome.runtime.sendMessage({ type: 'download', author, id: row.id });
      if (!response?.ok) throw new Error(response?.error || '下载未能开始。');
    } catch (error) { if (state.author === author && generation === state.generation && state.rows.has(row.id)) { state.downloads.set(row.id, { state: 'interrupted', error: error.message }); scheduleRender(); } }
  }
  function exportExcel() {
    const rows = C.selectRows(state.rows.values(), state.query, state.sort);
    if (!rows.length) return;
    const blob = globalThis.DYXlsx.workbook(C.exportRows(rows), [
      ['平台', C.platformFor(state.author)], ['作者', state.nickname || state.author], ['作者主页', C.profileURL(state.author)], ['导出时间', new Date().toLocaleString('zh-CN')],
      ['采集状态', state.complete ? '接口已返回最后一页' : '部分结果，未确认完整'], ['状态详情', state.message], ['导出范围', '当前搜索和排序后的全部记录，不限当前分页'], ['搜索条件', state.query || '无'], ['导出条数', rows.length], ['已读取视频数', state.rows.size], ['跳过图文数', state.images.size],
      ['分享量', '来自 share_count / shareCount，未声称是独立的转发数。']
    ]);
    if (exportURL) URL.revokeObjectURL(exportURL);
    const url = URL.createObjectURL(blob), a = document.createElement('a'); exportURL = url;
    a.href = url; a.download = `${C.platformFor(state.author)}作品_${C.safeFilename(state.nickname || state.author)}_${new Date().toISOString().slice(0, 10)}.xlsx`;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => { URL.revokeObjectURL(url); if (exportURL === url) exportURL = null; }, 60000);
    refs.notice.textContent = `已生成 ${rows.length} 条记录的 Excel，请查看浏览器下载。`;
  }
  function render() {
    host.hidden = !state.author;
    refs.eyebrow.textContent = `${C.platformFor(state.author) === 'TikTok' ? 'TIKTOK' : 'DOUYIN'} / WORKLIST`;
    refs.name.textContent = state.nickname || '当前作者';
    refs.subtitle.textContent = state.author ? `作者主页 · ${state.author.slice(0, 24)}…` : '请进入作者主页';
    refs.status.textContent = state.message;
    refs.status.className = 'status ' + state.phase;
    refs.count.textContent = state.rows.size.toLocaleString();
    refs.total.textContent = state.total === null ? '主页作品数待读取' : `主页显示 ${state.total.toLocaleString()} 个作品`;
    refs.skipped.textContent = `${state.images.size} 条图文已跳过 · 缓存约 ${(state.rows.bytes / 1024 / 1024).toFixed(1)} MiB`;
    refs.read.disabled = state.phase === 'loading'; refs.read.textContent = state.phase === 'loading' ? '正在读取…' : state.rows.size ? '重新读取全部' : '读取全部';
    refs.stop.disabled = !state.passive && state.phase !== 'loading';
    const rows = C.selectRows(state.rows.values(), state.query, state.sort), pages = Math.max(1, Math.ceil(rows.length / state.pageSize));
    state.page = Math.max(1, Math.min(state.page, pages));
    refs.export.disabled = !rows.length; refs.export.textContent = `导出 Excel${rows.length ? ` (${rows.length})` : ''}`;
    refs.pager.textContent = `第 ${state.page} / ${pages} 页 · ${rows.length} 条${state.query ? '匹配结果' : '视频'}`;
    refs.prev.disabled = state.page === 1; refs.next.disabled = state.page === pages;
    refs.body.replaceChildren();
    if (!rows.length) {
      const tr = el('tr'), td = el('td'); td.colSpan = 7;
      const empty = el('div', undefined, 'empty'); empty.append(el('span', state.query ? '没有匹配的作品' : '你的作品清单，从这里开始', 'empty-title'), el('p', state.query ? '换个关键词，或清空搜索。' : '点击读取全部，或向下滚动作者主页。作品会逐步出现在这里。'));
      td.append(empty); tr.append(td); refs.body.append(tr);
    }
    for (const row of rows.slice((state.page - 1) * state.pageSize, state.page * state.pageSize)) {
      const tr = el('tr'), title = el('td', undefined, 'title-cell'), link = el('a', row.title);
      link.href = row.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.title = `${row.title}\n${row.id}`;
      title.append(link, el('small', C.dateText(row.created))); tr.append(title);
      const desc = el('td', undefined, 'desc-cell'), details = el('details'), summary = el('summary', row.description || '无简介');
      summary.title = '点击展开完整简介'; details.append(summary, el('p', row.description || '无简介')); desc.append(details); tr.append(desc);
      for (const field of ['likes', 'shares', 'comments']) {
        const td = el('td', row[field] === null ? '—' : row[field].toLocaleString('zh-CN'), 'number');
        if (row[field] === null) td.classList.add('unknown');
        td.title = row[field] === null ? '接口未提供' : String(row[field]);
        tr.append(td);
      }
      const action = el('td'), result = state.downloads.get(row.id), active = ['checking', 'in_progress'].includes(result?.state);
      const b = button(active ? (result?.state === 'checking' ? '检查地址…' : '下载中…') : result?.state === 'complete' ? '再次下载' : result?.state === 'interrupted' ? '重试下载' : '下载', e => download(row, e), 'download');
      b.disabled = active || !row.candidates.length; b.title = result?.error || (!row.candidates.length ? '接口未提供受支持的视频地址' : '下载这一条视频'); action.append(b);
      if (active && result.attempt > 1) action.append(el('small', `正在尝试备用地址 ${result.attempt}/${result.total}`, 'saved'));
      if (result?.state === 'complete') action.append(el('small', '已保存', 'saved'));
      if (result?.error) action.append(el('small', result.error, 'download-error'));
      tr.append(action);
      // Accessible direct link alongside the download control.
      const original = el('td'), go = el('a', '打开 ↗'); go.href = row.url; go.target = '_blank'; go.rel = 'noopener noreferrer'; original.append(go); tr.append(original);
      refs.body.append(tr);
    }
  }
  function mount() {
    host = document.createElement('div'); host.id = 'dy-worklist-extension'; host.style.cssText = 'all:initial;position:relative;z-index:2147483646';
    host.hidden = !state.author;
    shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style'); style.textContent = CSS; shadow.append(style);
    refs.launcher = button('▤ 作品清单', open, 'launcher'); refs.launcher.setAttribute('aria-expanded', 'false');
    refs.panel = el('section', undefined, 'panel'); refs.panel.hidden = true; refs.panel.setAttribute('aria-label', '作者作品清单');
    const header = el('header'), heading = el('div'); refs.eyebrow = el('span', '', 'eyebrow'); heading.append(refs.eyebrow); refs.name = el('h1'); refs.subtitle = el('p', '', 'subtitle'); heading.append(refs.name, refs.subtitle);
    const windowActions = el('div', undefined, 'window-actions');
    const expand = button('展开', () => { refs.panel.classList.toggle('wide'); expand.textContent = refs.panel.classList.contains('wide') ? '收起' : '展开'; }, 'ghost');
    refs.close = button('关闭 ×', close, 'ghost'); windowActions.append(expand, refs.close); header.append(heading, windowActions);
    const overview = el('div', undefined, 'overview'), countBox = el('div'); refs.count = el('strong', '0'); countBox.append(refs.count, el('span', ' 条视频已读取')); const meta = el('div', undefined, 'overview-meta'); refs.total = el('span'); refs.skipped = el('span'); meta.append(refs.total, refs.skipped); overview.append(countBox, meta);
    const toolbar = el('div', undefined, 'toolbar'); refs.read = button('读取全部', readAll, 'primary'); refs.stop = button('停止', stop, 'secondary'); refs.export = button('导出 Excel', exportExcel, 'secondary export'); toolbar.append(refs.read, refs.stop, button('清理数据', () => clearData(), 'secondary'), refs.export);
    refs.status = el('p', '', 'status'); refs.status.setAttribute('role', 'status'); refs.status.setAttribute('aria-live', 'polite');
    const filters = el('div', undefined, 'filters'); refs.search = el('input'); refs.search.type = 'search'; refs.search.placeholder = '搜索全部已读取的名称、简介或作品 ID'; refs.search.setAttribute('aria-label', '搜索作品'); refs.search.addEventListener('input', () => { state.query = refs.search.value; state.page = 1; scheduleRender(); });
    const sort = el('select'); sort.setAttribute('aria-label', '排序方式');
    for (const [value, label] of [['created:desc', '最新发布'], ['created:asc', '最早发布'], ['likes:desc', '点赞最多'], ['comments:desc', '评论最多'], ['shares:desc', '分享最多']]) { const opt = el('option', label); opt.value = value; sort.append(opt); }
    sort.addEventListener('change', () => { state.sort = sort.value; state.page = 1; scheduleRender(); }); filters.append(refs.search, sort);
    const tableWrap = el('div', undefined, 'table-wrap'), table = el('table'), thead = el('thead'), tr = el('tr');
    for (const label of ['名称 / 发布时间', '简介', '点赞量', '分享量', '评论量', '下载', '原作品']) tr.append(el('th', label)); thead.append(tr); refs.body = el('tbody'); table.append(thead, refs.body); tableWrap.append(table);
    const footer = el('footer'); refs.pager = el('span'); const pageActions = el('div', undefined, 'page-actions'); refs.prev = button('上一页', () => { state.page--; render(); refs.scroller.scrollTop = 0; }, 'ghost'); refs.next = button('下一页', () => { state.page++; render(); refs.scroller.scrollTop = 0; }, 'ghost'); pageActions.append(refs.prev, refs.next); footer.append(refs.pager, pageActions);
    refs.notice = el('p', '搜索、排序和导出覆盖全部已读取数据。关闭侧栏保留数据；刷新、离开页面或切换作者时清理。上限 10,000 条 / 约 32 MiB。', 'notice');
    const scroller = el('div', undefined, 'scroller'); refs.scroller = scroller; scroller.append(tableWrap);
    refs.panel.append(header, overview, toolbar, refs.status, filters, scroller, footer, refs.notice); shadow.append(refs.launcher, refs.panel); document.documentElement.append(host);
    shadow.addEventListener('keydown', e => { if (e.key === 'Escape' && state.opened) { e.stopPropagation(); close(); } });
    render();
  }
  chrome.runtime.onMessage.addListener((m, _sender, respond) => {
    if (m.type === 'open-panel') { switchAuthor(); respond({ ok: Boolean(shadow && open()) }); }
    if (m.type === 'download-state' && m.author === state.author && state.rows.has(m.id)) { state.downloads.set(m.id, { state: m.state, error: m.error, attempt: m.attempt, total: m.total }); scheduleRender(); }
  });
  const CSS = `
    :host([hidden]){display:none!important}
    :host{all:initial;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;color:#223046;font-size:13px;line-height:1.5;color-scheme:light}*{box-sizing:border-box} [hidden]{display:none!important}button,input,select{font:inherit}button,a,input,select,summary{-webkit-tap-highlight-color:transparent}button{cursor:pointer;border:1px solid transparent;border-radius:8px;padding:9px 14px;white-space:nowrap;transition:background .15s}button:disabled{opacity:.45;cursor:not-allowed}button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:3px solid #4cafa7;outline-offset:3px}a{color:#176f67;text-decoration:none}a:hover{text-decoration:underline}.launcher{position:fixed;right:0;top:42%;z-index:2147483646;padding:16px 12px;border-radius:12px 0 0 12px;background:#176f67;color:#fff;box-shadow:0 4px 22px #0002;writing-mode:vertical-rl;letter-spacing:2px}.panel{position:fixed;inset:16px 16px 16px auto;width:min(1130px,calc(100vw - 32px));z-index:2147483647;background:#fff;border:1px solid #dfe5ec;border-radius:18px;box-shadow:0 20px 90px #0e1c3340;display:flex;flex-direction:column;overflow:hidden}.panel.wide{width:calc(100vw - 32px)}header{display:flex;align-items:flex-start;justify-content:space-between;padding:26px 28px 18px;border-bottom:1px solid #edf0f4}.eyebrow{color:#7a8b9f;font-size:10px;font-weight:650;letter-spacing:2px}h1{font-size:25px;letter-spacing:-.5px;line-height:1.3;margin:10px 0 6px;color:#19283c}.subtitle{margin:0;font-size:11px;color:#8894a6}.window-actions{display:flex;gap:4px}.ghost{background:transparent;color:#65758a;padding:7px 10px}.ghost:hover{background:#f0f3f6}.overview{padding:18px 28px;display:flex;align-items:center;justify-content:space-between;background:#fafbfd;color:#7e8b9d}.overview strong{font-size:30px;letter-spacing:-1px;color:#1b3344;font-weight:650}.overview-meta{display:flex;gap:18px;font-size:12px}.toolbar{display:flex;gap:8px;padding:18px 28px 0}.primary{background:#176f67;color:white}.primary:hover{background:#105d56}.secondary{background:#fff;color:#475a71;border-color:#dce3ec}.secondary:hover{background:#f4f7fa}.export{margin-left:auto;border-color:#176f6740;color:#176f67}.status{padding:10px 14px;margin:12px 28px;color:#64778c;background:#f3f6fa;border-radius:7px;font-size:12px;white-space:pre-wrap}.status.loading{background:#ecf6f4;color:#176f67}.status.partial{background:#fff5e5;color:#946515}.status.complete{background:#edf7f1;color:#317455}.filters{display:flex;gap:10px;padding:4px 28px 16px}.filters input{flex:1;min-width:0}.filters input,.filters select{background:white;color:#41546b;border:1px solid #dfe5ed;border-radius:7px;padding:9px 12px}.filters input::placeholder{color:#99a5b5}.scroller{flex:1;min-height:150px;overflow:auto;border-top:1px solid #e9edf3}.table-wrap{min-width:980px}table{border-collapse:separate;border-spacing:0;width:100%;table-layout:fixed}th{position:sticky;top:0;z-index:1;background:#f8fafc;font-size:11px;font-weight:600;color:#77869b;text-align:left;padding:12px 12px;border-bottom:1px solid #e5ebf2}th:first-child{width:26%;padding-left:28px}th:nth-child(2){width:29%}th:nth-child(3),th:nth-child(4),th:nth-child(5){width:9%;text-align:right}th:nth-child(6){width:11%}th:last-child{width:7%}td{vertical-align:top;padding:17px 12px;border-bottom:1px solid #edf1f5;font-size:12px;overflow-wrap:anywhere}td:first-child{padding-left:28px}tr:hover td{background:#fcfdfd}.title-cell a{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-weight:600;font-size:13px;color:#253b50}.title-cell small{display:block;color:#94a0af;font-size:10px;margin-top:8px}.desc-cell{color:#7e8b9e}.desc-cell summary{cursor:pointer;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;list-style:none}.desc-cell details[open] summary{-webkit-line-clamp:1;font-weight:600}.desc-cell p{white-space:pre-wrap;margin:8px 0 0;color:#52647b}.number{text-align:right;font-variant-numeric:tabular-nums;color:#293f54}.unknown{color:#acb6c4}.download{background:#eff6f5;color:#176f67;font-size:11px;padding:5px 9px;border-radius:5px}.download:hover{background:#dcefeb}.saved{display:block;color:#27856f;font-size:10px;margin-top:4px}.download-error{display:block;color:#aa583d;font-size:10px;max-width:120px;margin-top:5px}.empty{text-align:center;padding:70px 24px;color:#98a5b5;white-space:normal}.empty-title{display:block;font-size:18px;font-weight:550;color:#65778d}.empty p{margin-top:10px;font-size:12px}footer{display:flex;align-items:center;justify-content:space-between;padding:10px 28px;border-top:1px solid #e9edf3;color:#8391a4;font-size:11px}.page-actions{display:flex;gap:3px}.notice{font-size:10px;color:#99a5b4;margin:0;padding:0 28px 12px}@media(max-width:700px){header{padding:18px}.toolbar,.filters{padding-left:18px;padding-right:18px}.overview{padding:12px 18px}.overview-meta{display:block}.overview-meta span{display:block}.status{margin-left:18px;margin-right:18px}.panel{inset:8px;width:calc(100vw - 16px)}.panel.wide{width:calc(100vw - 16px)}.notice{padding-left:18px;padding-right:18px}.window-actions{gap:0}h1{font-size:21px}}
  `;
  switchAuthor();
  window.addEventListener('pagehide', () => clearData());
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true }); else mount();
  window.addEventListener('popstate', switchAuthor);
  window.addEventListener('hashchange', switchAuthor);
  setInterval(switchAuthor, 750);
})();
