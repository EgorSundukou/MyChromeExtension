// content.js
(() => {
  // Не даем запускать второй раз в той же вкладке
  if (window.__autoDeclineInjected) return;
  window.__autoDeclineInjected = true;

  // Флаг работы скрипта
  window.__autoDeclineRunning = false;

  // Слушаем команды от background / popup
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return;

    if (msg.type === "start") {
      console.log('[autoDeclineFB] Получена команда START');
      if (!window.__autoDeclineRunning) ensureRunner();
    }

    if (msg.type === "stop") {
      console.log('[autoDeclineFB] Получена команда STOP');
      window.__autoDeclineRunning = false;
    }
  });

  // Автозапуск можно оставить или закомментировать, если нужен только через popup
  // ensureRunner();

  function ensureRunner() {
    if (window.__autoDeclineRunning) return;
    window.__autoDeclineRunning = true;
    autoDeclineFB().finally(() => {
      window.__autoDeclineRunning = false;
    });
  }

  async function autoDeclineFB(opts = {}) {
    const settings = {
      textPatterns: opts.textPatterns || [
        'decline','reject','remove',
        'отклон','отклонить','отказать','удалить'
      ],
      clickDelay: () => 3000 + Math.random() * 1000, // 3–4 сек
      afterBatchDelay: opts.afterBatchDelay ?? 1200,
      idleTimeout: opts.idleTimeout ?? 90000,
      maxCycles: opts.maxCycles ?? 500,
      scrollWait: 5000,
      endScrollDelay: 1500,
      stableScrollChecks: 3,
      endPageScrolls: 10,
      activeTabIntervalMin: 3000,
      activeTabIntervalMax: 4000
    };

    const textRegex = new RegExp(settings.textPatterns.join('|'), 'i');
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    const isVisible = (el) => {
      if (!el) return false;
      const rects = el.getClientRects();
      if (rects.length === 0) return false;
      const st = window.getComputedStyle(el);
      return st && st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
    };

    const candidateText = (el) => {
      try {
        return (el.innerText || el.textContent || '') + ' ' + (el.getAttribute && (el.getAttribute('aria-label') || ''));
      } catch {
        return '';
      }
    };

    const findActionButtons = () => {
      const nodes = Array.from(document.querySelectorAll('[role="button"], button, a'));
      return nodes.filter(el => !el.dataset.__auto_declined && isVisible(el) && textRegex.test(candidateText(el).trim()));
    };

    const humanClick = (el) => {
      try {
        el.dataset.__auto_declined = '1';
        el.focus();
        el.click();
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        el.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, cancelable: true }));
        el.dispatchEvent(new MouseEvent('click',     { bubbles: true, cancelable: true }));
      } catch (e) { console.warn('Click failed', e, el); }
    };

    // Имитация активности вкладки
    const heartbeat = () => {
      window.scrollBy(0, 0);
      requestAnimationFrame(() => {});
    };
    let keepActiveTimer = null;
    const scheduleHeartbeat = () => {
      const t = settings.activeTabIntervalMin + Math.random() * (settings.activeTabIntervalMax - settings.activeTabIntervalMin);
      keepActiveTimer = setTimeout(() => {
        heartbeat();
        scheduleHeartbeat();
      }, t);
    };
    scheduleHeartbeat();

    console.log('autoDeclineFB: стартую. Паттерн:', textRegex);
    let lastActionTime = Date.now();
    let cycles = 0;
    let lastScrollHeight = document.documentElement.scrollHeight;
    let stableScrollCount = 0;

    try {
      while (window.__autoDeclineRunning) {
        cycles++;
        let buttons = findActionButtons();

        if (buttons.length > 0) {
          console.log(`Найдено ${buttons.length} кнопок — кликаю...`);
          for (const btn of buttons) {
            humanClick(btn);
            lastActionTime = Date.now();
            await sleep(settings.clickDelay());
          }
          await sleep(settings.afterBatchDelay);
        }

        // Скроллим на целую высоту окна
        const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
        const nextScroll = Math.min(window.scrollY + window.innerHeight, maxScroll);
        window.scrollTo({ top: nextScroll, behavior: 'auto' });
        await sleep(settings.scrollWait);

        // Проверка конца страницы
        const currentScrollHeight = document.documentElement.scrollHeight;
        if (window.scrollY >= maxScroll && currentScrollHeight === lastScrollHeight) {
          stableScrollCount++;
        } else {
          stableScrollCount = 0;
          lastScrollHeight = currentScrollHeight;
        }

        if (stableScrollCount >= settings.stableScrollChecks) {
          console.log('autoDeclineFB: достигнут конец страницы, делаем доп. скроллы...');
          let foundButtons = findActionButtons();
          for (let i = 0; i < settings.endPageScrolls && foundButtons.length === 0; i++) {
            const next = Math.min(window.scrollY + window.innerHeight, maxScroll);
            window.scrollTo({ top: next, behavior: 'auto' });
            await sleep(settings.endScrollDelay);
            foundButtons = findActionButtons();
          }
          if (foundButtons.length > 0) {
            console.log(`Найдено ${foundButtons.length} кнопок после доп. скроллов — продолжаем.`);
            lastActionTime = Date.now();
            stableScrollCount = 0;
            continue;
          } else {
            console.log('autoDeclineFB: конец страницы и кнопок больше нет — выхожу.');
            break;
          }
        }

        // idleTimeout
        if (Date.now() - lastActionTime >= settings.idleTimeout) {
          console.log('autoDeclineFB: проверка перед остановкой из-за idleTimeout...');
          let retryFound = false;
          for (let i = 0; i < 3; i++) {
            await sleep(2000 + Math.random() * 1000);
            const retryButtons = findActionButtons();
            if (retryButtons.length > 0) {
              console.log(`Найдено ${retryButtons.length} кнопок на повторной проверке — продолжаем.`);
              lastActionTime = Date.now();
              retryFound = true;
              break;
            }
          }
          if (!retryFound) {
            console.log('autoDeclineFB: кнопок нет, timeout реально наступил — выхожу.');
            break;
          }
        }

        if (cycles >= settings.maxCycles) {
          console.log('autoDeclineFB: достигнут лимит циклов — выхожу.');
          break;
        }
      }
    } finally {
      if (keepActiveTimer) clearTimeout(keepActiveTimer);
      console.log('autoDeclineFB: закончено.');
    }
  }
})();
