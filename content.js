// content.js
// Version: 1.4.1-clickfix
// Changelog:
//  - Robust click strategy: multiple click methods + verification after click.
//  - Mark element as processed only after successful click (or if removed).
//  - Keep "down-only" scrolling, verbose logging, tick handling, autostart flag, reload-on-no-buttons.

(() => {
  if (window.__autoDeclineInjected) {
    console.log('[autoDeclineFB] already injected - exiting');
    return;
  }
  window.__autoDeclineInjected = true;
  const SCRIPT_VERSION = '1.4.1-clickfix';
  console.log(`[autoDeclineFB v${SCRIPT_VERSION}] content script loaded`);

  // --- constants & settings ---
  const STORAGE_KEY = '__autoDeclineUserStarted';
  const TICK_RETRY_LIMIT = 3;
  const CLICK_FAIL_LIMIT = 5;
  const SOFT_RECOVERY_ATTEMPTS = 2;
  const CLICK_FAIL_SOFT_RECOVERY = true;

  const defaultSettings = {
    textPatterns: [
      'decline','reject','remove',
      'отклон','отклонить','отказать','удалить'
    ],
    clickDelay: () => 1000 + Math.random() * 500,
    afterBatchDelay: 1200,
    afterClickDelay: 700,
    idleTimeout: 90000,
    maxCycles: 500,
    scrollWait: 4000,
    endScrollDelay: 1500,
    stableScrollChecks: 3,
    endPageScrolls: 10,
    activeTabIntervalMin: 3000,
    activeTabIntervalMax: 4000,
    reloadDelay: 5000
  };

  const log = (...a) => console.log(`[autoDeclineFB v${SCRIPT_VERSION}]`, ...a);
  const warn = (...a) => console.warn(`[autoDeclineFB v${SCRIPT_VERSION}]`, ...a);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const mergeOpts = opts => Object.assign({}, defaultSettings, opts || {});

  // --- helpers ---
  function isVisible(el) {
    if (!el) return false;
    try {
      const rects = el.getClientRects();
      if (!rects || rects.length === 0) return false;
      const st = window.getComputedStyle(el);
      if (!st) return false;
      if (st.visibility === 'hidden' || st.display === 'none' || st.opacity === '0') return false;
      return true;
    } catch { return false; }
  }

  const candidateText = (el) => {
    try {
      return ((el.innerText || el.textContent || '') + ' ' + (el.getAttribute && (el.getAttribute('aria-label') || ''))).trim();
    } catch { return ''; }
  };

  function makeFindActionButtons(textRegex) {
    return () => {
      try {
        const nodes = Array.from(document.querySelectorAll('[role="button"], button, a'));
        return nodes.filter(el => {
          try {
            if (!el) return false;
            if (el.dataset && el.dataset.__auto_declined) return false; // skip processed
            if (!isVisible(el)) return false;
            const txt = candidateText(el);
            if (!txt) return false;
            return textRegex.test(txt);
          } catch { return false; }
        });
      } catch (e) {
        warn('findActionButtons error', e);
        return [];
      }
    };
  }

  // --- Robust click routine ---
  // Tries several strategies; verifies success by checking element removal/visibility/text.
  let clickFailCount = 0;
  async function tryClickElement(el, textRegex) {
    if (!el) return false;
    // Do not mark as processed before success.
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      log(`tryClickElement: attempt ${attempt} for`, el);
      try {
        // Bring into view (allowed)
        try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' }); } catch (e) {}

        await sleep(60 + Math.random() * 80);

        const r = el.getBoundingClientRect();
        const cx = Math.round(r.left + r.width / 2);
        const cy = Math.round(r.top + r.height / 2);

        // Method 1: dispatch mouse sequence on element + native click
        if (attempt === 1) {
          log('tryClickElement: method1 -> dispatch mouse events on element and el.click()');
          try {
            const evSeq = ['mouseover','mousemove','mousedown'];
            evSeq.forEach(t => {
              try {
                el.dispatchEvent(new MouseEvent(t, { view: window, bubbles: true, cancelable: true, clientX: cx, clientY: cy }));
              } catch (e) {}
            });
            try { el.click && el.click(); } catch (e) {}
            el.dispatchEvent(new MouseEvent('mouseup', { view: window, bubbles: true, cancelable: true, clientX: cx, clientY: cy }));
            el.dispatchEvent(new MouseEvent('click', { view: window, bubbles: true, cancelable: true, clientX: cx, clientY: cy }));
          } catch (e) { warn('method1 error', e); }
        }

        // Method 2: pointer events on element
        else if (attempt === 2) {
          log('tryClickElement: method2 -> dispatch pointer events');
          try {
            const down = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'mouse', clientX: cx, clientY: cy, isPrimary: true });
            const up = new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerType: 'mouse', clientX: cx, clientY: cy, isPrimary: true });
            el.dispatchEvent(down);
            await sleep(20);
            el.dispatchEvent(up);
            await sleep(10);
            try { el.click && el.click(); } catch (e) {}
          } catch (e) { warn('method2 error', e); }
        }

        // Method 3: dispatch events to elementFromPoint (sometimes overlay intercepts)
        else {
          log('tryClickElement: method3 -> elementFromPoint dispatch + native click fallback');
          try {
            const target = document.elementFromPoint(cx, cy) || el;
            ['mouseover','mousemove','mousedown'].forEach(t => {
              try { target.dispatchEvent(new MouseEvent(t, { view: window, bubbles: true, cancelable: true, clientX: cx, clientY: cy })); } catch (e) {}
            });
            try { target.click && target.click(); } catch (e) {}
            ['mouseup','click'].forEach(t => {
              try { target.dispatchEvent(new MouseEvent(t, { view: window, bubbles: true, cancelable: true, clientX: cx, clientY: cy })); } catch (e) {}
            });
          } catch (e) { warn('method3 error', e); }
        }

        // wait a moment for UI to respond
        await sleep(300 + Math.random() * 400);

        // verify success: element removed OR not visible OR text no longer matches
        try {
          const stillInDom = document.contains(el);
          const visibleNow = stillInDom && isVisible(el);
          const textNow = stillInDom ? candidateText(el) : '';
          const textMatches = textRegex.test(textNow);
          log('tryClickElement: verification -> inDom:', stillInDom, 'visible:', visibleNow, 'textMatches:', textMatches);

          if (!stillInDom || !visibleNow || !textMatches) {
            // success: if still present mark processed, else can't (already removed)
            try { if (stillInDom) el.dataset.__auto_declined = '1'; } catch (e) {}
            clickFailCount = 0;
            log('tryClickElement: success on attempt', attempt);
            return true;
          } else {
            log('tryClickElement: not successful on attempt', attempt);
            // continue to next attempt
          }
        } catch (e) {
          warn('tryClickElement verification error', e);
        }
      } catch (e) {
        warn('tryClickElement outer error', e);
      }
    } // attempts loop

    // all attempts failed
    clickFailCount++;
    warn('tryClickElement: all attempts failed, clickFailCount=', clickFailCount);
    return false;
  }

  // --- heartbeat ---
  let keepActiveTimer = null;
  function scheduleHeartbeat(settings) {
    const heartbeat = () => { window.scrollBy(0, 0); requestAnimationFrame(() => {}); };
    const run = () => {
      const t = settings.activeTabIntervalMin + Math.random() * (settings.activeTabIntervalMax - settings.activeTabIntervalMin);
      keepActiveTimer = setTimeout(() => { heartbeat(); run(); }, t);
    };
    run();
  }
  function clearHeartbeat() { if (keepActiveTimer) { clearTimeout(keepActiveTimer); keepActiveTimer = null; } }

  // --- softRecovery (down-only) ---
  async function softRecovery(settings) {
    log('softRecovery: start (down-only)');
    try {
      const step = Math.max(200, Math.round((window.innerHeight || 800) * 0.15));
      for (let i = 0; i < 3; i++) {
        const target = Math.min(document.documentElement.scrollHeight - window.innerHeight, window.scrollY + step);
        log(`softRecovery: scrolling down to ${target} (step ${i+1})`);
        window.scrollTo({ top: target, behavior: 'auto' });
        await sleep(600);
      }
      await sleep(400);
    } catch (e) { warn('softRecovery error', e); }
    log('softRecovery: done');
  }

  // --- main loop ---
  let __running = false;
  async function autoDeclineFB(opts = {}) {
    if (__running) {
      log('autoDeclineFB: already running');
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
    let softRecoveryAttempts = 0;

    try {
      while (window.__autoDeclineRunning) {
        cycles++;
        log(`main loop #${cycles}: searching for action elements`);
        const elems = findActionButtons();

        if (elems.length > 0) {
          log(`found ${elems.length} element(s) — will try click on first one`);
          const el = elems[0];
          const ok = await tryClickElement(el, textRegex);
          if (ok) {
            lastActionTime = Date.now();
            log('click succeeded; waiting afterClickDelay', settings.afterClickDelay);
            await sleep(settings.afterClickDelay);
            continue;
          } else {
            log('click attempts failed on this element');
            if (CLICK_FAIL_SOFT_RECOVERY && clickFailCount >= CLICK_FAIL_LIMIT) {
              log('clickFailCount exceeded -> attempting softRecovery');
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
              // small pause and continue loop
              await sleep(300);
              continue;
            }
          }
        }

        // no visible matches: progressive down-only scrolls
        log('no visible matches -> progressive scrolls (25% x5 then full-height x5) DOWN-ONLY');
        const totalHeight = Math.max(document.documentElement.scrollHeight, 1);
        const maxScrollTop = Math.max(0, totalHeight - window.innerHeight);

        // 5 steps of 25%
        let foundDuringQuarter = false;
        for (let i = 1; i <= 5; i++) {
          if (!window.__autoDeclineRunning) break;
          const target = Math.min(maxScrollTop, Math.round(totalHeight * 0.25 * i));
          const effectiveTarget = target > window.scrollY ? target : Math.min(maxScrollTop, window.scrollY + Math.max(100, Math.round(totalHeight * 0.05)));
          log(`quarter-step ${i}: scrolling down to ${effectiveTarget} (calc ${target}, cur ${window.scrollY})`);
          window.scrollTo({ top: effectiveTarget, behavior: 'auto' });
          await sleep(settings.scrollWait);
          const got = findActionButtons();
          if (got.length > 0) { log(`found ${got.length} after quarter ${i}`); foundDuringQuarter = true; break; }
        }
        if (foundDuringQuarter) continue;

        // 5 steps full window height down
        let foundDuringFull = false;
        for (let j = 1; j <= 5; j++) {
          if (!window.__autoDeclineRunning) break;
          const next = Math.min(window.scrollY + window.innerHeight, maxScrollTop);
          if (next <= window.scrollY && window.scrollY >= maxScrollTop) {
            log(`full-step ${j}: at bottom (${window.scrollY}), breaking full-step loop`);
            break;
          }
          log(`full-step ${j}: scrolling down to ${next}`);
          window.scrollTo({ top: next, behavior: 'auto' });
          await sleep(settings.endScrollDelay);
          const got = findActionButtons();
          if (got.length > 0) { log(`found ${got.length} after full-step ${j}`); foundDuringFull = true; break; }
        }
        if (foundDuringFull) continue;

        // short wait + retry
        log('no matches after progressive scrolls -> waiting and retrying');
        await sleep(800);
        const retry = findActionButtons();
        if (retry.length > 0) { log(`found ${retry.length} on retry`); lastActionTime = Date.now(); continue; }

        // softRecovery attempts (down-only)
        softRecoveryAttempts++;
        if (softRecoveryAttempts <= SOFT_RECOVERY_ATTEMPTS) {
          log(`softRecovery attempt #${softRecoveryAttempts} (down-only)`);
          await softRecovery(settings);
          const after = findActionButtons();
          if (after.length > 0) { log(`found ${after.length} after softRecovery`); lastActionTime = Date.now(); continue; }
          else { log('softRecovery did not reveal matches'); continue; }
        }

        // exhausted attempts -> reload if user started, else stop
        if (localStorage.getItem(STORAGE_KEY) === 'true') {
          warn('No matches after all attempts -> reloading page (user started)');
          try { location.reload(); } catch (e) { warn('reload failed', e); }
          await sleep(settings.reloadDelay);
          return;
        } else {
          log('No matches after all attempts and user did not start -> stopping');
          break;
        }

        // idle fallback (kept but down-only recovery)
        if (Date.now() - lastActionTime >= settings.idleTimeout) {
          log('idleTimeout reached -> softRecovery (down-only) then conditional reload/stop');
          await softRecovery(settings);
          if (Date.now() - lastActionTime >= settings.idleTimeout) {
            if (localStorage.getItem(STORAGE_KEY) === 'true') {
              warn('idle persists -> reloading (user started)');
              try { location.reload(); } catch (e) { warn('reload failed', e); }
              await sleep(settings.reloadDelay);
              return;
            } else {
              log('idle persists and user flag absent -> stopping');
              break;
            }
          }
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

  // --- messages ---
  let tickNoButtonsCount = 0;
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    try {
      log('onMessage:', msg, 'from', sender && sender.id ? sender.id : sender);
      try {
        if (sender && sender.id && chrome && chrome.runtime && chrome.runtime.id && sender.id !== chrome.runtime.id) {
          log('onMessage: message from other extension - ignoring');
          return;
        }
      } catch (e) {}
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
        const settings = mergeOpts();
        const textRegex = new RegExp((settings.textPatterns || []).join('|'), 'i');
        const findActionButtons = makeFindActionButtons(textRegex);
        const found = findActionButtons();
        if (found.length > 0) {
          tickNoButtonsCount = 0;
          log(`tick: found ${found.length} buttons - attempting immediate quick clicks`);
          (async () => {
            try {
              const limit = Math.min(found.length, 2);
              for (let i=0; i<limit; i++) {
                await tryClickElement(found[i], textRegex);
                await sleep(200 + Math.random()*200);
              }
            } catch (e) { warn('tick immediate click error', e); }
          })();
        } else {
          tickNoButtonsCount++;
          log('tick: no buttons; tickNoButtonsCount=', tickNoButtonsCount);
          if (tickNoButtonsCount >= TICK_RETRY_LIMIT) {
            tickNoButtonsCount = 0;
            log('tick: exceeded TICK_RETRY_LIMIT -> softRecovery then conditional reload (down-only)');
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
    } catch (e) { warn('onMessage handler error', e); }
  });

  // autostart on load only if user previously pressed START
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
    } catch (e) { warn('load handler error', e); }
  });

  log('content.js ready (v' + SCRIPT_VERSION + ')');
})();
