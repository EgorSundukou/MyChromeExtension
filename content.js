// content.js
// Version: 2.0.0-refactor
// Implements: Modularization (#7), Async/Await (#8)

(() => {
  if (window.__autoDeclineInjected) {
    console.log('[AutoDeclineFB] Script already injected.');
    return;
  }
  window.__autoDeclineInjected = true;

  // --- Configuration ---
  const Config = {
    VERSION: '2.0.0',
    STORAGE_KEY: '__autoDeclineUserStarted',
    STATS_KEY: '__autoDeclineStats',
    TEXT_PATTERNS: [
      'decline', 'reject', 'remove',
      'отклон', 'отклонить', 'отказать', 'удалить'
    ],
    // Timeouts & Delays (ms)
    DELAYS: {
      CLICK_MIN: 1000,
      CLICK_MAX: 1500,
      AFTER_BATCH: 1200,
      AFTER_CLICK: 700,
      SCROLL_WAIT: 4000,
      END_SCROLL: 1500,
      RELOAD: 5000,
      ACTIVE_TAB_MIN: 3000,
      ACTIVE_TAB_MAX: 4000,
      IDLE_TIMEOUT: 90000,
    },
    LIMITS: {
      TICK_RETRY: 3,
      CLICK_FAIL: 5,
      SOFT_RECOVERY_ATTEMPTS: 2,
      MAX_CYCLES: 500,
    },
    FLAGS: {
      CLICK_FAIL_SOFT_RECOVERY: true,
    }
  };

  // --- Logger ---
  const Logger = {
    prefix: `[AutoDeclineFB v${Config.VERSION}]`,
    log: (...args) => console.log(Logger.prefix, ...args),
    warn: (...args) => console.warn(Logger.prefix, ...args),
    error: (...args) => console.error(Logger.prefix, ...args),
  };

  // --- Utils ---
  const Utils = {
    sleep: (ms) => new Promise(resolve => setTimeout(resolve, ms)),

    randomDelay: (min, max) => min + Math.random() * (max - min),

    isVisible: (el) => {
      if (!el) return false;
      try {
        const rects = el.getClientRects();
        if (!rects || rects.length === 0) return false;
        const st = window.getComputedStyle(el);
        if (!st) return false;
        return st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
      } catch (e) { return false; }
    },

    candidateText: (el) => {
      try {
        return ((el.innerText || el.textContent || '') + ' ' + (el.getAttribute && (el.getAttribute('aria-label') || ''))).trim();
      } catch { return ''; }
    },

    loadStats: () => {
      const stored = localStorage.getItem(Config.STATS_KEY);
      return stored ? parseInt(stored, 10) : 0;
    },

    saveStats: (count) => {
      localStorage.setItem(Config.STATS_KEY, count);
    },

    incrementStats: () => {
      const current = Utils.loadStats();
      Utils.saveStats(current + 1);
      return current + 1;
    }
  };

  // --- DOM Interaction ---
  const DOM = {
    findActionButtons: (textRegex) => {
      try {
        const nodes = Array.from(document.querySelectorAll('[role="button"], button, a'));
        return nodes.filter(el => {
          if (!el || el.dataset && el.dataset.__auto_declined) return false;
          if (!Utils.isVisible(el)) return false;
          const txt = Utils.candidateText(el);
          return txt && textRegex.test(txt);
        });
      } catch (e) {
        Logger.warn('findActionButtons error:', e);
        return [];
      }
    },

    scrollTo: async (top) => {
      window.scrollTo({ top, behavior: 'auto' });
      // await Utils.sleep(100); // optional micro-wait
    }
  };

  // --- Click Logic ---
  const Clicker = {
    failCount: 0,

    tryClick: async (el, textRegex) => {
      if (!el) return false;
      const maxAttempts = 3;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        // Stop check could be inserted here if we had a global abort signal
        if (!State.isRunning) return false;

        Logger.log(`Click Attempt ${attempt} on`, el);

        try {
          el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
        } catch (e) { }

        await Utils.sleep(Utils.randomDelay(60, 140));

        const rect = el.getBoundingClientRect();
        const cx = Math.round(rect.left + rect.width / 2);
        const cy = Math.round(rect.top + rect.height / 2);

        // Strategy depends on attempt number
        try {
          if (attempt === 1) Clicker.methodStandard(el, cx, cy);
          else if (attempt === 2) await Clicker.methodPointer(el, cx, cy);
          else Clicker.methodElementFromPoint(el, cx, cy);
        } catch (e) {
          Logger.warn(`Method ${attempt} failed`, e);
        }

        await Utils.sleep(Utils.randomDelay(300, 700));

        // Verification
        if (Clicker.verifySuccess(el, textRegex)) {
          Clicker.failCount = 0;
          Utils.incrementStats(); // Update stats
          return true;
        }
      }

      Clicker.failCount++;
      Logger.warn('All click attempts failed. Fail count:', Clicker.failCount);
      return false;
    },

    methodStandard: (el, cx, cy) => {
      ['mouseover', 'mousemove', 'mousedown'].forEach(type => {
        el.dispatchEvent(new MouseEvent(type, { view: window, bubbles: true, cancelable: true, clientX: cx, clientY: cy }));
      });
      el.click();
      ['mouseup', 'click'].forEach(type => {
        el.dispatchEvent(new MouseEvent(type, { view: window, bubbles: true, cancelable: true, clientX: cx, clientY: cy }));
      });
    },

    methodPointer: async (el, cx, cy) => {
      const opts = { bubbles: true, cancelable: true, pointerType: 'mouse', clientX: cx, clientY: cy, isPrimary: true };
      el.dispatchEvent(new PointerEvent('pointerdown', opts));
      await Utils.sleep(20);
      el.dispatchEvent(new PointerEvent('pointerup', opts));
      await Utils.sleep(10);
      el.click();
    },

    methodElementFromPoint: (el, cx, cy) => {
      const target = document.elementFromPoint(cx, cy) || el;
      // Standard sequence on the potentially covering element
      Clicker.methodStandard(target, cx, cy);
    },

    verifySuccess: (el, textRegex) => {
      try {
        const stillInDom = document.contains(el);
        const visible = stillInDom && Utils.isVisible(el);
        const textValues = stillInDom ? Utils.candidateText(el) : '';
        const matches = textRegex.test(textValues);

        const success = !stillInDom || !visible || !matches;

        if (success) {
          if (stillInDom) el.dataset.__auto_declined = '1';
          return true;
        }
        return false;
      } catch (e) {
        Logger.warn('Verification error:', e);
        return false;
      }
    }
  };

  // --- Core Logic ---
  const State = {
    isRunning: false,
    heartbeatTimer: null,
    tickNoButtonsCount: 0,
    softRecoveryAttempts: 0,
    lastActionTime: 0
  };

  const Navigation = {
    softRecovery: async () => {
      Logger.log('Executing Soft Recovery (scrolling)...');
      try {
        const step = Math.max(200, Math.round((window.innerHeight || 800) * 0.15));
        for (let i = 0; i < 3; i++) {
          if (!State.isRunning) break;
          const target = Math.min(document.documentElement.scrollHeight - window.innerHeight, window.scrollY + step);
          await DOM.scrollTo(target);
          await Utils.sleep(600);
        }
        await Utils.sleep(400);
      } catch (e) { Logger.warn('SoftRecovery error:', e); }
    },

    progressiveScroll: async (findCallback) => {
      Logger.log('Starting Progressive Scroll...');
      const totalHeight = Math.max(document.documentElement.scrollHeight, 1);
      const maxScroll = Math.max(0, totalHeight - window.innerHeight);

      // Quarter Steps (Increased for more granual load attempts)
      for (let i = 1; i <= 10; i++) {
        if (!State.isRunning) return false;
        // Calculate target relative to total height, but ensuring we move past current scroll
        const target = Math.min(maxScroll, Math.round(totalHeight * (i * 0.1))); // 10% increments

        // If we are already past this target, just scroll down a bit more
        const effective = target > window.scrollY ? target : Math.min(maxScroll, window.scrollY + window.innerHeight * 0.5);

        Logger.log(`Scroll Step (Small) ${i}/10 to ${effective}`);
        await DOM.scrollTo(effective);
        await Utils.sleep(Config.DELAYS.SCROLL_WAIT);

        if (findCallback().length > 0) return true;
      }

      // Full Page Steps (Increased depth for long lists)
      for (let j = 1; j <= 15; j++) {
        if (!State.isRunning) return false;
        const next = Math.min(window.scrollY + window.innerHeight, maxScroll);

        if (next <= window.scrollY && window.scrollY >= maxScroll) {
          Logger.log('Reached bottom of page.');
          break;
        }

        Logger.log(`Scroll Step (Full) ${j}/15 to ${next}`);
        await DOM.scrollTo(next);
        // FORCE a small scroll up and down to trigger lazy loaders
        window.scrollBy(0, -10);
        await Utils.sleep(100);
        window.scrollBy(0, 10);

        await Utils.sleep(Config.DELAYS.END_SCROLL);

        if (findCallback().length > 0) return true;
      }
      return false;
    }
  };

  const Heartbeat = {
    start: () => {
      if (State.heartbeatTimer) clearTimeout(State.heartbeatTimer);
      const run = () => {
        if (!State.isRunning) return;
        // Micro-scroll to keep tab active
        window.scrollBy(0, 0);
        requestAnimationFrame(() => { });

        const delay = Utils.randomDelay(Config.DELAYS.ACTIVE_TAB_MIN, Config.DELAYS.ACTIVE_TAB_MAX);
        State.heartbeatTimer = setTimeout(run, delay);
      };
      run();
    },
    stop: () => {
      if (State.heartbeatTimer) clearTimeout(State.heartbeatTimer);
      State.heartbeatTimer = null;
    }
  };

  const Main = {
    start: async () => {
      if (State.isRunning) return;
      State.isRunning = true;
      localStorage.setItem(Config.STORAGE_KEY, 'true');
      Logger.log('Started.');

      Heartbeat.start();

      const textRegex = new RegExp(Config.TEXT_PATTERNS.join('|'), 'i');
      State.lastActionTime = Date.now();

      try {
        while (State.isRunning) {
          const buttons = DOM.findActionButtons(textRegex);

          if (buttons.length > 0) {
            Logger.log(`Found ${buttons.length} buttons.`);
            const success = await Clicker.tryClick(buttons[0], textRegex);

            if (success) {
              State.lastActionTime = Date.now();
              await Utils.sleep(Config.DELAYS.AFTER_CLICK);
              continue;
            } else {
              // Click failed
              if (Config.FLAGS.CLICK_FAIL_SOFT_RECOVERY && Clicker.failCount >= Config.LIMITS.CLICK_FAIL) {
                Logger.warn('Click fail limit reached. Attempting recovery.');
                await Navigation.softRecovery();
                if (Clicker.failCount >= Config.LIMITS.CLICK_FAIL) {
                  Main.handlePersistentFailure('Click failures persist');
                  return; // Stop/Reload triggers inside handlePersistentFailure
                }
              } else {
                await Utils.sleep(300);
                continue;
              }
            }
          }

          // No buttons found
          Logger.log('No buttons found. Attempting scroll...');
          const foundAfterScroll = await Navigation.progressiveScroll(() => DOM.findActionButtons(textRegex));
          if (foundAfterScroll) continue;

          // Retry after wait
          await Utils.sleep(800);
          if (DOM.findActionButtons(textRegex).length > 0) continue;

          // Soft Recovery
          State.softRecoveryAttempts++;
          if (State.softRecoveryAttempts <= Config.LIMITS.SOFT_RECOVERY_ATTEMPTS) {
            await Navigation.softRecovery();
            if (DOM.findActionButtons(textRegex).length > 0) continue;
          }

          // Check Idle / Persistent Failure
          if (localStorage.getItem(Config.STORAGE_KEY) === 'true') {
            Main.handlePersistentFailure('No buttons found after all attempts');
            return;
          } else {
            Logger.log('No buttons found and user did not auto-start. Stopping.');
            Main.stop();
            break;
          }
        }
      } catch (e) {
        Logger.error('Main loop crash:', e);
      } finally {
        Main.stop();
      }
    },

    stop: () => {
      State.isRunning = false;
      localStorage.removeItem(Config.STORAGE_KEY);
      Heartbeat.stop();
      Logger.log('Stopped.');
    },

    handlePersistentFailure: async (reason) => {
      Logger.warn(`${reason} -> Reloading page...`);
      // We pause briefly to ensure logs are written/seen
      if (localStorage.getItem(Config.STORAGE_KEY) === 'true') {
        try { location.reload(); } catch (e) { Logger.error('Reload failed', e); }
        await Utils.sleep(Config.DELAYS.RELOAD);
      } else {
        Main.stop();
      }
    }
  };

  // --- Message Handling ---
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // Ignore updates from other extensions if any
    if (sender.id && sender.id !== chrome.runtime.id) return;

    switch (msg.type) {
      case 'start':
        Main.start();
        sendResponse({ ok: true });
        break;
      case 'stop':
        Main.stop();
        sendResponse({ ok: true });
        break;
      case 'status':
        sendResponse({
          running: State.isRunning,
          stats: Utils.loadStats()
        });
        break;
      case 'tick':
        if (!State.isRunning) {
          // Check auto-start on content load / reload
          // But this is just a 'tick' from background. Ideally we only check logic.
        }
        break;
    }
  });

  // --- Auto-Start on Load ---
  window.addEventListener('load', () => {
    if (localStorage.getItem(Config.STORAGE_KEY) === 'true') {
      setTimeout(() => Main.start(), 1000);
    }
  });

  Logger.log('Ready.');

})();
