// content.js
// Version: 1.3-revert
// Changelog:
//  - Revert to previous reliable click behavior (click element center and dispatch mouse events).
//  - Keep improvements: detailed logging, tick handling, softRecovery, reload-on-no-buttons (only if user started), localStorage autostart flag.
//  - Add more verbose logs for every major action to help debugging.
//
// Usage:
//  - popup should send {type: "start"} and {type: "stop"} via chrome.tabs.sendMessage(tabId, msg).
//  - After manual START content script will set localStorage flag and auto-restart after reloads.
//  - STOP removes flag and stops automatic restarts.

(() => {
  // --- guard against double injection ---
  if (window.__autoDeclineInjected) {
    console.log('[autoDeclineFB] already injected - exiting');
    return;
  }
  window.__autoDeclineInjected = true;
  console.log('[autoDeclineFB] content script loaded (v1.3-revert)');

  // --- constants & settings ---
  const SCRIPT_VERSION = '1.3-revert';
  const STORAGE_KEY = '__autoDeclineUserStarted'; // localStorage key to remember user-start
  const TICK_RETRY_LIMIT = 3;   // how many ticks without buttons => softRecovery/reload logic
  const CLICK_FAIL_LIMIT = 5;   // how many click failures in a row => softRecovery/reload
  const SOFT_RECOVERY_ATTEMPTS = 2; // number of softRecoveries before reload
  const CLICK_FAIL_SOFT_RECOVERY = true; // attempt softRecovery on click failures

  const defaultSettings = {
    textPatterns: [
      'decline','reject','remove',
      'отклон','отклонить','отказать','удалить'
    ], // patterns to search (case-insensitive)
    clickDelay: () => 1000 + Math.random() * 500, // ms between clicks
    afterBatchDelay: 1200, // ms pause after batch of clicks
    idleTimeout: 90000, // ms before considering idle -> recovery
    maxCycles: 500,
    scrollWait: 4000, // ms after standard scroll
    endScrollDelay: 1500, // ms between end-of-page micro-scrolls
    stableScrollChecks: 3, // how many identical document heights indicate "bottom"
    endPageScrolls: 10, // extra scrolls in bottom area
    activeTabIntervalMin: 3000,
    activeTabIntervalMax: 4000,
    reloadDelay: 5000 // ms wait after location.reload()
  };

  // --- logging helpers ---
  const log = (...args) => console.log(`[autoDeclineFB v${SCRIPT_VERSION}]`, ...args);
  const warn = (...args) => console.warn(`[autoDeclineFB v${SCRIPT_VERSION}]`, ...args);
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // --- small utilities ---
  function mergeOpts(opts) {
    return Object.assign({}, defaultSettings, opts || {});
  }

  function isVisible(el) {
    if (!el) return false;
    try {
      const rects = el.getClientRects();
      if (!rects || rects.length === 0) return false;
      const st = window.getComputedStyle(el);
      if (!st) return false;
      if (st.visibility === 'hidden' || st.display === 'none' || st.opacity === '0') return false;
      return true;
    } catch (e) {
      return false;
    }
  }

  const candidateText = (el) => {
    try {
      return ((el.innerText || el.textContent || '') + ' ' + (el.getAttribute && (el.getAttribute('aria-label') || ''))).trim();
    } catch {
      return '';
    }
  };

  function makeFindActionButtons(textRegex) {
    return () => {
      try {
        const nodes = Array.from(document.querySelectorAll('[role="button"], button, a'));
        return nodes.filter(el => {
          try {
            if (!el) return false;
            if (el.dataset && el.dataset.__auto_declined) return false; // already handled
            if (!isVisible(el)) return false;
            const txt = candidateText(el);
            if (!txt) return false;
            return textRegex.test(txt);
          } catch (e) {
            return false;
          }
        });
      } catch (e) {
        warn('findActionButtons error', e);
        return [];
      }
    };
  }

  // --- human-like click (reliable, center-of-element approach) ---
  let clickFailCount = 0;
  async function humanClick(el) {
    try {
      if (!el) throw new Error('element is null');
      // mark first to avoid double processing
      el.dataset.__auto_declined = '1';

      // try to bring element into view
      try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' }); } catch (e) {}

      // small pause to let any UI animations settle
      await sleep(80 + Math.random() * 120);

      // compute center coords
      const r = el.getBoundingClientRect();
      const cx = Math.round(r.left + r.width/2);
      const cy = Math.round(r.top + r.height/2);

      // dispatch sequence of mouse events targeted at element (using element.dispatchEvent)
      const dispatchTo = (targetEl, type, clientX = cx, clientY = cy) => {
        try {
          const ev = new MouseEvent(type, {
            view: window,
            bubbles: true,
            cancelable: true,
            clientX,
            clientY,
            button: 0
          });
          targetEl.dispatchEvent(ev);
        } catch (e) {
          // ignore
        }
      };

      // try dispatch on element, but fall back to elementFromPoint if needed
      const target = el;

      dispatchTo(target, 'mouseover');
      await sleep(10);
      dispatchTo(target, 'mousemove');
      await sleep(10);
      dispatchTo(target, 'mousedown');
      // native click if available
      try { el.click && el.click(); } catch (e) {}
      await sleep(10);
      dispatchTo(target, 'mouseup');
      dispatchTo(target, 'click');

      // success -> reset fail count
      clickFailCount = 0;
      log('humanClick: clicked element', el);
      return true;
    } catch (e) {
      clickFailCount++;
      warn('humanClick failed, count=', clickFailCount, e);
      return false;
    }
  }

  // --- heartbeat to keep tab active ---
  let keepActiveTimer = null;
  function scheduleHeartbeat(settings) {
    const heartbeat = () => { window.scrollBy(0,0); requestAnimationFrame(() => {}); };
    const run = () => {
      const t = settings.activeTabIntervalMin + Math.random() * (settings.activeTabIntervalMax - settings.activeTabIntervalMin);
      keepActiveTimer = setTimeout(() => { heartbeat(); run(); }, t);
    };
    run();
  }

  function clearHeartbeat() {
    if (keepActiveTimer) { clearTimeout(keepActiveTimer); keepActiveTimer = null; }
  }

  // --- soft recovery (scroll up/down a bit) ---
  async function softRecovery(settings) {
    log('softRecovery: start');
    try {
      // small up/down cycles to provoke lazy loading
      for (let i=0; i<2; i++) {
        window.scrollBy({ top: 300, behavior: 'auto' });
        await sleep(600);
        window.scrollBy({ top: -300, behavior: 'auto' });
        await sleep(600);
      }
      await sleep(400);
    } catch (e) {
      warn('softRecovery error', e);
    }
    log('softRecovery: done');
  }

  // --- main loop ---
  let __running = false;
  async function autoDeclineFB(opts = {}) {
    if (__running) {
      log('autoDeclineFB: already running, exit');
      return;
    }
    __running = true;
    window.__autoDeclineRunning = true;

    const settings = mergeOpts(opts);
    const textRegex = new RegExp((settings.textPatterns || []).join('|'), 'i');
    const findActionButtons = makeFindActionButtons(textRegex);

    log('autoDeclineFB: starting. pattern:', textRegex);
    scheduleHeartbeat(settings);

    let lastActionTime = Date.now();
    let cycles = 0;
    let lastScrollHeight = document.documentElement.scrollHeight;
    let stableScrollCount = 0;
    let softRecoveryAttempts = 0;

    try {
      while (window.__autoDeclineRunning) {
        cycles++;
        log(`main loop #${cycles}: searching for action buttons`);
        let buttons = findActionButtons();

        if (buttons.length > 0) {
          log(`found ${buttons.length} button(s) — clicking first one`);
          // click first only, then re-evaluate as requested
          const first = buttons[0];
          const ok = await humanClick(first);
          if (ok) {
            lastActionTime = Date.now();
            log('clicked successfully; waiting afterClickDelay', settings.clickDelay());
            await sleep(settings.clickDelay());
            // continue loop, search again
            continue;
          } else {
            log('click failed; clickFailCount=', clickFailCount);
            if (CLICK_FAIL_SOFT_RECOVERY && clickFailCount >= CLICK_FAIL_LIMIT) {
              log('clickFailCount exceeded -> softRecovery attempt');
              await softRecovery(settings);
              softRecoveryAttempts++;
              if (clickFailCount >= CLICK_FAIL_LIMIT) {
                if (localStorage.getItem(STORAGE_KEY) === 'true') {
                  warn('Click failures persist -> reloading (user started)');
                  try { location.reload(); } catch (e) { warn('reload failed', e); }
                  await sleep(settings.reloadDelay);
                  return;
                } else {
                  warn('Click failures persist but user did not start -> stop');
                  break;
                }
              }
            } else {
              // small pause and continue
              await sleep(300);
              continue;
            }
          }
        }

        // no buttons found -> scroll strategy (progressive)
        log('no buttons visible -> performing progressive scroll checks (25% steps x5 then full-height x5)');
        const totalHeight = Math.max(document.documentElement.scrollHeight, 1);
        const maxScrollTop = Math.max(0, totalHeight - window.innerHeight);

        // 5 steps of 25%
        let foundDuringQuarterSteps = false;
        for (let i = 1; i <= 5; i++) {
          if (!window.__autoDeclineRunning) break;
          const target = Math.min(maxScrollTop, Math.round(totalHeight * 0.25 * i));
          log(`quarter-step ${i}: scrolling to ${target} of ${maxScrollTop}`);
          window.scrollTo({ top: target, behavior: 'auto' });
          await sleep(settings.scrollWait);
          const got = findActionButtons();
          if (got.length > 0) {
            log(`found ${got.length} buttons after quarter-step ${i}`);
            foundDuringQuarterSteps = true;
            break;
          }
        }
        if (foundDuringQuarterSteps) {
          log('buttons appeared during quarter-steps -> continue main loop');
          continue;
        }

        // 5 steps of full window height
        let foundDuringFullSteps = false;
        for (let j = 1; j <= 5; j++) {
          if (!window.__autoDeclineRunning) break;
          const next = Math.min(window.scrollY + window.innerHeight, maxScrollTop);
          log(`full-step ${j}: scrolling to ${next}`);
          window.scrollTo({ top: next, behavior: 'auto' });
          await sleep(settings.endScrollDelay);
          const got = findActionButtons();
          if (got.length > 0) {
            log(`found ${got.length} buttons after full-step ${j}`);
            foundDuringFullSteps = true;
            break;
          }
          if (window.scrollY >= maxScrollTop) {
            log('reached bottom during full-steps');
          }
        }
        if (foundDuringFullSteps) {
          log('buttons appeared during full-steps -> continue main loop');
          continue;
        }

        // extra check: do a short wait + retry
        log('no buttons after progressive scrolls -> short wait and recheck');
        await sleep(800);
        const retryButtons = findActionButtons();
        if (retryButtons.length > 0) {
          log(`buttons found on retry: ${retryButtons.length} -> continuing`);
          lastActionTime = Date.now();
          continue;
        }

        // softRecovery attempts
        softRecoveryAttempts++;
        if (softRecoveryAttempts <= SOFT_RECOVERY_ATTEMPTS) {
          log(`softRecovery attempt #${softRecoveryAttempts}`);
          await softRecovery(settings);
          const after = findActionButtons();
          if (after.length > 0) {
            log(`buttons appeared after softRecovery #${softRecoveryAttempts} -> continue`);
            lastActionTime = Date.now();
            continue;
          } else {
            log(`softRecovery #${softRecoveryAttempts} didn't reveal buttons`);
            continue; // next loop may attempt more scrolls
          }
        }

        // after attempts exhausted -> decide reload or stop
        if (localStorage.getItem(STORAGE_KEY) === 'true') {
          warn('No buttons after all attempts -> reloading page (user started)');
          try { location.reload(); } catch (e) { warn('reload failed', e); }
          await sleep(settings.reloadDelay);
          return;
        } else {
          log('No buttons after all attempts and user did not start -> stopping');
          break;
        }

        // idle timeout fallback
        // (note: placed at end, but we still check each loop)
        if (Date.now() - lastActionTime >= settings.idleTimeout) {
          log('idleTimeout reached -> performing softRecovery then conditional reload/stop');
          await softRecovery(settings);
          if (Date.now() - lastActionTime >= settings.idleTimeout) {
            if (localStorage.getItem(STORAGE_KEY) === 'true') {
              warn('still idle after softRecovery -> reloading (user started)');
              try { location.reload(); } catch (e) { warn('reload failed', e); }
              await sleep(settings.reloadDelay);
              return;
            } else {
              log('idle persists and user flag absent -> stopping');
              break;
            }
          }
        }

        if (cycles >= settings.maxCycles) {
          log('maxCycles reached -> stopping to avoid infinite loop');
          break;
        }
      } // while
    } catch (e) {
      warn('autoDeclineFB encountered error', e);
    } finally {
      clearHeartbeat();
      window.__autoDeclineRunning = false;
      __running = false;
      log('autoDeclineFB: finished');
    }
  }

  // --- message handling from popup/background ---
  let tickNoButtonsCount = 0;
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    try {
      log('onMessage:', msg, 'from', sender && sender.id ? sender.id : sender);

      // optional: ignore messages not from our extension (if sender.id exists)
      try {
        if (sender && sender.id && chrome && chrome.runtime && chrome.runtime.id && sender.id !== chrome.runtime.id) {
          log('onMessage: message from other extension - ignoring');
          return;
        }
      } catch (e) { /* ignore */ }

      if (!msg || !msg.type) return;

      if (msg.type === 'start') {
        log('onMessage: START - setting local flag and starting');
        localStorage.setItem(STORAGE_KEY, 'true');
        if (!window.__autoDeclineRunning) autoDeclineFB();
        sendResponse && sendResponse({ ok: true });
      } else if (msg.type === 'stop') {
        log('onMessage: STOP - removing local flag and stopping');
        localStorage.removeItem(STORAGE_KEY);
        window.__autoDeclineRunning = false;
        sendResponse && sendResponse({ ok: true });
      } else if (msg.type === 'status') {
        sendResponse && sendResponse({ running: !!window.__autoDeclineRunning });
      } else if (msg.type === 'tick') {
        // tick processing: if buttons exist, try to click immediately; otherwise increase counter and try recovery after several ticks
        const settings = mergeOpts();
        const textRegex = new RegExp((settings.textPatterns || []).join('|'), 'i');
        const findActionButtons = makeFindActionButtons(textRegex);
        const found = findActionButtons();
        if (found.length > 0) {
          tickNoButtonsCount = 0;
          log(`tick: found ${found.length} buttons - attempting immediate quick clicks`);
          (async () => {
            try {
              // click up to 2 items quickly
              const limit = Math.min(found.length, 2);
              for (let i=0; i<limit; i++) {
                await humanClick(found[i]);
                await sleep(200 + Math.random()*200);
              }
            } catch (e) { warn('tick immediate click error', e); }
          })();
        } else {
          tickNoButtonsCount++;
          log('tick: no buttons; tickNoButtonsCount=', tickNoButtonsCount);
          if (tickNoButtonsCount >= TICK_RETRY_LIMIT) {
            tickNoButtonsCount = 0;
            log('tick: exceeded TICK_RETRY_LIMIT -> softRecovery then conditional reload');
            (async () => {
              await softRecovery(mergeOpts());
              const after = makeFindActionButtons(new RegExp((mergeOpts().textPatterns || []).join('|'), 'i'))();
              if (after.length > 0) {
                log('tick recovery: buttons appeared after softRecovery -> starting processing');
                if (!window.__autoDeclineRunning) autoDeclineFB();
              } else {
                if (localStorage.getItem(STORAGE_KEY) === 'true') {
                  warn('tick recovery: no buttons -> reloading (user started)');
                  try { location.reload(); } catch (e) { warn('reload failed', e); }
                } else {
                  log('tick recovery: no buttons and user flag absent -> no reload');
                }
              }
            })();
          }
        }
      }
    } catch (e) {
      warn('onMessage handler error', e);
    }
  });

  // --- autostart on page load only if user previously pressed START ---
  window.addEventListener('load', () => {
    try {
      log('page load: checking autostart flag in localStorage');
      const shouldAuto = localStorage.getItem(STORAGE_KEY) === 'true';
      if (shouldAuto) {
        log('page load: user had started previously -> auto-starting');
        if (!window.__autoDeclineRunning) autoDeclineFB();
      } else {
        log('page load: user flag absent -> not auto-starting');
      }
    } catch (e) {
      warn('load handler error', e);
    }
  });

  // ready
  log('content.js ready (v' + SCRIPT_VERSION + ')');
})();
