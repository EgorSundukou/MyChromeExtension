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
    EXIT_TEXT: 'Нет спама для показа',
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

    loadStats: async () => {
      const key = `${Config.STATS_KEY}_${State.tabId}`;
      const res = await chrome.storage.local.get([key]);
      return res[key] ? parseInt(res[key], 10) : 0;
    },

    saveStats: async (count) => {
      const key = `${Config.STATS_KEY}_${State.tabId}`;
      await chrome.storage.local.set({ [key]: count });
    },

    incrementStats: async () => {
      // Per-tab stats
      const current = await Utils.loadStats();
      const newTabCount = current + 1;
      await Utils.saveStats(newTabCount);

      // Global total stats
      const totalKey = 'totalStats';
      const data = await chrome.storage.local.get([totalKey]);
      const newTotalCount = (data[totalKey] ? parseInt(data[totalKey], 10) : 0) + 1;
      await chrome.storage.local.set({ [totalKey]: newTotalCount });

      return newTabCount;
    },

    setStarted: async (val) => {
      const key = `${Config.STORAGE_KEY}_${State.tabId}`;
      if (val) await chrome.storage.local.set({ [key]: 'true' });
      else await chrome.storage.local.remove([key]);
    },

    getIsStarted: async () => {
      const key = `${Config.STORAGE_KEY}_${State.tabId}`;
      const res = await chrome.storage.local.get([key]);
      return res[key] === 'true';
    }
  };

  // --- DOM Interaction ---
  const DOM = {
    hasExitText: (text) => {
      return document.body && document.body.innerText.includes(text);
    },

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

        Logger.log(`Click Attempt ${attempt}`);

        try {
          el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
        } catch (e) { }

        // Dynamic Delay from settings
        const data = await chrome.storage.local.get(["settings"]);
        const min = (data.settings?.minDelay || 1) * 1000;
        const max = (data.settings?.maxDelay || 2) * 1000;
        await Utils.sleep(Utils.randomDelay(min, max));

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
          const count = await Utils.incrementStats(); // Update stats (now async)
          State.sessionDeclineCount++;

          // Reset all error counters on any success
          chrome.storage.local.set({
            [`__emptyReloadCount_${State.tabId}`]: 0,
            [`__failedGroupCount_${State.tabId}`]: 0,
            [`__stuckAttemptCount_${State.tabId}`]: 0
          });

          // Check for periodic reload (every 100 declines on same page)
          if (State.sessionDeclineCount >= 100) {
            Logger.log(`Reached 100 declines on this page. Reloading to clear UI memory...`);
            Main.handlePersistentFailure("UI Memory Cleanup");
            return true;
          }

          // Check session limit (max actions per group)
          const data = await chrome.storage.local.get(["settings"]);
          if (data.settings && data.settings.maxDeclines > 0) {
            if (count >= data.settings.maxDeclines) {
              Logger.log(`Limit reached (${count}). Notifying background...`);
              chrome.runtime.sendMessage({ type: "limitReached" });
              await Main.stop();
            }
          }
          return true;
        }
      }

      Clicker.failCount++;
      Logger.warn('Click attempt failed. Fail count:', Clicker.failCount);

      // If we clicked 3 times and button didn't disappear, it's stuck.
      if (Clicker.failCount >= 3) {
        Logger.warn('Button seems stuck. Attempting recovery reloads...');

        const stuckKey = `__stuckAttemptCount_${State.tabId}`;
        const data = await chrome.storage.local.get([stuckKey, "groupList"]);
        const attempts = (data[stuckKey] || 0) + 1;

        if (attempts >= 3) {
          Logger.error("Button still stuck after 3 reloads. Interaction failure confirmed.");
          await chrome.storage.local.set({ [stuckKey]: 0 }); // Reset for next group

          // Interaction block check
          const failData = await chrome.storage.local.get([`__failedGroupCount_${State.tabId}`]);
          const failedGroups = (failData[`__failedGroupCount_${State.tabId}`] || 0) + 1;

          if (failedGroups >= 2) {
            Logger.error("Interaction block detected across 2 groups. Stopping completely.");
            await Main.stop(true); // Total stop
            return false;
          }

          // Move to next group
          await chrome.storage.local.set({
            [`__failedGroupCount_${State.tabId}`]: failedGroups,
            [`__emptyReloadCount_${State.tabId}`]: 0
          });

          if (data.groupList && data.groupList.length > 0) {
            Logger.log("Rotating to next group due to interaction failure...");
            chrome.runtime.sendMessage({ type: "limitReached" });
            await Main.stop(false); // Stop runtime but keep started flag
          } else {
            Logger.log("Interaction failed, no more groups. Stopping.");
            await Main.stop(true);
          }
        } else {
          // Try reloading the same page up to 3 times
          Logger.log(`Reloading page to fix stuck button (Attempt ${attempts}/3)...`);
          await chrome.storage.local.set({ [stuckKey]: attempts });
          Main.handlePersistentFailure(`Stuck attempt ${attempts}`);
        }
      }
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
    tabId: null, // Unique ID for this tab session
    isRunning: false,
    heartbeatTimer: null,
    tickNoButtonsCount: 0,
    softRecoveryAttempts: 0,
    lastActionTime: 0,
    sessionDeclineCount: 0 // Count since last page reload
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

      // Quarter Steps (Reduced to 5)
      for (let i = 1; i <= 5; i++) {
        if (!State.isRunning) return false;
        // Calculate target relative to total height
        const target = Math.round(totalHeight * (i * 0.2)); // 20% increments

        // If we are already past this target, just scroll down a bit more
        const effective = target > window.scrollY ? target : Math.min(maxScroll, window.scrollY + window.innerHeight * 0.5);

        Logger.log(`Scroll Step (Small) ${i}/5 to ${effective}`);
        await DOM.scrollTo(effective);
        await Utils.sleep(2000); // Reduced from 4s to 2s for better responsiveness

        if (findCallback().length > 0) return true;
      }

      // Full Page Steps (Reduced to 5)
      for (let j = 1; j <= 5; j++) {
        if (!State.isRunning) return false;
        const next = Math.min(window.scrollY + window.innerHeight, maxScroll);

        if (next <= window.scrollY && window.scrollY >= maxScroll) {
          Logger.log('Reached bottom of page.');
          break;
        }

        Logger.log(`Scroll Step (Full) ${j}/5 to ${next}`);
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
      await Utils.setStarted(true);
      Logger.log('Started.');

      Heartbeat.start();

      const textRegex = new RegExp(Config.TEXT_PATTERNS.join('|'), 'i');
      State.lastActionTime = Date.now();

      // Initial "Force Scroll" to trigger items if none found
      if (DOM.findActionButtons(textRegex).length === 0) {
        Logger.log('No buttons on load. Forcing initial scroll...');
        await DOM.scrollTo(300);
        await Utils.sleep(1500);
        await DOM.scrollTo(0);
        await Utils.sleep(500);
      }

      try {
        while (State.isRunning) {
          if (DOM.hasExitText(Config.EXIT_TEXT)) {
            Logger.log('Exit message found. Moving to next group...');
            chrome.runtime.sendMessage({ type: "limitReached" });
            await Main.stop(false);
            return;
          }

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

          // No buttons found on immediate scan, try scrolling
          Logger.log('No buttons found. Attempting scroll discovery...');
          const foundAfterScroll = await Navigation.progressiveScroll(() => DOM.findActionButtons(textRegex));
          if (foundAfterScroll) continue;

          // Still no buttons after 5+5 scrolls
          Logger.log('Discovery failed after all scroll attempts. Checking for empty group...');

          if (await Utils.getIsStarted()) {
            const data = await chrome.storage.local.get([
              "groupList",
              `__emptyReloadCount_${State.tabId}`,
              `__failedGroupCount_${State.tabId}`
            ]);
            const emptyReloadCount = (data[`__emptyReloadCount_${State.tabId}`] || 0) + 1;

            Logger.log(`Empty detection: Attempt ${emptyReloadCount} for this group.`);

            if (emptyReloadCount >= 2) {
              // Truly empty in this group. Reset check for this group.
              await chrome.storage.local.set({ [`__emptyReloadCount_${State.tabId}`]: 0 });

              if (data.groupList && data.groupList.length > 0) {
                Logger.log("Group seems empty. Rotating to next group...");
                chrome.runtime.sendMessage({ type: "limitReached" });
                await Main.stop(false); // Local stop only
              } else {
                Logger.log("Group seems empty. No more groups to rotate. Stopping.");
                await Main.stop(true); // User-level stop
              }
              return;
            }

            // Record this "empty" attempt and reload
            await chrome.storage.local.set({ [`__emptyReloadCount_${State.tabId}`]: emptyReloadCount });
            Main.handlePersistentFailure('Empty discovery');
            return;
          } else {
            Logger.log('No buttons found and user did not auto-start. Stopping.');
            await Main.stop(false); // Stop runtime but don't clear started flag if user manually stopped?
            // Actually if getIsStarted is false, it means it's ALREADY stopped.
            break;
          }
        }
      } catch (e) {
        Logger.error('Main loop crash:', e);
      } finally {
        // Only stop runtime, leave started flag alone unless explicit
        State.isRunning = false;
        Heartbeat.stop();
      }
    },

    stop: async (clearStarted = true) => {
      State.isRunning = false;
      if (clearStarted) {
        await Utils.setStarted(false);
      }
      Heartbeat.stop();
      Logger.log(clearStarted ? 'Stopped (Permanent).' : 'Stopped (Session).');
    },

    handlePersistentFailure: async (reason) => {
      Logger.warn(`${reason} -> Reloading page...`);
      // We pause briefly to ensure logs are written/seen
      if (await Utils.getIsStarted()) {
        try { location.reload(); } catch (e) { Logger.error('Reload failed', e); }
        await Utils.sleep(Config.DELAYS.RELOAD);
      } else {
        await Main.stop();
      }
    }
  };

  // --- Message Handling ---
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // Ignore updates from other extensions if any
    if (sender.id && sender.id !== chrome.runtime.id) return;

    (async () => {
      switch (msg.type) {
        case 'start':
          await Main.start();
          sendResponse({ ok: true });
          break;
        case 'stop':
          await Main.stop();
          sendResponse({ ok: true });
          break;
        case 'status':
          const stats = await Utils.loadStats();
          sendResponse({
            running: State.isRunning,
            stats: stats
          });
          break;
      }
    })();
    return true; // async response
  });

  // --- Initialization & Auto-Start ---
  const init = async () => {
    try {
      // Get Tab ID from background script
      const response = await chrome.runtime.sendMessage({ type: 'getTabId' });
      State.tabId = response.tabId;
      Logger.log('Initialized with TabID:', State.tabId);

      // Check auto-start
      if (await Utils.getIsStarted()) {
        Logger.log('Auto-starting session for this tab...');
        setTimeout(() => Main.start(), 1000);
      }
    } catch (e) {
      Logger.error('Init failed:', e);
    }
  };

  // Wait for document to be ready, or start if already loaded
  if (document.readyState === 'complete') init();
  else window.addEventListener('load', init);

  Logger.log('Ready.');

})();
