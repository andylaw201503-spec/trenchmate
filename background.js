// background.js — Service Worker

// Activate on /sol/*, /bsc/* pages and the home page
const VALID_PAGE_RE = /gmgn\.ai($|\/(sol|bsc|robinhood))/;

// Toggle sidebar visibility when extension icon is clicked
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.url || !VALID_PAGE_RE.test(tab.url)) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { action: 'rescan' });
  } catch (e) {
    // Content script not loaded yet — ignore
  }
});

// Relay messages between content script frames if needed
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'openTwitterProfile' && msg.url) {
    chrome.tabs.create({ url: msg.url });
  }
  if (msg.action === 'openTab' && msg.url) {
    const sourceTab = sender.tab;
    chrome.tabs.create({
      url: msg.url,
      active: false,
      windowId: sourceTab?.windowId,
      index: sourceTab ? sourceTab.index + 1 : undefined,
      openerTabId: sourceTab?.id
    });
  }
  if (msg.action === 'fetchPumpApi' && typeof msg.url === 'string') {
    // gmgn.ai's page CSP connect-src blocks pump.fun hosts, and content-script
    // fetches inherit the page CSP — so pump.fun API calls are proxied here,
    // where the extension's host permissions grant a CORS-free fetch.
    let target = null;
    try { target = new URL(msg.url); } catch (e) { /* rejected below */ }
    const allowed = target && target.protocol === 'https:' &&
      (target.hostname === 'pump.fun' || target.hostname.endsWith('.pump.fun'));
    if (!allowed) {
      sendResponse({ ok: false, error: 'blocked' });
      return false;
    }
    fetch(target.href)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true; // async sendResponse
  }
  return false;
});
