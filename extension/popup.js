'use strict';
document.getElementById('open').addEventListener('click', async () => {
  const status = document.getElementById('status');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('请先打开抖音或 TikTok 作者主页。');
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'open-panel' });
    if (!response?.ok) throw new Error('请先进入抖音或 TikTok 作者主页。');
    window.close();
  } catch { status.textContent = '请进入抖音或 TikTok 作者主页后重试。首次安装或更新插件后，请先刷新作者页面。'; }
});
