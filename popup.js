const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const statusBtn = document.getElementById("statusBtn");
const statusDiv = document.getElementById("status");

startBtn.addEventListener("click", () => {
  sendMessageToActiveTab({ type: "start" });
});

stopBtn.addEventListener("click", () => {
  sendMessageToActiveTab({ type: "stop" });
});

statusBtn.addEventListener("click", () => {
  sendMessageToActiveTab({ type: "status" });
});

function sendMessageToActiveTab(msg) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return;
    chrome.tabs.sendMessage(tabs[0].id, msg, (response) => {
      if (msg.type === "status") {
        statusDiv.textContent = response?.running ? "Скрипт работает" : "Скрипт остановлен";
      }
    });
  });
}
