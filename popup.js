// popup.js
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const statusDiv = document.getElementById("status");
const statsCountDiv = document.getElementById("statsCount");

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

// --- UI Updates ---
function setStatus(text) {
  if (statusDiv) statusDiv.textContent = text;
}

function setStats(count) {
  if (statsCountDiv) statsCountDiv.textContent = count || 0;
}

function updateUI() {
  sendMessageToActiveTab({ type: "status" }, (response) => {
    if (response) {
      setStatus(response.running ? "Running..." : "Stopped.");
      setStats(response.stats);
    } else {
      setStatus("Not active on this page.");
    }
  });
}

// --- Messaging Logic ---
function sendMessageToActiveTab(msg, callback) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs || !tabs[0]) {
      setStatus("No active tab.");
      return;
    }
    const tabId = tabs[0].id;

    // Send message
    chrome.tabs.sendMessage(tabId, msg, (response) => {
      if (chrome.runtime.lastError) {
        console.warn("sendMessage error:", chrome.runtime.lastError.message);
        // If content script is missing, try to inject (if allowed by manifest match patterns)
        injectContentScriptAndRetry(tabId, msg, callback);
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
document.addEventListener('DOMContentLoaded', updateUI);
// Periodic Poll while popup is open
setInterval(updateUI, 2000);
