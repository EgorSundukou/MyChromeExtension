// background.js (MV3 service worker)

chrome.runtime.onInstalled.addListener(() => {
  console.log("Auto Decline FB: installed");
  // Periodic 'tick' needed to keep the service worker alive and check content script health
  chrome.alarms.create("decliner-tick", { periodInMinutes: 1 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "decliner-tick") {
    pingAllGroupTabs();
  }
});

// Pings all open Facebook group tabs
function pingAllGroupTabs() {
  chrome.tabs.query({ url: ["*://www.facebook.com/groups/*", "*://facebook.com/groups/*"] }, (tabs) => {
    for (const tab of tabs) {
      // Send a 'tick' message; content script can decide what to do
      chrome.tabs.sendMessage(tab.id, { type: "tick" }, () => {
        if (chrome.runtime.lastError) {
          // Content script might not be injected or tab is loading
          // We can optionally inject here if needed, but usually popup handles start
        }
      });
    }
  });
}

// Handle messages from content scripts or popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "getTabId") {
    // Return the ID of the tab that sent the message
    sendResponse({ tabId: sender.tab ? sender.tab.id : null });
  } else if (message.type === "reloadGroupList") {
    handleReloadGroups(message.url, sendResponse, message.tabId);
    return true; // async
  } else if (message.type === "limitReached") {
    handleNavigationToNextGroup(sender.tab.id);
  }
  return true; // Keep channel open for async response
});

async function handleReloadGroups(url, sendResponse, tabId = null) {
  try {
    // Convert Google Sheets URL to CSV export URL
    let csvUrl = url;
    if (url.includes('/edit')) {
      const match = url.match(/\/d\/([^\/]+)/);
      const gidMatch = url.match(/gid=([0-9]+)/);
      if (match) {
        csvUrl = `https://docs.google.com/spreadsheets/d/${match[1]}/export?format=csv`;
        if (gidMatch) csvUrl += `&gid=${gidMatch[1]}`;
      }
    }

    console.log("[AutoDeclineFB] Fetching groups from:", csvUrl);
    const response = await fetch(csvUrl);
    const text = await response.text();

    // Parse CSV: Column G (index 6) starting from row 25
    const rows = text.split(/\r?\n/);
    const urls = [];
    for (let i = 24; i < rows.length; i++) {
      const cols = rows[i].split(',');
      if (cols[6]) {
        let groupUrl = cols[6].trim().replace(/^"(.*)"$/, '$1'); // Remove quotes
        if (groupUrl.startsWith('http')) {
          urls.push(groupUrl);
        }
      }
    }

    console.log(`[AutoDeclineFB] Loaded ${urls.length} valid group URLs.`);
    // Store globally as a pool or per-tab? User said "next group", 
    // implying a shared list for navigation.
    await chrome.storage.local.set({ groupList: urls });

    // Reset counter for this tab so it starts fresh triggers from index 0 again
    if (tabId !== null) {
      console.log(`[AutoDeclineFB] Resetting group index for tab ${tabId} to -1`);
      // We set to -1 so that the next "increment" (0+1 or -1+1) logic works out to target index 0
      await chrome.storage.local.set({ [`__lastGroupIndex_${tabId}`]: -1 });
    }

    sendResponse({ ok: true, count: urls.length });
  } catch (e) {
    console.error("[AutoDeclineFB] Failed to reload group list:", e);
    sendResponse({ ok: false, error: e.message });
  }
}

async function handleNavigationToNextGroup(tabId) {
  try {
    const data = await chrome.storage.local.get(["groupList", "settings", `__lastGroupIndex_${tabId}`]);
    if (!data.groupList || data.groupList.length === 0) return;

    let nextIndex = (data[`__lastGroupIndex_${tabId}`] || 0) + 1;
    if (nextIndex >= data.groupList.length) {
      console.log("[AutoDeclineFB] Reached end of group list.");
      // Optional: loop back to 0? User didn't specify. Let's stop to be safe.
      // Actually, let's just stop or loop. 
      return;
    }

    let nextUrl = data.groupList[nextIndex];
    if (nextUrl) {
      // Clean URL: remove trailing slashes and the '/edit' suffix if present
      nextUrl = nextUrl.trim().replace(/\/edit\/?$/, "").replace(/\/$/, "");
      nextUrl += "/spam";
    }

    console.log(`[AutoDeclineFB] Navigating tab ${tabId} to next group: ${nextUrl}`);

    await chrome.storage.local.set({
      [`__lastGroupIndex_${tabId}`]: nextIndex,
      [`__autoDeclineStats_${tabId}`]: 0, // Reset stats for new group
      [`__autoDeclineUserStarted_${tabId}`]: 'true' // Ensure it starts in next group
    });

    // Navigation
    chrome.tabs.update(tabId, { url: nextUrl });
  } catch (e) {
    console.error("[AutoDeclineFB] Navigation failed:", e);
  }
}

// Cleanup storage when tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  const keysToRemove = [
    `__autoDeclineUserStarted_${tabId}`,
    `__autoDeclineStats_${tabId}`,
    `__lastGroupIndex_${tabId}`
  ];
  chrome.storage.local.remove(keysToRemove, () => {
    console.log(`[AutoDeclineFB] Cleaned up storage for tab ${tabId}`);
  });
});
