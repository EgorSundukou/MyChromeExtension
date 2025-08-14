// background.js (MV3 service worker)

chrome.runtime.onInstalled.addListener(() => {
  console.log("Auto Decline FB: installed");
  // Периодический «тик», чтобы поддерживать процесс (1 раз в минуту — мин. период для alarms)
  chrome.alarms.create("decliner-tick", { periodInMinutes: 1 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "decliner-tick") {
    pingAllGroupTabs();
  }
});

// Пингуем все открытые вкладки с facebook-группами
function pingAllGroupTabs() {
  chrome.tabs.query({ url: ["*://www.facebook.com/groups/*", "*://facebook.com/groups/*"] }, (tabs) => {
    for (const tab of tabs) {
      // пробуем отправить «tick»; контент-скрипт сам решит, что делать
      chrome.tabs.sendMessage(tab.id, { type: "tick" }, () => { /* игнор */ });
    }
  });
}

// Когда вкладка загрузилась — посылаем «start»
// chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
//   if (!tab || !tab.url) return;
//   const isGroup = tab.url.includes("facebook.com/groups/");
//   if (changeInfo.status === "complete" && isGroup) {
//     chrome.tabs.sendMessage(tabId, { type: "start" }, () => { /* игнор */ });
//   }
// });
