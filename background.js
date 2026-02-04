chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "updateBadge") {
    const count = msg.count || 0;
    chrome.action.setBadgeText({ text: count > 0 ? String(count) : "" });
    chrome.action.setBadgeBackgroundColor({ color: "#00ff88" });
    chrome.action.setBadgeTextColor({ color: "#1a1a2e" });
    sendResponse({ ok: true });
  }
});
