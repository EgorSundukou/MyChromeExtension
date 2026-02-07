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
