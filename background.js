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
  if (info.menuItemId === 'link') return deliver({ url: info.linkUrl });
  // Extract in place: the tab is already rendered with the real session and currency.
  let entry;
  try {
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['extract.js'] });
    entry = { ...result, hydratedAt: Date.now() };
  } catch {
    entry = { url: tab.url }; // can't inject here; let the dashboard try hydrating it
  }
  return deliver(entry);
});

// The dashboard owns the items list, so hand the entry to it. If none is open the message
// rejects; park the entry in `pending` and the dashboard drains it on next load.
function deliver(entry) {
  return chrome.runtime.sendMessage(entry).catch(async () => {
    const { pending = [] } = await chrome.storage.local.get('pending');
    await chrome.storage.local.set({ pending: [...pending, entry] });
  });
}
