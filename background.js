// Toolbar click: focus the dashboard tab if one is open, otherwise open one.
chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL('dashboard.html');
  const [tab] = await chrome.tabs.query({ url });
  if (tab) {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
});

// ---- right-click add ----

const HTTP = ['http://*/*', 'https://*/*'];
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'page', title: 'Add page to Shortlist', contexts: ['page', 'image', 'selection'], documentUrlPatterns: HTTP });
  chrome.contextMenus.create({ id: 'link', title: 'Add link to Shortlist', contexts: ['link'], targetUrlPatterns: HTTP });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const entry = info.menuItemId === 'link' ? { url: info.linkUrl } : await extractPage(tab);
  await deliver(entry);
  const u = new URL(entry.url);
  toast(tab.id, `Added to Shortlist · ${entry.title ?? u.host + u.pathname}`);
});

// Extract in place: the tab is already rendered with the real session and currency.
async function extractPage(tab) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['extract.js'] });
    return { ...result, hydratedAt: Date.now() };
  } catch {
    return { url: tab.url }; // can't inject here; let the dashboard try hydrating it
  }
}

// Brief confirmation injected into the page the user is looking at. Best effort: it fails on
// the same pages extraction does, and there's nothing useful to do about that.
function toast(tabId, text) {
  return chrome.scripting.executeScript({
    target: { tabId },
    args: [text],
    func: text => {
      const el = document.createElement('div');
      el.textContent = text;
      el.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647;max-width:360px;padding:10px 14px;'
        + 'background:#111;color:#fff;font:13px/1.3 system-ui,sans-serif;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.25);'
        + 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none;transition:opacity .3s';
      document.documentElement.append(el);
      setTimeout(() => { el.style.opacity = 0; setTimeout(() => el.remove(), 300); }, 1500);
    },
  }).catch(() => {});
}

// The dashboard owns the items list, so hand the entry to it. If none is open the message
// rejects; park the entry in `pending` and the dashboard drains it on next load.
function deliver(entry) {
  return chrome.runtime.sendMessage(entry).catch(async () => {
    const { pending = [] } = await chrome.storage.local.get('pending');
    await chrome.storage.local.set({ pending: [...pending, entry] });
  });
}
