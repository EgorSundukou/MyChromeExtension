// popup.js
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const statusDiv = document.getElementById("status");
const statsCountDiv = document.getElementById("statsCount");
const groupProgressDiv = document.getElementById("groupProgress");
const totalStatsCountDiv = document.getElementById("totalStatsCount");
const resetTotalBtn = document.getElementById("resetTotalBtn");
const maxDeclinesInput = document.getElementById("maxDeclines");
const minDelayInput = document.getElementById("minDelay");
const maxDelayInput = document.getElementById("maxDelay");
const spreadsheetUrlInput = document.getElementById("spreadsheetUrl");
const reloadGroupsBtn = document.getElementById("reloadGroupsBtn");

const DEFAULT_SPREADSHEET_URL = ""; // Enter your Google Sheet URL here

// --- Event Listeners ---
startBtn.addEventListener("click", () => {
  setStatus("Starting...");
  sendMessageToActiveTab({ type: "start" }, (res) => {
    if (res && res.ok) setStatus("Running...");
  });
  // Auto-refresh stats/status a bit later
  setTimeout(updateUI, 1000);
});

stopBtn.addEventListener("click", () => {
  setStatus("Stopping...");
  sendMessageToActiveTab({ type: "stop" }, (res) => {
    if (res && res.ok) setStatus("Stopped.");
  });
  setTimeout(updateUI, 500);
});

// --- Settings Handling ---
function saveSettings() {
  const settings = {
    maxDeclines: parseInt(maxDeclinesInput.value, 10) || 0,
    minDelay: parseFloat(minDelayInput.value) || 1,
    maxDelay: parseFloat(maxDelayInput.value) || 2,
    spreadsheetUrl: spreadsheetUrlInput.value.trim()
  };
  chrome.storage.local.set({ settings }, () => {
    console.log("Settings saved:", settings);
  });
}

maxDeclinesInput.addEventListener("change", saveSettings);
minDelayInput.addEventListener("change", saveSettings);
maxDelayInput.addEventListener("change", saveSettings);
spreadsheetUrlInput.addEventListener("change", saveSettings);

reloadGroupsBtn.addEventListener("click", () => {
  const url = spreadsheetUrlInput.value.trim();
  if (!url) {
    setStatus("Please enter a spreadsheet URL.");
    return;
  }
  setStatus("Reloading group list...");

  // Get active tab ID to reset its specific counter
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tabId = tabs[0] ? tabs[0].id : null;
    chrome.runtime.sendMessage({ type: "reloadGroupList", url, tabId }, (response) => {
      if (response && response.ok) {
        setStatus(`Loaded ${response.count} groups.`);
      } else {
        setStatus("Failed to load group list.");
      }
    });
  });
});

resetTotalBtn.addEventListener("click", () => {
  if (confirm("Вы уверены, что хотите сбросить общий счетчик?")) {
    chrome.storage.local.set({ totalStats: 0 }, () => {
      totalStatsCountDiv.textContent = 0;
      setStatus("Total stats reset.");
    });
  }
});

// --- UI Updates ---
function setStatus(text) {
  if (statusDiv) statusDiv.textContent = text;
}

function setStats(count) {
  if (statsCountDiv) statsCountDiv.textContent = count || 0;
}

function setTotalStats(count) {
  if (totalStatsCountDiv) totalStatsCountDiv.textContent = count || 0;
}

function updateUI() {
  // Update Tab Stats
  // We use skipInject=true here to avoid console spam if the script is not present
  sendMessageToActiveTab({ type: "status" }, (response) => {
    if (response) {
      setStatus(response.running ? "Running..." : "Stopped.");
      setStats(response.stats);
    } else {
      setStatus("Script not running on this page.");
    }
  }, true);

  // Update Global Stats
  chrome.storage.local.get(["totalStats", "groupList", "activeTabId"], (data) => {
    setTotalStats(data.totalStats);

    // Update Group Progress
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || !tabs[0]) return;
      const tabId = tabs[0].id;
      const indexKey = `__lastGroupIndex_${tabId}`;

      chrome.storage.local.get([indexKey, "groupList"], (innerData) => {
        const list = innerData.groupList || [];
        const currentIndex = innerData[indexKey] || 0;

        if (list.length > 0) {
          groupProgressDiv.textContent = `${currentIndex + 1} из ${list.length}`;
        } else {
          groupProgressDiv.textContent = "Одна группа";
        }
      });
    });
  });
}

// --- Messaging Logic ---
function sendMessageToActiveTab(msg, callback, skipInject = false) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs || !tabs[0]) {
      setStatus("No active tab.");
      return;
    }
    const tab = tabs[0];
    const tabId = tab.id;
    const url = tab.url || "";

    // Skip internal chrome:// pages or other non-supported schemes
    if (!url.startsWith("http")) {
      setStatus("Extension not available on this page.");
      return;
    }

    // Send message
    chrome.tabs.sendMessage(tabId, msg, (response) => {
      if (chrome.runtime.lastError) {
        console.log("sendMessage info:", chrome.runtime.lastError.message);
        // If content script is missing, try to inject ONLY if it is a control message (start/stop)
        if (!skipInject) {
          injectContentScriptAndRetry(tabId, msg, callback);
        } else if (msg.type === 'status') {
          // For status, just silently fail or show a simple message
          if (callback) callback(null);
        }
        return;
      }
      if (callback) callback(response);
      handleResponse(msg, response);
    });
  });
}

function injectContentScriptAndRetry(tabId, msg, callback) {
  setStatus("Injecting script...");

  if (chrome.scripting && chrome.scripting.executeScript) {
    chrome.scripting.executeScript(
      { target: { tabId }, files: ["content.js"] },
      () => {
        if (chrome.runtime.lastError) {
          console.error("Injection failed:", chrome.runtime.lastError.message);
          setStatus("Injection failed: " + chrome.runtime.lastError.message);
          return;
        }
        // Success
        setTimeout(() => {
          chrome.tabs.sendMessage(tabId, msg, (response) => {
            if (callback) callback(response);
            handleResponse(msg, response);
          });
        }, 200);
      }
    );
  } else {
    setStatus("Injection API not available.");
  }
}

function handleResponse(msg, response) {
  if (response && response.stats !== undefined) {
    setStats(response.stats);
  }
  // Also refresh status if we just queried it
  if (msg.type === 'status' && !response) {
    setStatus("Script not ready.");
  }
}

// Initial UI check
document.addEventListener('DOMContentLoaded', () => {
  // Load settings
  chrome.storage.local.get(["settings"], (data) => {
    if (data.settings) {
      maxDeclinesInput.value = data.settings.maxDeclines || 0;
      minDelayInput.value = data.settings.minDelay || 1;
      maxDelayInput.value = data.settings.maxDelay || 2;
      spreadsheetUrlInput.value = data.settings.spreadsheetUrl || DEFAULT_SPREADSHEET_URL;
    } else {
      spreadsheetUrlInput.value = DEFAULT_SPREADSHEET_URL;
    }
  });
  updateUI();
});
// Periodic Poll while popup is open
setInterval(updateUI, 2000);
