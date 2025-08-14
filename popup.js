// popup.js (обновлённый)
// Отправляет сообщения в активную вкладку и, если нужно, инжектит content.js и повторяет.
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const statusBtn = document.getElementById("statusBtn");
const statusDiv = document.getElementById("status");

startBtn.addEventListener("click", () => {
  setStatus("Отправляю команду START...");
  sendMessageToActiveTab({ type: "start" });
});

stopBtn.addEventListener("click", () => {
  setStatus("Отправляю команду STOP...");
  sendMessageToActiveTab({ type: "stop" });
});

statusBtn.addEventListener("click", () => {
  setStatus("Запрашиваю статус...");
  sendMessageToActiveTab({ type: "status" });
});

function setStatus(text) {
  if (statusDiv) statusDiv.textContent = text;
}

// Основная функция отправки — пробует послать сообщение, если получит ошибку "no receiver" — инжектит content.js и повторяет
function sendMessageToActiveTab(msg) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs || !tabs[0]) {
      setStatus("Нет активной вкладки");
      return;
    }
    const tabId = tabs[0].id;

    // Отправляем сообщение
    chrome.tabs.sendMessage(tabId, msg, (response) => {
      // Если нет получателя (content script не слушает), chrome.runtime.lastError будет установлен
      if (chrome.runtime.lastError) {
        console.warn("sendMessage error:", chrome.runtime.lastError.message);
        // Попытаться внедрить content.js и повторить
        injectContentScriptAndRetry(tabId, msg);
        return;
      }

      // Если есть ответ — обработаем его
      handleResponse(msg, response);
    });
  });
}

// Внедряет content.js в вкладку (MV3 -> chrome.scripting, иначе MV2 -> chrome.tabs.executeScript) и повторяет отправку
function injectContentScriptAndRetry(tabId, msg) {
  setStatus("Content script не найден — внедряю и повторяю команду...");

  const afterInject = () => {
    // Небольшая задержка чтобы content.js успел инициализироваться
    setTimeout(() => {
      chrome.tabs.sendMessage(tabId, msg, (response) => {
        if (chrome.runtime.lastError) {
          console.error("Повторная отправка сообщения не удалась:", chrome.runtime.lastError.message);
          setStatus("Не удалось связаться с content script: " + chrome.runtime.lastError.message);
          return;
        }
        handleResponse(msg, response);
      });
    }, 400); // 400ms — обычно достаточно; можно увеличить при необходимости
  };

  // MV3: chrome.scripting.executeScript
  if (chrome.scripting && chrome.scripting.executeScript) {
    chrome.scripting.executeScript(
      { target: { tabId }, files: ["content.js"] },
      (injectionResults) => {
        if (chrome.runtime.lastError) {
          console.error("chrome.scripting.executeScript failed:", chrome.runtime.lastError.message);
          setStatus("Ошибка внедрения content.js: " + chrome.runtime.lastError.message);
          return;
        }
        console.log("content.js внедрён (MV3).");
        afterInject();
      }
    );
    return;
  }

  // MV2 fallback: chrome.tabs.executeScript
  if (chrome.tabs && chrome.tabs.executeScript) {
    chrome.tabs.executeScript(tabId, { file: "content.js" }, (res) => {
      if (chrome.runtime.lastError) {
        console.error("chrome.tabs.executeScript failed:", chrome.runtime.lastError.message);
        setStatus("Ошибка внедрения content.js: " + chrome.runtime.lastError.message);
        return;
      }
      console.log("content.js внедрён (MV2).");
      afterInject();
    });
    return;
  }

  setStatus("Невозможно внедрить content.js (API отсутствует).");
}

// Обработка ответов от content.js
function handleResponse(msg, response) {
  if (!msg || !msg.type) return;

  switch (msg.type) {
    case "start":
      setStatus("Команда START отправлена.");
      // Можно обновить UI: например, отключить кнопку start
      break;
    case "stop":
      setStatus("Команда STOP отправлена.");
      break;
    case "status":
      if (!response) {
        setStatus("Нет ответа от content script.");
      } else {
        setStatus(response.running ? "Скрипт работает" : "Скрипт остановлен");
      }
      break;
    default:
      setStatus("Команда отправлена.");
  }
}
