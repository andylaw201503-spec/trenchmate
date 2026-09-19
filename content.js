// content.js — GMGN Tweet Hover Trigger
// Token pages (/sol/token/xxx, /bsc/token/xxx, /robinhood/token/xxx): auto-trigger tweet preview on page load

(function () {
  'use strict';

  const TWEET_ICON_SELECTOR = '[data-icon="IconTweet16pxRegular"]';
  const POPUP_SELECTORS =
    '[class*="popup"], [class*="Popup"], [class*="popover"], [class*="Popover"], ' +
    '[class*="tooltip"], [class*="Tooltip"], [class*="preview"], [class*="Preview"], ' +
    '[class*="hover-card"], [class*="HoverCard"], [role="tooltip"], [role="dialog"]';

  const HOVER_DELAY   = 600;
  const RETRY_DELAYS  = [400, 800, 1200];
  const MAX_RETRIES   = 3;
  const POLL_INTERVAL = 2500;
  const FOMO_HOST = 'fomo.family';
  const PUMP_HOST = 'pump.fun';
  const FOMO_HOLDER_CONTAINER_SELECTOR =
    'div.flex.flex-col.flex-1.overflow-x-auto.overflow-y-auto.min-h-0.scrollbar-none.overscroll-x-none';
  const FOMO_HOVER_TRIGGER_SELECTOR =
    '.flex.gap-3.items-center.min-w-0[data-slot="hover-card-trigger"]';
  const FOMO_POPUP_SELECTOR = '[data-slot="hover-card-content"][data-state="open"]';
  const FOMO_POPUP_TIMEOUT = 1800;
  const FOMO_INITIAL_DELAY = 300;
  const FOMO_HOVER_CLOSE_DELAY = 160;
  const FOMO_ROW_RETRY_MAX = 4;
  const FOMO_ROW_TOKEN_AMOUNT_SELECTOR = 'div.text-xs.text-text-secondary.truncate.max-w-full';
  const FOMO_FILTER_KEYS = ['fomoMinFollowers', 'fomoMinTokenAmount', 'fomoMinPortfolio', 'fomoMaxUsers'];
  const TM_COUNT_INTERVAL = 1000;
  const TM_BOX_ID = 'gmgn-tm-count-box';
  const TM_BOX_STYLE_ID = 'gmgn-tm-count-style';
  const TM_BOX_POS_KEY = 'tmCountBoxPos';
  const TM_DOM_FRESH_MS = 3000;
  const TM_API_CACHE_TTL = 30000;
  const FOMO_NAV_TABS_SEL = 'div.flex.gap-3.text-sm.min-w-0.overflow-x-auto.no-scrollbar';
  // pump.fun coin-page trade feed tabs ("All (16)" / "Pump.fun (1)" / "Following"),
  // currently Radix: <button role="tab" id="radix-…-trigger-pump_fun">Pump.fun (1)</button>
  const PUMP_TAB_LABEL_RE = /^(all|pump\.fun|following)(?:$|\s|\()/i;
  const PUMP_TAB_ID_RE = /-trigger-(?:all|pump_fun|following)$/;
  // Public, login-free pump.fun endpoints used by the site itself. Requests
  // must go through the background worker: gmgn.ai's CSP connect-src blocks
  // pump.fun hosts from the page.
  const PUMP_API_BASE = 'https://frontend-api-v3.pump.fun';

  const DEFAULTS = {
    tweetPreview: true,
    walletPreview: true,
    countBox: true,
    hideShortcut: 'Alt+W',
    trenchesShortcut: 'Alt+Q',
    trendingShortcut: 'Alt+E',
    monitorShortcut: 'Alt+R',
    openFomoShortcut: 'Alt+T',
    xSearchShortcut: 'Alt+5',
    explorerShortcut: 'Alt+G',
    openSocialEnabled: true,
    openSocialShortcut: 'Alt+4',
    fomoMinFollowers: 0,
    fomoMinTokenAmount: 0,
    fomoMinPortfolio: 0,
    fomoMaxUsers: 0,
    fomoAlertBuy: true,
    fomoAlertSell: true,
    fomoAlertThesis: true,
    fomoAlertIsup: true,
    fomoAlertClosed: true,
    fomoGmgnStyle: false,
    fomoHideThesis: false
  };

  const isGmgnPage = location.hostname === 'gmgn.ai';
  const isFomoPage = location.hostname === FOMO_HOST;
  const isPumpPage = location.hostname === PUMP_HOST;
  let scanTimer    = null;
  let scanStaggerTimers = [];
  let debounceTimer = null;
  let tweetObserver = null;
  let pageEpoch    = 0;
  let processedSet = new WeakSet();
  let settings     = { ...DEFAULTS };
  let shortcutsReady = false;
  let lastPath     = '';
  let fomoObserver = null;
  let fomoContainer = null;
  let fomoSetupTimer = null;
  let fomoScanTimer = null;
  let fomoScanRunning = false;
  let fomoRescanRequested = false;
  let fomoRunId = 0;
  let fomoRetryCounts = new WeakMap();
  let fomoAlertObserver = null;
  let fomoAlertContainer = null;
  let fomoAlertSetupTimer = null;
  let countCollectorTimer = null;
  let countBoxTimer = null;
  let countBoxLastJson = '';
  let countBoxPos = null;
  let countBoxDragging = false;
  const pumpApiState = { key: '', ts: 0, inflight: false };

  /* ───────── Bootstrap ───────── */
  function init() {
    chrome.storage.sync.get(DEFAULTS, (data) => {
      settings = data;

      if (isFomoPage) {
        if (!shortcutsReady) {
          setupShortcuts();
          shortcutsReady = true;
        }
        startCountCollection();
        if (settings.walletPreview) startFomoWalletPreviews();
        startFomoAlertFilter();
        return;
      }

      if (isPumpPage) {
        if (!shortcutsReady) {
          setupShortcuts();
          shortcutsReady = true;
        }
        startCountCollection();
        return;
      }

      if (!isGmgnPage) return;

      if (!shortcutsReady) {
        setupShortcuts();
        shortcutsReady = true;
      }

      activateIfNeeded();
      if (settings.countBox) startGmgnCountBox();
    });
  }

  /** Token DETAIL pages only — /sol/token/x, /bsc/token/x, /robinhood/token/x.
   *  The trenches feed must NOT match: opening https://gmgn.ai/ (or /?ref=…)
   *  lands on a chain-scoped feed path such as /sol, and the feed rows carry
   *  tweet icons too — auto-hovering those spams preview popups, which the
   *  trenches page doesn't want. */
  function isTokenDetailPage() {
    return /^\/(?:sol|bsc|robinhood)\/token\/[^/]+/.test(location.pathname);
  }

  /** The Trenches feed — browser URL https://gmgn.ai/ (with ?ref=… / ?chain=…,
   *  or rewritten to /sol, /bsc, /robinhood). Tweet preview must NEVER run
   *  here, even while an SPA partial refresh is still swapping the DOM. */
  function isTrenchesPage() {
    return isTrenchesPath(location.pathname);
  }

  /** Single source of truth for tweet preview: only on a token detail page
   *  while the live browser URL is exactly there. The URL read is synchronous,
   *  so in-flight hovers abort the moment the SPA route leaves the token page. */
  function canTweetPreview() {
    return isGmgnPage && !isTrenchesPage() && isTokenDetailPage();
  }

  /** Stop every scanning activity: timers, debounce, observer, processed set. */
  function stopScanning() {
    if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
    scanStaggerTimers.forEach((t) => clearTimeout(t));
    scanStaggerTimers = [];
    clearTimeout(debounceTimer);
    debounceTimer = null;
    stopTweetObserver();
    processedSet = new WeakSet();
  }

  /** Start scanning if current page is a token detail page */
  function activateIfNeeded() {
    if (!isGmgnPage) return;

    const p = location.pathname;
    if (p === lastPath) return; // no route change
    lastPath = p;

    // Route changed — invalidate in-flight scan work and all timers
    pageEpoch++;
    stopScanning();

    if (!canTweetPreview()) return; // token detail pages only — never the trenches feed

    if (settings.tweetPreview) {
      startTweetObserver();
      scanStaggerTimers = [50, 150, 300, 600, 1200, 2500].map((delay) => setTimeout(scan, delay));
      scanTimer = setInterval(scan, POLL_INTERVAL);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Listen for settings changes in real-time
  chrome.storage.onChanged.addListener((changes) => {
    for (const [key, { newValue }] of Object.entries(changes)) {
      settings[key] = newValue;
    }

    if (isFomoPage) {
      if (changes.walletPreview) {
        if (changes.walletPreview.newValue) {
          startFomoWalletPreviews();
        } else {
          stopFomoWalletPreviews();
        }
      } else if (FOMO_FILTER_KEYS.some((key) => changes[key]) && settings.walletPreview) {
        // Filter thresholds changed — clear previews and re-apply
        startFomoWalletPreviews();
      }
      if (changes.fomoAlertBuy || changes.fomoAlertSell || changes.fomoAlertThesis || changes.fomoAlertIsup || changes.fomoAlertClosed) {
        applyFomoAlertFilter();
      }
      if (changes.fomoGmgnStyle) {
        applyFomoGmgnStyle();
      }
      if (changes.fomoHideThesis) {
        applyFomoHideThesis();
      }
      return;
    }

    if (!isGmgnPage) return;

    if (changes.countBox) {
      if (changes.countBox.newValue) {
        startGmgnCountBox();
      } else {
        removeGmgnCountBox();
      }
    }
    if (changes.tweetPreview && !changes.tweetPreview.newValue) {
      stopScanning();
    }
    if (changes.tweetPreview && changes.tweetPreview.newValue) {
      lastPath = ''; // force re-activate
      activateIfNeeded();
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (isGmgnPage && msg.action === 'rescan') {
      processedSet = new WeakSet();
      if (settings.tweetPreview) scan();
    }
  });

  /* ───────── All Shortcuts ───────── */
  const pressedKeys = new Set();

  function setupShortcuts() {
    document.addEventListener('keydown', (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      const inEditable = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;
      // Modifier combos never insert text into a field, so keep them alive
      // even when focus sits inside an editable control (the monitor page's
      // token-search / filter input would otherwise swallow every shortcut).
      // Plain-key shortcuts still require leaving the field.
      if (inEditable && !(e.altKey || e.ctrlKey || e.metaKey)) return;

      pressedKeys.add(e.key.toLowerCase());

      if (matchShortcut(e, settings.hideShortcut)) {
        e.preventDefault();
        triggerHideToken();
      } else if (matchShortcut(e, settings.trenchesShortcut)) {
        e.preventDefault();
        goToTrenches();
      } else if (matchShortcut(e, settings.trendingShortcut)) {
        e.preventDefault();
        goToTrending();
      } else if (matchShortcut(e, settings.monitorShortcut)) {
        e.preventDefault();
        goToMonitor();
      } else if (matchShortcut(e, settings.openFomoShortcut)) {
        e.preventDefault();
        if (isGmgnPage) goToFomoToken();
        else if (isFomoPage) goToGmgnToken();
        else if (isPumpPage) goToGmgnFromPump();
      } else if (matchShortcut(e, settings.xSearchShortcut)) {
        e.preventDefault();
        triggerXSearch();
      } else if (matchShortcut(e, settings.explorerShortcut)) {
        e.preventDefault();
        triggerExplorer();
      } else if (settings.openSocialEnabled !== false && matchShortcut(e, settings.openSocialShortcut)) {
        e.preventDefault();
        openSocialLink();
      }
    });

    document.addEventListener('keyup', (e) => {
      pressedKeys.delete(e.key.toLowerCase());
    });

    // Clear keys when window loses focus
    window.addEventListener('blur', () => pressedKeys.clear());
  }

  /** Resolve the real key from an event — with IME fallback:
   *  Chinese IME hijacks keydown and reports e.key === 'Process',
   *  so derive the actual key from e.code (KeyW → 'w', Digit1 → '1'). */
  function eventKey(e) {
    const k = (e.key || '').toLowerCase();
    if (k === 'process' || k === 'dead' || k === '') {
      let m = /^Key([A-Za-z])$/.exec(e.code || '');
      if (m) return m[1].toLowerCase();
      m = /^Digit(\d)$/.exec(e.code || '');
      if (m) return m[1];
    }
    return k;
  }

  /** Check if a keyboard event matches the configured shortcut string */
  function matchShortcut(e, shortcut) {
    if (!shortcut) return false;
    const parts = shortcut.split('+').map(s => s.trim().toLowerCase());

    // Standard modifiers
    const needShift = parts.includes('shift');
    const needCtrl  = parts.includes('ctrl');
    const needAlt   = parts.includes('alt');
    const needMeta  = parts.includes('meta');

    if (e.shiftKey !== needShift) return false;
    if (e.ctrlKey !== needCtrl) return false;
    if (e.altKey !== needAlt) return false;
    if (e.metaKey !== needMeta) return false;

    // The actual key part(s) — can be non-modifier keys like 'd', 'backspace'
    const keyParts = parts.filter(p => !['shift', 'ctrl', 'alt', 'meta'].includes(p));
    if (keyParts.length === 0) return false;

    // Check that the current key matches the last key part,
    // and all other key parts are currently held
    const currentKey = eventKey(e);
    const mainKey = keyParts[keyParts.length - 1];
    if (currentKey !== mainKey) return false;

    // Check additional held keys (e.g. Backspace in "Backspace+D")
    for (let i = 0; i < keyParts.length - 1; i++) {
      if (!pressedKeys.has(keyParts[i])) return false;
    }

    return true;
  }

  function triggerHideToken() {
    let triggered = false;

    // Method 1: click the token-blacklist-button via React onClick
    const btn = document.querySelector('.token-blacklist-button');
    if (btn && callReactOnClick(btn)) {
      triggered = true;
    }

    if (!triggered) {
      // Method 2: find svg.hide-token-icon and click its parent
      const svg = document.querySelector('.hide-token-icon');
      if (svg && svg.parentElement) {
        if (callReactOnClick(svg.parentElement)) {
          triggered = true;
        } else {
          svg.parentElement.click();
          triggered = true;
        }
      }
    }

    if (triggered) {
      console.log('[GMGN-Tweet] Hide token triggered, returning to previous page...');
      // Navigate back to the actual previous page in history after a short delay
      setTimeout(() => history.back(), 500);
    } else {
      console.log('[GMGN-Tweet] No hide token button found');
    }
  }

  /** Click the header "search on X" link (x.com/search?q=<address>).
   *  GMGN builds the correct address query per chain (sol / bsc / robinhood)
   *  — triggering the anchor's own click action reuses it verbatim. */
  function triggerXSearch() {
    if (!isGmgnPage) return; // GMGN-only feature — never hijack a FOMO tab
    const link =
      document.querySelector('a[href^="https://x.com/search"]') ||
      document.querySelector('a[href^="https://twitter.com/search"]') ||
      document.querySelector('a#searchdev[href^="http"]'); // id observed in the live DOM
    if (link) {
      link.click(); // native click: page handlers run, then target=_blank opens the tab
    } else {
      console.log('[GMGN-Tweet] No X search link found on this page');
    }
  }

  /** x.com paths that are site navigation, not user profiles */
  const X_RESERVED_PATHS = new Set([
    'search', 'home', 'explore', 'notifications', 'messages', 'i', 'intent',
    'hashtag', 'settings', 'compose', 'login', 'logout', 'signup', 'account',
    'about', 'tos', 'privacy', 'share', 'now', 'who_to_follow', 'bookmarks',
    'lists', 'topics', 'following', 'followers'
  ]);

  /** Other social media hosts that count as tier-3 links */
  const OTHER_SOCIAL_HOSTS = new Set([
    't.me', 'telegram.me', 'telegram.org', 'discord.gg', 'discord.com', 'discordapp.com'
  ]);

  /** Rank a social URL: 1 = tweet, 2 = Twitter/X account, 3 = other social, 0 = none */
  function classifySocialLink(url) {
    const host = url.hostname.replace(/^www\./, '');
    const isX = host === 'x.com' || host.endsWith('.x.com') ||
                host === 'twitter.com' || host.endsWith('.twitter.com');
    if (isX) {
      if (/\/status(es)?\/\d+/.test(url.pathname)) return 1;
      const segs = url.pathname.split('/').filter(Boolean);
      if (segs.length === 1 &&
          /^[A-Za-z0-9_]{1,15}$/.test(segs[0]) &&
          !X_RESERVED_PATHS.has(segs[0].toLowerCase())) {
        return 2;
      }
      return 0;
    }
    if (OTHER_SOCIAL_HOSTS.has(host) && url.pathname.length > 1) return 3;
    return 0;
  }

  /** Open the token's social link, scanned dynamically from the page with
   *  priority: tweet > Twitter/X account > other social account. Nothing
   *  opens when none of the three is present. The href is forwarded to the
   *  background so the tab opens right next to the current one. */
  function openSocialLink() {
    if (!isGmgnPage) return; // GMGN-only feature — never hijack a FOMO tab
    if (!isTokenDetailPage()) {
      console.log('[GMGN-Tweet] Not on a token page — no social link to open');
      return;
    }

    let bestUrl = null;
    let bestRank = Infinity;
    for (const a of document.querySelectorAll('a[href]')) {
      let url;
      try {
        url = new URL(a.getAttribute('href'), location.href);
      } catch {
        continue;
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
      const rank = classifySocialLink(url);
      if (rank && rank < bestRank) {
        bestRank = rank;
        bestUrl = url.href;
        if (rank === 1) break; // tweet is top priority — no better link exists
      }
    }

    if (bestUrl) {
      safeSendMessage({ action: 'openTab', url: bestUrl });
    } else {
      console.log('[GMGN-Tweet] No tweet / X account / social link found on this page');
    }
  }

  /** Open blockchain explorer for the token's creator/deployer address */
  async function triggerExplorer() {
    if (!isGmgnPage) return; // GMGN-only feature — never hijack a FOMO tab

    // Current token address — /sol/token/x, /bsc/token/x, /robinhood/token/x
    const m = /^\/(sol|bsc|robinhood)\/token\/([^/?#]+)/.exec(location.pathname);
    if (!m) {
      console.log('[GMGN-Tweet] Not on a token page — no explorer to open');
      return;
    }

    const chain = m[1];
    const tokenAddress = decodeURIComponent(m[2]);

    try {
      // Fetch creator/deployer address from GMGN API.
      // mutil_window_token_info exposes dev.creator_address (populated),
      // unlike token_dev_info which returns an empty creator_address.
      const res = await fetch('https://gmgn.ai/api/v1/mutil_window_token_info', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chain, addresses: [tokenAddress] })
      });
      const data = await res.json();

      const dev = data.code === 0 && Array.isArray(data.data) && data.data[0] ? data.data[0].dev : null;
      let targetAddress;
      if (dev && dev.creator_address) {
        targetAddress = dev.creator_address;
        console.log('[GMGN-Tweet] Opening explorer for creator: ' + targetAddress);
      } else {
        // Fallback: open token address if creator not available
        targetAddress = tokenAddress;
        console.log('[GMGN-Tweet] Creator address not available, opening token page');
      }

      // Construct blockchain explorer URL based on chain
      let explorerUrl;
      if (chain === 'sol') {
        explorerUrl = `https://solscan.io/account/${targetAddress}`;
      } else if (chain === 'bsc') {
        explorerUrl = `https://bscscan.com/address/${targetAddress}`;
      } else if (chain === 'robinhood') {
        explorerUrl = `https://robinhoodchain.blockscout.com/address/${targetAddress}?tab=txs`;
      } else {
        console.log('[GMGN-Tweet] Unsupported chain: ' + chain);
        return;
      }

      // Open in new tab (adjacent, without switching focus)
      safeSendMessage({ action: 'openTab', url: explorerUrl });

    } catch (error) {
      console.log('[GMGN-Tweet] Error fetching creator address:', error);
    }
  }

  /** Get current chain from URL */
  function getCurrentChain() {
    const p = location.pathname;
    const s = location.search;
    if (p.startsWith('/bsc') || s.includes('chain=bsc')) return 'bsc';
    if (p.startsWith('/robinhood') || s.includes('chain=robinhood')) return 'robinhood';
    return 'sol';
  }

  /** Find a nav <a> link by href prefix. Nav links carry dynamic &ref=
   *  params, so prefix matching is required — exact matching never hits. */
  function findNavLink(hrefPrefix) {
    // Prefer real nav-bar buttons, then any link on the page (e.g. logo)
    const scopes = ['nav a[href], header a[href]', 'a[href]'];
    for (const scope of scopes) {
      for (const a of document.querySelectorAll(scope)) {
        if ((a.getAttribute('href') || '').startsWith(hrefPrefix)) return a;
      }
    }
    return null;
  }

  /** Click one link to SPA-navigate. callReactOnClick only works when
   *  __reactProps is visible — but the content script runs in an ISOLATED
   *  world where page-JS expando properties are invisible, so it returns
   *  false there. That's fine: a native click() bubbles up to React
   * Router's delegated document-level listener, which performs the SPA
   * navigation (verified: no full reload). Never gate the native click on
   * __reactProps visibility — in the isolated world it would never fire. */
  function clickNavLink(link) {
    if (!link) return false;
    if (callReactOnClick(link)) return true;
    link.click(); // React Router's event delegation handles this
    return true;
  }

  /** SPA-navigate to a target by clicking its nav link, with retries and URL
   *  verification. Full reload only as an absolute last resort; a middle-tier
   *  pushState + popstate dispatch tries client-side routers across isolated
   *  script worlds before that.
   *
   *  Concurrency safety: several script instances may listen for the same
   *  shortcut (a second copy of the extension, an orphaned pre-reload script,
   *  or auto-repeated keydowns). A DOM-attribute lock — shared across ALL
   *  script worlds — ensures only ONE navigation loop runs at a time, and
   *  arrival is latched so no timer ever clicks again after arriving.
   *
   *  Non-starvable fallback: each shortcut press inherits the still-pending
   *  absolute deadline for its target URL, so rapid repeated presses cannot
   *  postpone arrival indefinitely. */
  const NAV_LOCK = 'data-gmgn-nav-lock';
  const navFallbackAt = new Map(); // targetUrl → absolute full-load deadline ms

  function spaNavigateTo(hrefPrefix, targetUrl, isArrived) {
    const root = document.documentElement;

    // Lock: newest intent always wins — older loops see the lock changed and
    // their timers go silent, so concurrent/auto-repeated keydowns never
    // interleave clicks.
    const myLock = Date.now() + '#' + Math.random();
    root.setAttribute(NAV_LOCK, myLock);
    const mine = () => root.getAttribute(NAV_LOCK) === myLock;

    let arrived = false;
    const checkArrived = () => {
      if (arrived) return true;
      arrived = isArrived();
      if (arrived) navFallbackAt.delete(targetUrl); // home — clear deadline
      return arrived;
    };

    // Absolute deadline for this target. Re-presses of the same shortcut
    // inherit the still-pending deadline so rapid presses cannot starve the
    // fallback; different targets get independent deadlines.
    const now = Date.now();
    const pending = navFallbackAt.get(targetUrl);
    const deadline = (pending && pending > now) ? pending : now + 3000;
    navFallbackAt.set(targetUrl, deadline);

    // Click attempts — spaced so a slow page render can still supply the
    // nav link. Each is gated by mine() and checkArrived().
    const attempts = [0, 400, 900, 1500, 2200];
    attempts.forEach(delay => {
      setTimeout(() => {
        if (arrived || !mine()) return;
        if (checkArrived()) return;
        clickNavLink(findNavLink(hrefPrefix));
      }, delay);
    });

    // Middle-tier: if clicks never landed (link absent or inert), try
    // history.pushState + popstate dispatch. DOM-patching pushState is
    // invisible to the page (isolated worlds), but the popstate event
    // IS shared — so a client-side router (Next.js App Router, React
    // Router, etc.) will pick up the new URL and render without a full
    // reload. Runs just before the absolute full-load deadline.
    const middleTierDelay = Math.max(0, deadline - 400 - now);
    setTimeout(() => {
      if (!mine() || checkArrived()) return;
      try {
        history.pushState({}, '', targetUrl);
        window.dispatchEvent(new PopStateEvent('popstate'));
      } catch { /* full reload below is the safety net */ }
    }, middleTierDelay);

    // Absolute full-load fallback — fires at `deadline` regardless of how
    // many times the user re-pressed the shortcut. A newer navigation for
    // a different target does not cancel this one's deadline either; only
    // arrival or a same-target re-press (which inherits it) can.
    const finalDelay = Math.max(0, deadline - now);
    setTimeout(() => {
      if (!mine()) return;
      root.removeAttribute(NAV_LOCK);
      navFallbackAt.delete(targetUrl);
      if (!checkArrived()) {
        console.warn('[GMGN-Tweet] SPA navigation failed, falling back to full load');
        location.href = `https://gmgn.ai${targetUrl}`;
      }
    }, finalDelay);
  }

  /** gmgn omits chain=sol (the default) from URLs and nav links — the
   *  monitor page can normalize to /monitor?ref=... and nav links then
   * render as /?ref=..., /trend?ref=... (no chain param). Treat a missing
   * chain param as sol; require an explicit chain to match when present. */
  function chainMatches(chain) {
    const m = /[?&]chain=([^&]+)/.exec(location.search);
    return m ? m[1] === chain : chain === 'sol';
  }

  /** True when the current pathname equals `path`, ignoring trailing slashes */
  function pathIs(path) {
    const p = location.pathname;
    return p === path || p.replace(/\/+$/, '') === path;
  }

  /** Trenches feed pathname: the root forms (/ and empty) plus the bare
   *  chain-feed paths (/sol, /bsc, /robinhood) that gmgn.ai rewrites the
   *  root to after a full load. All of them are the same Trenches page. */
  function isTrenchesPath(p) {
    return p === '/' || p === '' || /^\/(?:sol|bsc|robinhood)\/?$/.test(p);
  }

  /** Navigate back to Trenches page (SPA, no full reload) */
  function goToTrenches() {
    if (!isGmgnPage) return; // GMGN-internal nav — never hijack a FOMO tab
    if (isTrenchesPath(location.pathname)) return; // already on Trenches (any form)

    const chain = getCurrentChain();
    // '/?' matches BOTH /?ref=... (default chain, omitted) and
    // /?chain=xxx&ref=... (explicit chain) renderings of the Trenches link
    spaNavigateTo(
      '/?',
      `/?chain=${chain}`,
      () => isTrenchesPath(location.pathname)
    );
  }

  /** Navigate to the Trending page (SPA, no full reload) */
  function goToTrending() {
    if (!isGmgnPage) return; // GMGN-internal nav — never hijack a FOMO tab
    // ANY /trend URL is already the Trending page — /trend, /trend?ref=...,
    // /trend?chain=... — and the target chain is derived from this very
    // URL, so the shortcut must be a complete no-op here: no nav-link
    // click, no forced jump to /trend, no reload.
    if (pathIs('/trend')) return;

    const chain = getCurrentChain();
    spaNavigateTo(
      '/trend',
      `/trend?chain=${chain}`,
      () => pathIs('/trend') && chainMatches(chain)
    );
  }

  /** Navigate to the Monitor page (SPA, no full reload) */
  function goToMonitor() {
    if (!isGmgnPage) return; // GMGN-internal nav — never hijack a FOMO tab
    // Same rule as Trending: any /monitor URL (?ref=..., ?chain=...) counts
    // as already arrived — no re-navigation, no reload.
    if (pathIs('/monitor')) return;

    const chain = getCurrentChain();
    spaNavigateTo(
      '/monitor',
      `/monitor?chain=${chain}`,
      () => pathIs('/monitor') && chainMatches(chain)
    );
  }

  /** Message the background worker, tolerating a dead extension context.
   *  After the extension is reloaded/updated, stale content scripts left in
   *  already-open tabs lose their chrome.runtime context; calling
   *  sendMessage then throws "Extension context invalidated". */
  function safeSendMessage(msg) {
    try {
      if (!chrome.runtime?.id) throw new Error('context invalidated');
      chrome.runtime.sendMessage(msg);
    } catch (e) {
      console.warn('[GMGN-Tweet] Extension was reloaded — refresh this page to re-enable shortcuts.', e);
    }
  }

  /** Launchpad badge next to the token avatar — the absolutely positioned
   *  rounded anchor pointing at the coin page of the launchpad the token came
   *  from (pump.fun → pump.fun/coin/<mint>, four.meme → four.meme/token/<addr>,
   *  …). Its href is ground truth: pump.fun mints don't always end in "pump",
   *  and four.meme launches must never be mistaken for pump.fun ones. Only the
   *  badge whose href carries the current address counts — foreign badges from
   *  feeds/sidebars must not decide. Returns the pump.fun URL, else null. */
  function detectPumpBadgeUrl(address) {
    const want = address ? address.toLowerCase() : null;
    if (!want) return null;
    for (const a of document.querySelectorAll('a.cursor-pointer.absolute.rounded-full')) {
      const href = a.getAttribute('href') || '';
      if (!href.toLowerCase().includes(want)) continue;
      let u;
      try { u = new URL(href, location.href); } catch (e) { continue; }
      const host = u.hostname.toLowerCase();
      if (host === 'pump.fun' || host.endsWith('.pump.fun')) return u.href;
    }
    return null;
  }

  /** Open the corresponding FOMO token page in a new tab (GMGN→FOMO) */
  function goToFomoToken() {
    if (!isGmgnPage) return;
    const m = /^\/(sol|bsc|robinhood)\/token\/([^/]+)/.exec(location.pathname);
    if (!m) return;
    const chainMap = { sol: 'solana', bsc: 'bnb', robinhood: 'robinhood' };
    const chain = chainMap[m[1]];
    const address = m[2];
    const url = `https://fomo.family/tokens/${encodeURIComponent(chain)}/${encodeURIComponent(address)}`;
    safeSendMessage({ action: 'openTab', url });

    // pump.fun-launched coins also get their pump.fun coin page opened — the
    // launchpad badge next to the avatar decides, so four.meme (and other)
    // launches never open pump.fun.
    const pumpUrl = detectPumpBadgeUrl(address);
    if (pumpUrl) safeSendMessage({ action: 'openTab', url: pumpUrl });
  }

  /** Open the corresponding GMGN token page in a new tab (pump.fun→GMGN) */
  function goToGmgnFromPump() {
    if (!isPumpPage) return;
    const m = /^\/coin\/([^/?#]+)/.exec(location.pathname);
    if (!m) return;
    const address = m[1];
    const url = `https://gmgn.ai/sol/token/${encodeURIComponent(address)}`;
    safeSendMessage({ action: 'openTab', url });
  }

  /** Open the corresponding GMGN token page in a new tab (FOMO→GMGN) */
  function goToGmgnToken() {
    if (!isFomoPage) return;
    const m = /^\/tokens\/(solana|bnb|robinhood)\/([^/]+)/.exec(location.pathname);
    if (!m) return;
    const chainMap = { solana: 'sol', bnb: 'bsc', robinhood: 'robinhood' };
    const chain = chainMap[m[1]];
    const address = m[2];
    const url = `https://gmgn.ai/${chain}/token/${encodeURIComponent(address)}`;
    safeSendMessage({ action: 'openTab', url });
  }

  /** Call React's internal onClick handler directly */
  function callReactOnClick(el) {
    const key = Object.keys(el).find(k => k.startsWith('__reactProps'));
    const props = key ? el[key] : null;
    if (!props || !props.onClick) return false;
    try {
      props.onClick({
        preventDefault: () => {},
        stopPropagation: () => {},
        nativeEvent: new MouseEvent('click'),
        target: el,
        currentTarget: el,
        type: 'click',
        // Fields Next.js Link / React Router check before SPA navigation
        button: 0,
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        defaultPrevented: false
      });
      return true;
    } catch (e) {
      console.warn('[GMGN-Tweet] React onClick error:', e);
      return false;
    }
  }

  /* ───────── SPA Navigation Detection ───────── */
  if (isGmgnPage) {
    // Detect route changes via popstate (browser back/forward)
    window.addEventListener('popstate', () => {
      lastPath = '';
      setTimeout(activateIfNeeded, 100);
    });

    // Detect SPA pushState/replaceState navigation
    const _pushState = history.pushState;
    const _replaceState = history.replaceState;
    history.pushState = function () {
      _pushState.apply(this, arguments);
      lastPath = '';
      setTimeout(activateIfNeeded, 100);
    };
    history.replaceState = function () {
      _replaceState.apply(this, arguments);
      lastPath = '';
      setTimeout(activateIfNeeded, 100);
    };

    // Fallback: poll for URL changes
    setInterval(() => {
      if (location.pathname !== lastPath) {
        lastPath = '';
        activateIfNeeded();
      }
    }, 1000);
  }

  /* ───────── DOM Observation ───────── */
  function startTweetObserver() {
    if (tweetObserver) return; // single instance across route changes
    tweetObserver = new MutationObserver((mutations) => {
      let foundNew = false;
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.matches?.(TWEET_ICON_SELECTOR) ||
              node.querySelector?.(TWEET_ICON_SELECTOR)) {
            foundNew = true; break;
          }
        }
        if (foundNew) break;
      }
      if (foundNew) debounceScan();
    });
    tweetObserver.observe(document.body, { childList: true, subtree: true });
  }

  function stopTweetObserver() {
    if (tweetObserver) { tweetObserver.disconnect(); tweetObserver = null; }
  }

  function debounceScan() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(scan, 400);
  }

  /* ───────── Core Scan ───────── */
  async function scan() {
    if (!settings.tweetPreview) return;

    if (!canTweetPreview()) return; // URL gate: never run on the trenches feed

    const epoch = pageEpoch;

    const icons = Array.from(document.querySelectorAll(TWEET_ICON_SELECTOR));
    if (icons.length === 0) return;

    const newIcons = icons.filter((el) => !processedSet.has(el));
    if (newIcons.length === 0) return;

    newIcons.forEach((el) => processedSet.add(el));

    for (const icon of newIcons) {
      if (epoch !== pageEpoch || !canTweetPreview()) return; // route changed mid-scan
      try {
        const ok = await robustHover(icon, epoch);
        if (!ok) processedSet.delete(icon);
      } catch (e) {
        console.warn('[GMGN-Tweet] Error hovering icon:', e);
        processedSet.delete(icon);
      }
    }
  }

  /* ───────── Robust Hover ───────── */
  async function robustHover(iconEl, epoch) {
    const aborted = () =>
      !settings.tweetPreview || epoch !== pageEpoch || !canTweetPreview();
    if (aborted()) return false;

    const target = findHoverTarget(iconEl);

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (aborted()) return false;
      const beforeCount = countVisiblePopups();

      hoverElement(target);
      if (target !== iconEl) hoverElement(iconEl);
      await sleep(HOVER_DELAY + RETRY_DELAYS[attempt]);
      if (aborted()) return false;

      if (countVisiblePopups() > beforeCount) return true;

      let parent = target.parentElement;
      for (let depth = 0; depth < 5 && parent; depth++) {
        if (aborted()) return false;
        hoverElement(parent);
        await sleep(500);
        if (aborted()) return false;
        if (countVisiblePopups() > beforeCount) return true;
        parent = parent.parentElement;
      }
    }
    return false;
  }

  /* ───────── FOMO Wallet Previews ───────── */
  function startFomoWalletPreviews() {
    if (!isFomoTokenPage() || !settings.walletPreview) return;

    stopFomoWalletPreviews();
    const runId = ++fomoRunId;
    findFomoHolderContainer(runId, 0);
  }

  function stopFomoWalletPreviews() {
    fomoRunId++;
    fomoObserver?.disconnect();
    fomoObserver = null;
    fomoContainer = null;
    clearTimeout(fomoSetupTimer);
    clearTimeout(fomoScanTimer);
    fomoSetupTimer = null;
    fomoScanTimer = null;
    fomoScanRunning = false;
    fomoRescanRequested = false;
    fomoRetryCounts = new WeakMap();

    document.querySelectorAll('.gmgn-fomo-wallet-preview').forEach((preview) => preview.remove());
    document.querySelectorAll('[data-gmgn-fomo-wallet-preview]').forEach((row) => {
      delete row.dataset.gmgnFomoWalletPreview;
    });
  }

  function isFomoTokenPage() {
    return isFomoPage && /^\/tokens\/[^/]+\/[^/]+/.test(location.pathname);
  }

  function findFomoHolderContainer(runId, attempt) {
    if (runId !== fomoRunId || !isFomoTokenPage() || !settings.walletPreview) return;

    const container = document.querySelector(FOMO_HOLDER_CONTAINER_SELECTOR);
    if (!container) {
      if (attempt < 40) {
        fomoSetupTimer = setTimeout(() => findFomoHolderContainer(runId, attempt + 1), 250);
      }
      return;
    }

    fomoContainer = container;
    fomoObserver = new MutationObserver(() => scheduleFomoWalletPreviewScan(runId));
    fomoObserver.observe(container, { childList: true });
    setTimeout(() => scheduleFomoWalletPreviewScan(runId), FOMO_INITIAL_DELAY);
  }

  function scheduleFomoWalletPreviewScan(runId) {
    if (runId !== fomoRunId) return;

    clearTimeout(fomoScanTimer);
    fomoScanTimer = setTimeout(() => {
      void scanFomoWalletPreviews(runId);
    }, 80);
  }

  async function scanFomoWalletPreviews(runId) {
    if (runId !== fomoRunId || !fomoContainer || !settings.walletPreview) return;

    if (fomoScanRunning) {
      fomoRescanRequested = true;
      return;
    }

    fomoScanRunning = true;
    try {
      repositionFomoWalletPreviews();
      do {
        fomoRescanRequested = false;
        const rows = Array.from(fomoContainer.children).filter((child) => child.matches('button'));
        for (let i = 0; i < rows.length; i++) {
          if (runId !== fomoRunId || !settings.walletPreview) return;
          await addFomoWalletPreview(rows[i], runId, i);
        }
      } while (fomoRescanRequested && runId === fomoRunId && settings.walletPreview);
    } finally {
      fomoScanRunning = false;
      repositionFomoWalletPreviews();
      if (runId === fomoRunId && fomoContainer && settings.walletPreview) {
        const unprocessed = Array.from(fomoContainer.children).filter(
          (child) => child.matches('button') && !child.dataset.gmgnFomoWalletPreview
        ).length;
        if (unprocessed > 0) {
          setTimeout(() => scheduleFomoWalletPreviewScan(runId), 2000);
        }
      }
    }
  }

  async function addFomoWalletPreview(row, runId, rowIndex) {
    const trigger = row.querySelector(FOMO_HOVER_TRIGGER_SELECTOR);
    if (!trigger) return;

    const walletKey = trigger.textContent.replace(/\s+/g, ' ').trim();
    if (!walletKey || row.dataset.gmgnFomoWalletPreview === walletKey) return;

    // First-X-users limit — mark rows beyond the cap without hovering
    if (settings.fomoMaxUsers > 0 && rowIndex >= settings.fomoMaxUsers) {
      row.dataset.gmgnFomoWalletPreview = walletKey;
      return;
    }

    // Token-amount threshold — readable from the row itself, so skip the hover
    if (settings.fomoMinTokenAmount > 0) {
      const amount = getFomoRowTokenAmount(row);
      if (amount === null || amount < settings.fomoMinTokenAmount) {
        row.dataset.gmgnFomoWalletPreview = walletKey;
        return;
      }
    }

    const existingPreview = row.nextElementSibling;
    if (existingPreview?.classList.contains('gmgn-fomo-wallet-preview')) existingPreview.remove();

    hoverElement(trigger);
    const metrics = await readFomoWalletMetrics(trigger, runId);
    dismissFomoWalletPopup(trigger);
    await waitForHoverClosed(trigger, runId);
    await sleep(FOMO_HOVER_CLOSE_DELAY);

    if (runId !== fomoRunId || !row.isConnected) return;

    const retryable = metrics
      ? (metrics.portfolio === '--' || metrics.pnl7d === '--')
      : true;
    if (retryable) {
      const count = (fomoRetryCounts.get(row) || 0) + 1;
      fomoRetryCounts.set(row, count);
      if (count <= FOMO_ROW_RETRY_MAX) {
        scheduleFomoWalletPreviewScan(runId);
        return;
      }
    }

    fomoRetryCounts.delete(row);
    row.dataset.gmgnFomoWalletPreview = walletKey;

    const finalMetrics = metrics || {
      following: '--',
      followers: '--',
      portfolio: '--',
      pnl7d: '--'
    };
    if (!passesFomoMetricFilters(finalMetrics)) return;
    renderFomoWalletPreview(row, walletKey, finalMetrics);
  }

  /** Parse abbreviated display numbers: "4.5K" → 4500, "$78,242.85" → 78242.85,
   *  "+$27.09" → 27.09, "30.7M" → 3.07e7. Returns null when unparseable ("—"). */
  function parseFomoAbbrevNumber(value) {
    const m = /(-?)\$?\s*([\d,.]+)([KMBT])?/i.exec((value || '').trim());
    if (!m) return null;
    const num = parseFloat(m[2].replace(/,/g, ''));
    if (!Number.isFinite(num)) return null;
    const multipliers = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };
    const mult = m[3] ? multipliers[m[3].toUpperCase()] || 1 : 1;
    return (m[1] ? -1 : 1) * num * mult;
  }

  /** Token amount held of this token, from the row's Position column ("5.1K PONKE") */
  function getFomoRowTokenAmount(row) {
    const el = row.querySelector(FOMO_ROW_TOKEN_AMOUNT_SELECTOR);
    return el ? parseFomoAbbrevNumber(el.textContent) : null;
  }

  /** Followers / Portfolio thresholds need popup metrics, so they run post-hover */
  function passesFomoMetricFilters(metrics) {
    if (settings.fomoMinFollowers > 0) {
      const followers = parseFomoAbbrevNumber(metrics.followers);
      if (followers === null || followers < settings.fomoMinFollowers) return false;
    }
    if (settings.fomoMinPortfolio > 0) {
      const portfolio = parseFomoAbbrevNumber(metrics.portfolio);
      if (portfolio === null || portfolio < settings.fomoMinPortfolio) return false;
    }
    return true;
  }

  async function readFomoWalletMetrics(trigger, runId) {
    const deadline = Date.now() + FOMO_POPUP_TIMEOUT;
    let lastMetrics = null;
    while (Date.now() < deadline) {
      if (runId !== fomoRunId) return null;

      if (trigger.dataset.state === 'open') {
        const popup = document.querySelector(FOMO_POPUP_SELECTOR);
        if (popup) {
          const metrics = extractFomoWalletMetrics(popup);
          if (metrics) {
            lastMetrics = metrics;
            if (metrics.portfolio !== '--' && metrics.pnl7d !== '--') return metrics;
          }
        }
      }
      await sleep(40);
    }
    return lastMetrics;
  }

  function extractFomoWalletMetrics(popup) {
    const labels = new Map(
      Array.from(popup.querySelectorAll('span')).map((node) => [node.textContent.trim(), node])
    );
    const requiredLabels = ['following', 'followers', 'Portfolio', '7d PnL'];
    if (!requiredLabels.every((label) => labels.has(label))) return null;

    const valueBefore = (label) =>
      normalizeFomoMetric(labels.get(label)?.previousElementSibling?.textContent) || '--';
    const valueAfter = (label) =>
      normalizeFomoMetric(labels.get(label)?.nextElementSibling?.textContent) || '--';

    return {
      following: valueBefore('following'),
      followers: valueBefore('followers'),
      portfolio: valueAfter('Portfolio'),
      pnl7d: valueAfter('7d PnL')
    };
  }

  function normalizeFomoMetric(value) {
    return (value || '').replace(/\s+/g, ' ').trim();
  }

  function dismissFomoWalletPopup(trigger) {
    const rect = trigger.getBoundingClientRect();
    const options = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      pointerId: 1,
      pointerType: 'mouse',
      relatedTarget: document.body
    };
    trigger.dispatchEvent(new PointerEvent('pointerout', options));
    trigger.dispatchEvent(new PointerEvent('pointerleave', options));
    trigger.dispatchEvent(new MouseEvent('mouseout', options));
    trigger.dispatchEvent(new MouseEvent('mouseleave', options));
  }

  async function waitForHoverClosed(trigger, runId) {
    const deadline = Date.now() + 300;
    while (Date.now() < deadline) {
      if (runId !== fomoRunId) return;
      if (trigger.dataset.state !== 'open') return;
      await sleep(25);
    }
  }

  function renderFomoWalletPreview(row, walletKey, metrics) {
    const preview = document.createElement('div');
    preview.className = 'gmgn-fomo-wallet-preview';
    preview.dataset.gmgnFomoWalletPreviewFor = walletKey;

    const values = [
      ['Following', metrics.following, false],
      ['Followers', metrics.followers, false],
      ['Portfolio', metrics.portfolio, false],
      ['7d PnL', metrics.pnl7d, true]
    ];

    values.forEach(([label, value, isPnl]) => {
      const metric = document.createElement('div');
      metric.className = 'gmgn-fomo-wallet-preview__metric';

      const labelNode = document.createElement('span');
      labelNode.className = 'gmgn-fomo-wallet-preview__label';
      labelNode.textContent = label;

      const valueNode = document.createElement('strong');
      valueNode.textContent = value;
      if (isPnl) {
        const signClass = pnlSignClass(value);
        if (signClass) valueNode.classList.add(signClass);
      }

      metric.append(labelNode, valueNode);
      preview.append(metric);
    });

    row.after(preview);
  }

  function repositionFomoWalletPreviews() {
    if (!fomoContainer) return;
    document.querySelectorAll('.gmgn-fomo-wallet-preview').forEach((preview) => {
      const walletKey = preview.dataset.gmgnFomoWalletPreviewFor;
      const prevRow = preview.previousElementSibling;
      if (!prevRow || !prevRow.matches('button') || prevRow.dataset.gmgnFomoWalletPreview !== walletKey) {
        preview.remove();
      }
    });
  }

  function pnlSignClass(value) {
    const v = (value || '').trim();
    if (v === '--' || v === '') return '';
    if (/^[-–—]/.test(v)) return 'gmgn-fomo-wallet-preview__value--negative';
    if (/\d/.test(v)) return 'gmgn-fomo-wallet-preview__value--positive';
    return '';
  }

  /* ───────── FOMO Alert Filter ───────── */
  let gmgnStyleInjected = false;
  let baseAlertCSSInjected = false;
  const R_SEL = 'div.border-b.border-bg-secondary';
  const T_SEL = 'div[role="link"].flex.items-start';
  const U_SEL = 'a.flex.flex-col.gap-2.rounded-lg';
  const A_SEL = 'a.flex.items-start.gap-2.rounded-lg';
  const ALERT_ROW_SEL = R_SEL + ', ' + T_SEL + ', ' + U_SEL + ', ' + A_SEL;
  // Buy/Sell/Thesis/… type badge, and the visual row roots that can host it
  const FOMO_BADGE_SEL = 'div.w-fit.shrink-0.rounded-sm.py-px.px-1.text-xs.font-bold';
  const ALERT_HOST_SEL = A_SEL + ', ' + T_SEL + ', ' + U_SEL;

  function startFomoAlertFilter() {
    if (!isFomoTokenPage()) return;
    stopFomoAlertFilter();
    findFomoAlertContainer(0);
    applyFomoGmgnStyle();
  }

  function stopFomoAlertFilter() {
    fomoAlertObserver?.disconnect();
    fomoAlertObserver = null;
    fomoAlertContainer = null;
    clearTimeout(fomoAlertSetupTimer);
    fomoAlertSetupTimer = null;
    // Restore visibility when stopping
    document.querySelectorAll('[data-gmgn-alert-hidden]').forEach(el => {
      el.style.display = '';
      delete el.dataset.gmgnAlertHidden;
    });
    // Restore is up indicator containers
    document.querySelectorAll('[class*="tabular-nums"]').forEach(el => {
      el.style.display = '';
    });
    // Restore any DOM-restructured rows
    removeFomoGmgnStyle();
    removeFomoHideThesis();
  }

  function findFomoAlertContainer(attempt) {
    if (!isFomoTokenPage()) return;

    const buySellIndicators = document.querySelectorAll(FOMO_BADGE_SEL);
    const alertContainer = buySellIndicators[0]?.closest('.legend-list-content-container');
    if (!alertContainer) {
      if (attempt < 40) {
        fomoAlertSetupTimer = setTimeout(() => findFomoAlertContainer(attempt + 1), 250);
      }
      return;
    }

    fomoAlertContainer = alertContainer;
    injectBaseAlertCSS();
    let alertObsProcessing = false;
    let alertObsQueued = false;
    function runAlertObs() {
      if (alertObsProcessing) return;
      alertObsProcessing = true;
      try {
        applyFomoAlertFilter();
        applyFomoGmgnStyle();
        applyFomoHideThesis();
        hideMCSpans();
        truncateAlertNames();
      } finally {
        alertObsProcessing = false;
      }
    }
    function scheduleAlertObs() {
      if (alertObsQueued) return;
      alertObsQueued = true;
      requestAnimationFrame(() => {
        alertObsQueued = false;
        runAlertObs();
      });
    }
    fomoAlertObserver = new MutationObserver(scheduleAlertObs);
    fomoAlertObserver.observe(fomoAlertContainer, { childList: true, subtree: true });
    runAlertObs();
  }

  function applyFomoAlertFilter() {
    if (!fomoAlertContainer) return;

    const showBuy = settings.fomoAlertBuy !== false;
    const showSell = settings.fomoAlertSell !== false;
    const showThesis = settings.fomoAlertThesis !== false;
    const showIsUp = settings.fomoAlertIsup !== false;
    const showClosed = settings.fomoAlertClosed !== false;

    const alertRows = fomoAlertContainer.querySelectorAll(ALERT_ROW_SEL);
    alertRows.forEach(row => {
      const type = detectAlertType(row);
      let show = true;
      if (type === 'buy') show = showBuy;
      else if (type === 'sell') show = showSell;
      else if (type === 'thesis') show = showThesis;
      else if (type === 'isup') show = showIsUp;
      else if (type === 'closed') show = showClosed;

      if (!show) {
        if (row.style.display !== 'none') row.style.display = 'none';
        if (row.dataset.gmgnAlertHidden !== '1') row.dataset.gmgnAlertHidden = '1';
      } else {
        if (row.style.display !== '') row.style.display = '';
        if (row.dataset.gmgnAlertHidden !== undefined) delete row.dataset.gmgnAlertHidden;
      }
    });

    applyFomoIsUpFilter();
  }

  function applyFomoIsUpFilter() {
    if (!fomoAlertContainer) return;
    const showIsUp = settings.fomoAlertIsup !== false;
    const alertRows = fomoAlertContainer.querySelectorAll(ALERT_ROW_SEL);
    alertRows.forEach(row => {
      if (row.style.display === 'none') return;
      row.querySelectorAll('[class*="tabular-nums"]').forEach(container => {
        const text = container.textContent || '';
        if (text.includes('▲') || text.includes('▼')) {
          const display = showIsUp ? '' : 'none';
          if (container.style.display !== display) container.style.display = display;
        }
      });
    });
  }

  function detectAlertType(element) {
    if (element.dataset.gmgnAlertType) return element.dataset.gmgnAlertType;

    const indicator = element.querySelector(FOMO_BADGE_SEL);
    if (indicator) {
      const text = (indicator.textContent || '').trim();
      if (text === 'Buy') return 'buy';
      if (text === 'Sell') return 'sell';
      if (text === 'Thesis') {
        const rowText = (element.textContent || '').toLowerCase();
        if (rowText.includes('closed')) {
          element.dataset.gmgnAlertType = 'closed';
          return 'closed';
        }
        return 'thesis';
      }
    }

    const rowText = (element.textContent || '').toLowerCase();
    if (rowText.includes('is up')) {
      element.dataset.gmgnAlertType = 'isup';
      return 'isup';
    }

    return 'unknown';
  }

  /* ──────── Base Alert CSS (always active) ──────── */
  function injectBaseAlertCSS() {
    if (baseAlertCSSInjected) return;
    baseAlertCSSInjected = true;

    const style = document.createElement('style');
    style.id = 'gmgn-base-alert-style';
    const P = 'body.gmgn-fomo-alert-style';

    style.textContent = `
      /* Avatar 20px for buy/sell rows */
      ${P} ${R_SEL} div.relative.shrink-0.rounded-full,
      ${P} ${R_SEL} div.relative.shrink-0.rounded-full > div,
      ${P} ${R_SEL} div.relative.shrink-0.rounded-full img {
        width: 20px !important;
        height: 20px !important;
      }
      /* Avatar 20px for thesis rows */
      ${P} ${T_SEL} div.shrink-0,
      ${P} ${T_SEL} div.shrink-0 > div,
      ${P} ${T_SEL} div.shrink-0 img {
        width: 20px !important;
        height: 20px !important;
      }
      /* Font-size 9px for names — buy/sell */
      ${P} ${R_SEL} span.text-sm {
        font-size: 9px !important;
        max-width: 80px !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        white-space: nowrap !important;
        display: inline-block !important;
      }
      ${P} ${R_SEL} span.text-xs {
        font-size: 9px !important;
        max-width: 60px !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        white-space: nowrap !important;
        display: inline-block !important;
      }
      /* Font-size 9px for names — thesis */
      ${P} ${T_SEL} div.min-w-0.truncate {
        font-size: 9px !important;
        max-width: 80px !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        white-space: nowrap !important;
      }
      ${P} ${T_SEL} div.truncate.min-w-0.border-b.border-dotted-underline {
        font-size: 9px !important;
        max-width: 80px !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        white-space: nowrap !important;
      }
      /* text-text-tertiary → white */
      ${P} span.text-text-tertiary,
      ${P} div.text-xs.text-text-tertiary.shrink-0 {
        color: #ffffff !important;
      }
      /* Amount & MC values 12px — buy/sell rows */
      ${P} ${R_SEL} div.flex.items-center.gap-1 > span.text-sm {
        font-size: 12px !important;
        max-width: none !important;
      }
      /* Time 12px — buy/sell rows */
      ${P} ${R_SEL} span.text-xs.text-text-tertiary {
        font-size: 12px !important;
        max-width: none !important;
      }
      /* Amount 12px — is up rows (inline 14px override) */
      ${P} a.flex.flex-col.gap-2.rounded-lg div.flex.gap-0\\.5.items-center.tabular-nums > div {
        font-size: 12px !important;
      }
      /* Thesis row layout: left-aligned, same gap */
      ${P} ${T_SEL} {
        padding: 3px 6px !important;
        gap: 4px !important;
      }
    `;
    document.head.appendChild(style);
  }

  /* ──────── Hide MC Spans ──────── */
  function hideMCSpans() {
    if (!fomoAlertContainer) return;
    fomoAlertContainer.querySelectorAll('span.text-sm.text-text-tertiary').forEach(span => {
      const t = (span.textContent || '').trim();
      if (t === 'MC' && span.style.display !== 'none') span.style.display = 'none';
    });
  }

  /* ──────── Name Truncation ──────── */
  function truncateNames(row) {
    if (row.dataset.gmgnNamesTruncated) return;
    row.dataset.gmgnNamesOriginalHtml = row.innerHTML;
    row.dataset.gmgnNamesTruncated = '1';

    const els = row.querySelectorAll('span.text-sm, span.text-xs, div.min-w-0.truncate');
    els.forEach(el => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
      let node;
      while ((node = walker.nextNode())) {
        if (node.textContent.length > 10) {
          node.textContent = node.textContent.slice(0, 10) + '…';
        }
      }
    });
  }

  function truncateAlertNames() {
    if (!fomoAlertContainer) return;
    fomoAlertContainer.querySelectorAll(ALERT_ROW_SEL).forEach(row => truncateNames(row));
  }

  function restoreTruncatedNames() {
    document.querySelectorAll('[data-gmgn-names-truncated]').forEach(row => {
      if (row.dataset.gmgnNamesOriginalHtml !== undefined) {
        row.innerHTML = row.dataset.gmgnNamesOriginalHtml;
      }
      delete row.dataset.gmgnNamesTruncated;
      delete row.dataset.gmgnNamesOriginalHtml;
    });
  }

  /* ──────── Type Badge → Far Left ──────── */
  /** Move the Buy/Sell/Thesis/… type badge to the very front of its alert
   *  row. The badge normally sits after the username, so long names push it
   *  out of the narrow panel's view — at the row front it is always visible.
   *  Runs before the merge/capture logic in applyFomoGmgnStyle and
   *  applyFomoHideThesis, so their "original HTML" snapshots never contain
   *  the badge and restoring keeps it at the front. */
  function moveFomoAlertBadges() {
    if (!fomoAlertContainer) return;
    fomoAlertContainer.querySelectorAll(FOMO_BADGE_SEL).forEach((badge) => {
      // Climb from the badge to its visual row root (buy/sell anchor,
      // thesis [role=link] row, is-up anchor)
      let host = badge.parentElement;
      while (host && host !== fomoAlertContainer && !host.matches(ALERT_HOST_SEL)) {
        host = host.parentElement;
      }
      if (!host || host === fomoAlertContainer) return;

      // React re-renders can re-insert the badge at its original spot while
      // a previously moved copy stays at the row front — drop the stale one.
      const text = (badge.textContent || '').trim();
      Array.from(host.children).forEach((child) => {
        if (child !== badge && child.matches(FOMO_BADGE_SEL) &&
            (child.textContent || '').trim() === text) {
          child.remove();
        }
      });

      if (badge.parentElement === host && !badge.previousElementSibling) return; // already far left
      host.insertBefore(badge, host.firstChild);
    });
  }

  /* ──────── FOMO GMGN Compact Style ──────── */
  function applyFomoGmgnStyle() {
    if (!isFomoTokenPage()) return;

    moveFomoAlertBadges(); // badges to the far left before rows are merged/captured

    if (settings.fomoGmgnStyle) {
      injectGmgnStyleCSS();
      document.body.classList.add('gmgn-fomo-alert-style');
      mergeAlertRows();
    } else {
      removeFomoGmgnStyle();
    }
  }

  function mergeAlertRows() {
    if (!fomoAlertContainer || !settings.fomoGmgnStyle) return;

    const alertRows = fomoAlertContainer.querySelectorAll(ALERT_ROW_SEL);
    alertRows.forEach(row => {
      if (!row.matches(R_SEL) && row.closest(R_SEL)) return;

      const flexCol = row.querySelector('div.flex.min-w-0.flex-1.flex-col');
      if (!flexCol) return;

      const itemsCenterRows = flexCol.querySelectorAll(':scope > div.flex.items-center');
      if (itemsCenterRows.length < 2) return;

      const firstRow = itemsCenterRows[0];
      const secondRow = itemsCenterRows[1];
      if (row.dataset.gmgnMerged && secondRow.style.display === 'none' &&
          firstRow.querySelector(':scope > .gmgn-alert-token-cell')) return;

      delete row.dataset.gmgnMerged;
      delete row.dataset.gmgnFirstRowHtml;
      firstRow.classList.remove('gmgn-alert-columns');
      row.dataset.gmgnFirstRowHtml = firstRow.innerHTML;

      const [userCell, timeCell] = Array.from(firstRow.children);
      userCell?.classList.add('gmgn-alert-user-cell');
      timeCell?.classList.add('gmgn-alert-time-cell');
      firstRow.classList.add('gmgn-alert-columns');

      const tokenCell = document.createElement('div');
      tokenCell.className = 'gmgn-alert-token-cell';
      const amountCell = document.createElement('div');
      amountCell.className = 'gmgn-alert-amount-cell';
      const marketCapCell = document.createElement('div');
      marketCapCell.className = 'gmgn-alert-market-cap-cell';
      const detailCells = Array.from(secondRow.children, child => child.cloneNode(true));
      const type = detectAlertType(row);

      if (type === 'buy' || type === 'sell') {
        detailCells.forEach(cell => {
          const text = (cell.textContent || '').trim();
          if (text === 'at' || text === 'MC') return;
          if (cell.matches('div.relative.shrink-0, .border-dotted-underline, [role="link"]')) {
            tokenCell.appendChild(cell);
          } else if (cell.matches('span.text-sm.text-text-primary')) {
            (amountCell.childElementCount ? marketCapCell : amountCell).appendChild(cell);
          } else if (!tokenCell.childElementCount) {
            tokenCell.appendChild(cell);
          } else {
            amountCell.appendChild(cell);
          }
        });
      } else {
        const [tokenDetails, ...valueDetails] = detailCells;
        if (tokenDetails) tokenCell.appendChild(tokenDetails);
        valueDetails.forEach(cell => amountCell.appendChild(cell));
      }

      amountCell.querySelectorAll('span.text-sm').forEach(span => span.classList.remove('text-sm'));
      marketCapCell.querySelectorAll('span.text-sm').forEach(span => span.classList.remove('text-sm'));
      amountCell.querySelectorAll(':scope > div.flex.items-center.gap-2.shrink-0').forEach(element => {
        element.classList.remove('shrink-0');
      });
      firstRow.append(tokenCell, amountCell, marketCapCell);
      secondRow.style.display = 'none';
      row.dataset.gmgnMerged = '1';
      truncateNames(row);
    });
  }

  function removeFomoGmgnStyle() {
    document.body.classList.remove('gmgn-fomo-alert-style');
    restoreTruncatedNames();

    document.querySelectorAll('[data-gmgn-merged]').forEach(row => {
      const flexCol = row.querySelector('div.flex.min-w-0.flex-1.flex-col');
      if (!flexCol) return;
      const itemsCenterRows = flexCol.querySelectorAll(':scope > div.flex.items-center');
      if (itemsCenterRows.length >= 2) {
        if (row.dataset.gmgnFirstRowHtml !== undefined) {
          itemsCenterRows[0].innerHTML = row.dataset.gmgnFirstRowHtml;
        }
        itemsCenterRows[0].classList.remove('gmgn-alert-columns');
        itemsCenterRows[1].style.display = '';
      }
      delete row.dataset.gmgnMerged;
      delete row.dataset.gmgnFirstRowHtml;
    });

    const style = document.getElementById('gmgn-fomo-alert-style');
    if (style) style.remove();
    gmgnStyleInjected = false;

    const baseStyle = document.getElementById('gmgn-base-alert-style');
    if (baseStyle) baseStyle.remove();
    baseAlertCSSInjected = false;
  }

  /* ──────── FOMO Hide Thesis ──────── */
  function applyFomoHideThesis() {
    if (!isFomoTokenPage()) return;

    moveFomoAlertBadges(); // badges to the far left before rows are merged/captured

    if (settings.fomoHideThesis) {
      mergeThesisRows();
    } else {
      removeFomoHideThesis();
    }
  }

  function mergeThesisRows() {
    if (!fomoAlertContainer || !settings.fomoHideThesis) return;

    const alertRows = fomoAlertContainer.querySelectorAll(ALERT_ROW_SEL);
    alertRows.forEach(row => {
      if (!row.matches(R_SEL) && row.closest(R_SEL)) return;

      const gap3Row = row.querySelector('div.flex.items-center.gap-3');
      if (!gap3Row) return;
      if (row.dataset.gmgnThesisHidden === '1' && gap3Row.style.display === 'none') return;

      delete row.dataset.gmgnThesisHidden;
      delete row.dataset.gmgnThesisOriginalHtml;
      delete row.dataset.gmgnLineClampHtml;
      row.dataset.gmgnThesisOriginalHtml = row.innerHTML;

      const lineClampDiv = row.querySelector('[class*="line-clamp-6"]');
      if (lineClampDiv) lineClampDiv.innerHTML += gap3Row.innerHTML;

      const thesisTextEl = row.querySelector('div.relative.mt-1.text-sm.font-normal.leading-normal.self-start.text-left.whitespace-pre-line.wrap-break-word.min-w-0.max-w-full');
      if (thesisTextEl) thesisTextEl.style.display = 'none';

      gap3Row.style.display = 'none';
      row.dataset.gmgnThesisHidden = '1';
    });
  }

  function removeFomoHideThesis() {
    document.querySelectorAll('[data-gmgn-thesis-hidden]').forEach(row => {
      const gap3Row = row.querySelector('div.flex.items-center.gap-3');
      const wasHidden = row.dataset.gmgnThesisHidden === '1' && gap3Row?.style.display === 'none';

      if (wasHidden && row.dataset.gmgnThesisOriginalHtml !== undefined) {
        row.innerHTML = row.dataset.gmgnThesisOriginalHtml;
      } else {
        if (gap3Row) gap3Row.style.display = '';
        const thesisTextEl = row.querySelector('div.relative.mt-1.text-sm.font-normal.leading-normal.self-start.text-left.whitespace-pre-line.wrap-break-word.min-w-0.max-w-full');
        if (thesisTextEl) thesisTextEl.style.display = '';
      }

      delete row.dataset.gmgnThesisHidden;
      delete row.dataset.gmgnThesisOriginalHtml;
      delete row.dataset.gmgnLineClampHtml;
    });
  }

  function injectGmgnStyleCSS() {
    if (gmgnStyleInjected) return;
    gmgnStyleInjected = true;

    const style = document.createElement('style');
    style.id = 'gmgn-fomo-alert-style';
    const R = R_SEL;
    const T = T_SEL;
    const A = A_SEL;
    const P = 'body.gmgn-fomo-alert-style';
    style.textContent = `
      ${P} ${R} {
        padding: 0 !important;
        margin-bottom: 0 !important;
        border-bottom: 1px solid rgba(255,255,255,0.04) !important;
      }
      ${P} ${R} > a.flex.items-start,
      ${P} ${R} > div[role="link"].flex.items-start,
      ${P} ${A}[data-gmgn-merged] {
        padding: 3px 6px !important;
        gap: 4px !important;
      }
      ${P} ${R} div.flex.items-start.gap-3 {
        gap: 4px !important;
      }
      ${P} ${R} div.flex.min-w-0.flex-1.flex-col.gap-1\\.5 {
        gap: 2px !important;
      }
      ${P} ${R} div.flex.items-center.gap-1 {
        gap: 4px !important;
      }
      ${P} ${R} div.flex.items-center.gap-1\\.5 {
        gap: 4px !important;
      }
      ${P} ${R} div.flex.items-center.gap-1\\.5 > div.relative.shrink-0 {
        width: 14px !important;
        height: 14px !important;
      }
      ${P} ${R} div.flex.items-center.gap-1\\.5 > div.relative.shrink-0 img {
        width: 14px !important;
        height: 14px !important;
      }
      ${P} ${R} div.w-fit.shrink-0.rounded-sm.py-px.px-1.text-xs.font-bold {
        font-size: 9px !important;
        padding: 1px 3px !important;
      }
      ${P} ${R} div.relative.mt-1.text-sm.font-normal.leading-normal.self-start.text-left.whitespace-pre-line.wrap-break-word.min-w-0.max-w-full {
        font-size: 9px !important;
        margin-top: 2px !important;
        padding-left: 24px !important;
        max-width: 100% !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        white-space: nowrap !important;
      }
      ${P} ${R} button,
      ${P} ${R} svg[aria-label="like"],
      ${P} ${R} [class*="Thesis"] {
        display: none !important;
      }
      ${P} [data-gmgn-merged] .gmgn-alert-columns {
        display: grid !important;
        grid-template-columns: minmax(62px, 4fr) 38px minmax(62px, 4fr) minmax(48px, 2fr) minmax(48px, 2fr) !important;
        column-gap: 4px !important;
        align-items: center !important;
        width: 100% !important;
        min-width: 0 !important;
      }
      ${P} [data-gmgn-merged] .text-text-primary {
        font-size: 12px !important;
      }
      ${P} [data-gmgn-merged] .gmgn-alert-user-cell {
        grid-column: 1;
        min-width: 0 !important;
        flex-wrap: nowrap !important;
        overflow: hidden !important;
      }
      ${P} [data-gmgn-merged] .gmgn-alert-time-cell {
        grid-column: 2;
        justify-self: end;
        min-width: 0 !important;
        white-space: nowrap !important;
      }
      ${P} [data-gmgn-merged] .gmgn-alert-token-cell {
        grid-column: 3;
        display: flex !important;
        align-items: center !important;
        gap: 4px !important;
        min-width: 0 !important;
        overflow: hidden !important;
        white-space: nowrap !important;
      }
      ${P} [data-gmgn-merged] .gmgn-alert-token-cell > div {
        min-width: 0 !important;
      }
      ${P} [data-gmgn-merged] .gmgn-alert-token-cell .border-dotted-underline,
      ${P} [data-gmgn-merged] .gmgn-alert-token-cell [role="link"] {
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        white-space: nowrap !important;
      }
      ${P} [data-gmgn-merged] .gmgn-alert-amount-cell,
      ${P} [data-gmgn-merged] .gmgn-alert-market-cap-cell {
        display: flex !important;
        justify-content: flex-end !important;
        align-items: center !important;
        min-width: 0 !important;
        overflow: hidden !important;
        font-size: 12px !important;
        font-variant-numeric: tabular-nums;
        white-space: nowrap !important;
      }
      ${P} [data-gmgn-merged] .gmgn-alert-amount-cell {
        grid-column: 4;
      }
      ${P} [data-gmgn-merged] .gmgn-alert-market-cap-cell {
        grid-column: 5;
      }
      ${P} [data-gmgn-merged] .gmgn-alert-amount-cell > div.flex.items-center.gap-2 {
        min-width: 0 !important;
        overflow: hidden !important;
        gap: 0 !important;
      }
      ${P} [data-gmgn-merged] .gmgn-alert-amount-cell > div.flex.items-center.gap-2 > :not(span.text-text-primary) {
        display: none !important;
      }
    `;
    document.head.appendChild(style);
  }

  /* ───────── Token Count Aggregation ─────────
   * pump.fun coin pages and fomo.family token pages expose holder/thesis
   * counts in their own tab navigations ("All (16)", "Pump.fun (10)",
   * "Holders (120)", "Thesis (91)", …). Both sites client-render those
   * counts (their server HTML is an empty SPA shell), and this content
   * script already runs on both hosts — so the collectors read the tab
   * texts straight from the live DOM and park them in chrome.storage.local
   * keyed by contract address, stamped with a heartbeat `ts`. The floating
   * box on GMGN token pages combines the token in its own URL with those
   * stored counts; whether the pump section shows is decided by the GMGN
   * launchpad badge (a pump.fun coin link), not the mint suffix. When no
   * source tab is live (heartbeat older than TM_DOM_FRESH_MS) it falls back
   * to pump.fun's public API through the background worker — the same
   * numbers the "All" and "Pump.fun" tabs display (see ensurePumpApiCounts). */
  function startCountCollection() {
    if (countCollectorTimer) return;
    const tick = () => {
      try {
        if (isPumpPage) {
          const m = /^\/coin\/([^/?#]+)/.exec(location.pathname);
          if (m) collectPumpCounts(decodeURIComponent(m[1]));
        } else if (isFomoPage) {
          const m = /^\/tokens\/(solana|bnb|robinhood)\/([^/?#]+)/.exec(location.pathname);
          if (m) collectFomoCounts(m[1], decodeURIComponent(m[2]));
        }
      } catch (e) { /* the loop must survive page errors */ }
    };
    tick();
    countCollectorTimer = setInterval(tick, TM_COUNT_INTERVAL);
  }

  /** "All (16)" → { label: 'All', count: '16' }; "Following" → count null */
  function parseTabButtonTexts(buttons) {
    const items = [];
    for (const btn of buttons) {
      const text = (btn.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const m = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(text);
      items.push(m ? { label: m[1].trim(), count: m[2].trim() } : { label: text, count: null });
    }
    return items;
  }

  function collectPumpCounts(address) {
    // Match the tabs by their own identity — never by "the first tablist on
    // the page": other Radix tab groups (interval/filter switchers) hijacked
    // the scan and their buttons drowned out the trade-feed tabs.
    const norm = (b) => (b.textContent || '').replace(/\s+/g, ' ').trim();
    let buttons = Array.from(document.querySelectorAll('[role="tab"]')).filter(
      (b) => PUMP_TAB_ID_RE.test(b.id || '') || PUMP_TAB_LABEL_RE.test(norm(b)));
    if (buttons.length === 0) {
      buttons = Array.from(document.querySelectorAll('button')).filter(
        (b) => PUMP_TAB_LABEL_RE.test(norm(b)));
    }
    if (buttons.length === 0) return;
    const items = parseTabButtonTexts(buttons);
    if (items.length > 0) saveCounts('tmCount:pump:' + address.toLowerCase(), items);
  }

  function collectFomoCounts(chain, address) {
    let buttons = [];
    const nav = document.querySelector(FOMO_NAV_TABS_SEL);
    if (nav) buttons = Array.from(nav.querySelectorAll('button'));
    if (buttons.length === 0) {
      buttons = Array.from(document.querySelectorAll('button')).filter((b) =>
        /^(holders|swaps|thesis)(\s|\(|$)/i.test((b.textContent || '').replace(/\s+/g, ' ').trim()));
    }
    if (buttons.length === 0) return;
    const items = parseTabButtonTexts(buttons);
    if (items.length > 0) saveCounts(`tmCount:fomo:${chain}:${address.toLowerCase()}`, items);
  }

  function saveCounts(storageKey, items) {
    // ts doubles as a collector heartbeat: the box treats entries older than
    // TM_DOM_FRESH_MS as "source tab closed" and keeps the last snapshot.
    try {
      chrome.storage.local.set({ [storageKey]: { items, ts: Date.now() } });
    } catch (e) { /* stale script after an extension reload */ }
  }

  /* Pump.fun API fallback — lets the GMGN box fill the pump section even
   * with no pump.fun tab open. Both endpoints are the ones the site's own
   * trade-feed tabs use: token-holders/count drives "All", mint-positions
   * totalCount drives "Pump.fun" (the tab counts are load-time snapshots of
   * these, so small time skew is expected). "Following" needs a login and
   * stays empty. Fetched via the background worker — gmgn.ai's page CSP
   * connect-src blocks direct calls. Failures retry after the cache TTL. */
  function fetchPumpApiJson(url) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ action: 'fetchPumpApi', url }, (res) => {
          if (chrome.runtime.lastError || !res || !res.ok) {
            reject(new Error((res && res.error) || 'pump-api'));
            return;
          }
          resolve(res.data);
        });
      } catch (e) { reject(e); }
    });
  }

  function ensurePumpApiCounts(address) {
    const key = `tmApi:pump:${address.toLowerCase()}`;
    const now = Date.now();
    if (pumpApiState.key === key && now - pumpApiState.ts < TM_API_CACHE_TTL) return;
    if (pumpApiState.inflight) return;
    pumpApiState.inflight = true;
    const enc = encodeURIComponent(address);
    const count = (v) => (typeof v === 'number' && isFinite(v) ? String(v) : null);
    Promise.allSettled([
      fetchPumpApiJson(`${PUMP_API_BASE}/token-holders/${enc}/count`),
      fetchPumpApiJson(`${PUMP_API_BASE}/mint-positions/${enc}?sortBy=TOP&pageSize=1&updatesLimit=0`)
    ])
      .then(([holders, positions]) => {
        pumpApiState.key = key;
        pumpApiState.ts = Date.now();
        const all = holders.status === 'fulfilled' ? count(holders.value && holders.value.holderCount) : null;
        const pump = positions.status === 'fulfilled' ? count(positions.value && positions.value.totalCount) : null;
        if (all === null && pump === null) return;
        saveCounts(key, [
          { label: 'All', count: all },
          { label: 'Pump.fun', count: pump },
          { label: 'Following', count: null }
        ]);
      })
      .finally(() => { pumpApiState.inflight = false; });
  }

  /* ───────── Floating Count Box (GMGN token pages) ───────── */
  function startGmgnCountBox() {
    if (countBoxTimer) return;
    try {
      chrome.storage.local.get(TM_BOX_POS_KEY, (d) => {
        if (d && d[TM_BOX_POS_KEY]) countBoxPos = d[TM_BOX_POS_KEY];
        updateGmgnCountBox();
      });
    } catch (e) { /* position stays null — CSS default */ }
    const tick = () => {
      try {
        updateGmgnCountBox();
      } catch (e) { /* the loop must survive page errors */ }
    };
    tick();
    countBoxTimer = setInterval(tick, TM_COUNT_INTERVAL);
  }

  function updateGmgnCountBox() {
    if (!settings.countBox) {
      removeGmgnCountBox();
      return;
    }
    const m = isGmgnPage && /^\/(sol|bsc|robinhood)\/token\/([^/?#]+)/.exec(location.pathname);
    if (!m) {
      removeGmgnCountBox();
      return;
    }
    const chainMap = { sol: 'solana', bsc: 'bnb', robinhood: 'robinhood' };
    const chain = chainMap[m[1]];
    const address = decodeURIComponent(m[2]);
    // Launchpad ground truth: the badge next to the avatar links to the coin's
    // page on the launchpad it came from — pump.fun mints don't always end in
    // "pump", and four.meme launches must not show pump sources.
    const isPump = !!detectPumpBadgeUrl(address);
    const lc = address.toLowerCase();
    const fomoKey = `tmCount:fomo:${chain}:${lc}`;
    const pumpKey = `tmCount:pump:${lc}`;
    const pumpApiKey = `tmApi:pump:${lc}`;
    if (isPump) ensurePumpApiCounts(address);
    const keys = isPump ? [fomoKey, pumpKey, pumpApiKey] : [fomoKey];
    try {
      chrome.storage.local.get(keys, (data) => {
        try {
          renderGmgnCountBox(address, isPump, { fomoKey, pumpKey, pumpApiKey, data });
        } catch (e) { /* ignore */ }
      });
    } catch (e) {
      removeGmgnCountBox(); // extension context gone — drop the box
    }
  }

  function removeGmgnCountBox() {
    countBoxLastJson = '';
    const box = document.getElementById(TM_BOX_ID);
    if (box) box.remove();
  }

  function renderGmgnCountBox(address, isPump, ctx) {
    const now = Date.now();
    // ts in a stored entry doubles as the collector's heartbeat: older than
    // TM_DOM_FRESH_MS means the source tab is closed/stale, so the section
    // keeps showing the last snapshot instead of live numbers.
    const fresh = (entry) => entry && entry.items &&
      (typeof entry.ts !== 'number' || now - entry.ts < TM_DOM_FRESH_MS);
    const fomoDom = fresh(ctx.data[ctx.fomoKey]) ? ctx.data[ctx.fomoKey].items : null;
    const pumpDom = isPump && fresh(ctx.data[ctx.pumpKey]) ? ctx.data[ctx.pumpKey].items : null;
    const pumpApi = isPump && ctx.data[ctx.pumpApiKey] && ctx.data[ctx.pumpApiKey].items ? ctx.data[ctx.pumpApiKey].items : null;
    // fomo precedence: live fomo tab > last snapshot (never GMGN's own numbers)
    const fomoItems = fomoDom || (ctx.data[ctx.fomoKey] && ctx.data[ctx.fomoKey].items) || null;
    const fomoSource = 'fomo';
    // pump precedence: live pump.fun tab > pump.fun API > stale snapshot
    const pumpItems = pumpDom || pumpApi || (isPump && ctx.data[ctx.pumpKey] && ctx.data[ctx.pumpKey].items) || null;
    const pumpSource = pumpDom ? 'pump.fun' : (pumpApi ? 'pump.fun api' : 'pump.fun');
    // Rebuild only when the displayed values actually change — the 1s tick
    // must not flicker the box or fight hover/drag.
    const renderJson = JSON.stringify({ address, isPump, fomoItems, pumpItems, fomoSource, pos: countBoxPos });
    const existing = document.getElementById(TM_BOX_ID);
    if (existing && renderJson === countBoxLastJson) return;
    countBoxLastJson = renderJson;
    // Never rebuild mid-drag: the mouse handlers live on the box's children.
    if (countBoxDragging) return;

    injectCountBoxCSS();
    let box = existing;
    if (!box) {
      box = document.createElement('div');
      box.id = TM_BOX_ID;
      document.body.appendChild(box);
    }
    box.textContent = '';

    const header = document.createElement('div');
    header.className = 'tm-count-header';
    header.textContent = address.slice(0, 4) + '…' + address.slice(-4);
    box.appendChild(header);

    if (isPump) box.appendChild(buildCountSection(pumpSource, pumpItems));
    box.appendChild(buildCountSection(fomoSource, fomoItems));
    makeCountBoxDraggable(box, header);
    applyCountBoxPosition(box);
  }

  function applyCountBoxPosition(box) {
    if (!countBoxPos) return;
    box.style.top = countBoxPos.top + 'px';
    box.style.left = countBoxPos.left + 'px';
    box.style.right = 'auto';
  }

  function makeCountBoxDraggable(box, handle) {
    handle.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      countBoxDragging = true;
      const rect = box.getBoundingClientRect();
      const offX = e.clientX - rect.left;
      const offY = e.clientY - rect.top;
      const move = (ev) => {
        const maxX = Math.max(window.innerWidth - rect.width, 0);
        const x = Math.min(Math.max(ev.clientX - offX, 0), maxX);
        const y = Math.min(Math.max(ev.clientY - offY, 0), window.innerHeight - 24);
        countBoxPos = { left: Math.round(x), top: Math.round(y) };
        applyCountBoxPosition(box);
      };
      const up = () => {
        document.removeEventListener('mousemove', move, true);
        document.removeEventListener('mouseup', up, true);
        countBoxDragging = false;
        try { chrome.storage.local.set({ [TM_BOX_POS_KEY]: countBoxPos }); } catch (err) { /* stale script */ }
      };
      document.addEventListener('mousemove', move, true);
      document.addEventListener('mouseup', up, true);
    });
  }

  function buildCountSection(source, items) {
    // Entries written by extension versions before the API-fill refactor hold a
    // preformatted string — upgrade them instead of throwing mid-render.
    if (typeof items === 'string') items = [{ label: items }];
    const section = document.createElement('div');
    section.className = 'tm-count-section';

    const src = document.createElement('div');
    const srcKind = source.indexOf('pump') === 0 ? 'pump' : 'fomo';
    src.className = 'tm-count-src tm-count-src--' + srcKind;
    src.textContent = source;
    section.appendChild(src);

    const line = document.createElement('div');
    line.className = 'tm-count-items';
    if (!items || items.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'tm-count-empty';
      empty.textContent = 'no data';
      line.appendChild(empty);
    } else {
      items.forEach((item, i) => {
        if (i > 0) {
          const sep = document.createElement('span');
          sep.className = 'tm-count-sep';
          sep.textContent = ' · ';
          line.appendChild(sep);
        }
        const label = document.createElement('span');
        label.className = 'tm-count-label';
        label.textContent = item.label;
        line.appendChild(label);
        if (item.count !== null && item.count !== undefined) {
          const value = document.createElement('span');
          value.className = 'tm-count-value';
          value.textContent = ' ' + item.count;
          line.appendChild(value);
        }
      });
    }
    section.appendChild(line);
    return section;
  }

  function injectCountBoxCSS() {
    if (document.getElementById(TM_BOX_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = TM_BOX_STYLE_ID;
    style.textContent = `
      #${TM_BOX_ID} {
        position: fixed;
        top: 76px;
        right: 10px;
        z-index: 2147483647;
        min-width: 140px;
        padding: 8px 10px;
        background: #161b22;
        border: 1px solid #30363d;
        border-radius: 8px;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.45);
        color: #e6edf3;
        font: 12px/1.6 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        user-select: none;
      }
      #${TM_BOX_ID} .tm-count-header {
        font-size: 10px;
        color: #8b949e;
        letter-spacing: 0.4px;
        margin-bottom: 2px;
        font-variant-numeric: tabular-nums;
        cursor: move;
      }
      #${TM_BOX_ID} .tm-count-section + .tm-count-section { margin-top: 6px; }
      #${TM_BOX_ID} .tm-count-src {
        display: inline-flex;
        align-items: center;
        padding: 1px 8px;
        border-radius: 9px;
        font-size: 9px;
        font-weight: 700;
        letter-spacing: 0.6px;
        text-transform: uppercase;
        line-height: 1.6;
        color: #22c55e;
        background: rgba(34, 197, 94, 0.14);
        border: 1px solid rgba(34, 197, 94, 0.5);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06);
        cursor: default;
      }
      #${TM_BOX_ID} .tm-count-src--pump {
        color: #38bdf8;
        background: rgba(56, 189, 248, 0.14);
        border-color: rgba(56, 189, 248, 0.5);
      }
      #${TM_BOX_ID} .tm-count-items { white-space: nowrap; }
      #${TM_BOX_ID} .tm-count-label { color: #8b949e; }
      #${TM_BOX_ID} .tm-count-value {
        color: #e6edf3;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
      }
      #${TM_BOX_ID} .tm-count-sep { color: #484f58; }
      #${TM_BOX_ID} .tm-count-empty { color: #484f58; }
    `;
    document.head.appendChild(style);
  }

  /* ───────── Helpers ───────── */
  function findHoverTarget(iconEl) {
    return iconEl.closest('button[aria-haspopup="dialog"]') ||
           iconEl.closest('a') ||
           iconEl;
  }

  function hoverElement(el) {
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const opts = {
      bubbles: true, cancelable: true, view: window,
      clientX: cx, clientY: cy, pointerId: 1, pointerType: 'mouse'
    };
    el.dispatchEvent(new PointerEvent('pointerenter', opts));
    el.dispatchEvent(new PointerEvent('pointerover', opts));
    el.dispatchEvent(new PointerEvent('pointermove', opts));
    el.dispatchEvent(new MouseEvent('mouseenter', opts));
    el.dispatchEvent(new MouseEvent('mouseover', opts));
    el.dispatchEvent(new MouseEvent('mousemove', opts));
  }

  function countVisiblePopups() {
    let n = 0;
    document.querySelectorAll(POPUP_SELECTORS).forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width > 10 && r.height > 10) n++;
    });
    return n;
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
})();
