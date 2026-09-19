// popup.js — Settings popup for GMGN Advancer

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

const FILTER_LABELS = {
  fomoMinFollowers: '粉丝数下限',
  fomoMinTokenAmount: '持仓数量下限',
  fomoMinPortfolio: '总资产下限',
  fomoMaxUsers: '预览用户上限'
};

const tweetPreviewToggle = document.getElementById('tweetPreviewToggle');
const walletPreviewToggle = document.getElementById('walletPreviewToggle');
const countBoxToggle = document.getElementById('countBoxToggle');
const openSocialToggle = document.getElementById('openSocialToggle');
const gmgnStyleToggle = document.getElementById('gmgnStyleToggle');
const hideThesisToggle = document.getElementById('hideThesisToggle');
const status = document.getElementById('status');
const allShortcutInputs = document.querySelectorAll('.shortcut-input[data-key]');
const allFilterInputs = document.querySelectorAll('.filter-input[data-key]');
const allAlertFilterCheckboxes = document.querySelectorAll('[data-alert-filter]');

// ─── Tab switching ───
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.tab-panel').forEach((panel) => {
      panel.classList.toggle('hidden', panel.dataset.panel !== tab.dataset.tab);
    });
  });
});

// Load saved settings
chrome.storage.sync.get(DEFAULTS, (data) => {
  tweetPreviewToggle.checked = data.tweetPreview;
  walletPreviewToggle.checked = data.walletPreview;
  countBoxToggle.checked = data.countBox !== false;
  openSocialToggle.checked = data.openSocialEnabled !== false;
  gmgnStyleToggle.checked = data.fomoGmgnStyle || false;
  hideThesisToggle.checked = data.fomoHideThesis || false;
  allShortcutInputs.forEach(input => {
    const key = input.dataset.key;
    if (data[key]) input.value = data[key];
  });
  allFilterInputs.forEach(input => {
    const value = data[input.dataset.key] || 0;
    input.value = value > 0 ? value : '';
  });
  allAlertFilterCheckboxes.forEach(cb => {
    const key = 'fomoAlert' + cb.dataset.alertFilter.charAt(0).toUpperCase() + cb.dataset.alertFilter.slice(1);
    cb.checked = data[key] !== false;
  });
});

// Save toggle changes
tweetPreviewToggle.addEventListener('change', () => {
  chrome.storage.sync.set({ tweetPreview: tweetPreviewToggle.checked });
  showStatus(tweetPreviewToggle.checked ? '推特预览已开启' : '推特预览已关闭');
});

walletPreviewToggle.addEventListener('change', () => {
  chrome.storage.sync.set({ walletPreview: walletPreviewToggle.checked });
  showStatus(walletPreviewToggle.checked ? 'FOMO 钱包预览已开启' : 'FOMO 钱包预览已关闭');
});

countBoxToggle.addEventListener('change', () => {
  chrome.storage.sync.set({ countBox: countBoxToggle.checked });
  showStatus(countBoxToggle.checked ? 'fomo/pump 数据窗体已开启' : 'fomo/pump 数据窗体已关闭');
});

openSocialToggle.addEventListener('change', () => {
  chrome.storage.sync.set({ openSocialEnabled: openSocialToggle.checked });
  showStatus(openSocialToggle.checked ? '打开社媒已开启' : '打开社媒已关闭');
});

gmgnStyleToggle.addEventListener('change', () => {
  chrome.storage.sync.set({ fomoGmgnStyle: gmgnStyleToggle.checked });
  showStatus(gmgnStyleToggle.checked ? 'GMGN 风格 Alert 已开启' : 'GMGN 风格 Alert 已关闭');
});

hideThesisToggle.addEventListener('change', () => {
  chrome.storage.sync.set({ fomoHideThesis: hideThesisToggle.checked });
  showStatus(hideThesisToggle.checked ? '隐藏 Thesis 已开启' : '隐藏 Thesis 已关闭');
});

// ─── FOMO filter inputs (0 = unlimited) ───
allFilterInputs.forEach(input => {
  input.addEventListener('change', () => {
    const raw = parseFloat(input.value);
    const value = Number.isFinite(raw) && raw > 0 ? raw : 0;
    input.value = value > 0 ? value : '';

    const data = {};
    data[input.dataset.key] = value;
    chrome.storage.sync.set(data);

    const label = FILTER_LABELS[input.dataset.key] || '';
    showStatus(value > 0 ? label + ' 已设为 ' + value : label + ' 已取消限制');
  });
});

// ─── Alert buy/sell filter checkboxes ───
allAlertFilterCheckboxes.forEach(cb => {
  cb.addEventListener('change', () => {
    const key = 'fomoAlert' + cb.dataset.alertFilter.charAt(0).toUpperCase() + cb.dataset.alertFilter.slice(1);
    const data = {};
    data[key] = cb.checked;
    chrome.storage.sync.set(data);
    const labelMap = { buy: 'buy', sell: 'sell', thesis: 'Thesis', isup: 'Is Up', closed: 'Closed' };
    showStatus((labelMap[cb.dataset.alertFilter] || cb.dataset.alertFilter) + ' Alert ' + (cb.checked ? '已显示' : '已隐藏'));
  });
});

// ─── Shortcut key capture (supports multiple inputs) ───
let activeInput = null;
const heldKeys = new Set();
const stdModifiers = ['Control', 'Alt', 'Shift', 'Meta'];

allShortcutInputs.forEach(input => {
  input.addEventListener('focus', () => {
    activeInput = input;
    heldKeys.clear();
    input.value = '按下快捷键...';
  });
});

document.addEventListener('focusout', (e) => {
  if (activeInput && e.target === activeInput) {
    // Restore saved value if user didn't set a new one
    chrome.storage.sync.get(DEFAULTS, (data) => {
      const key = activeInput.dataset.key;
      if (data[key]) activeInput.value = data[key];
    });
    activeInput = null;
    heldKeys.clear();
  }
});

document.addEventListener('keydown', (e) => {
  if (!activeInput) return;
  e.preventDefault();

  if (stdModifiers.includes(e.key)) return;
  heldKeys.add(e.key);
});

document.addEventListener('keyup', (e) => {
  if (!activeInput) return;
  if (stdModifiers.includes(e.key)) return;

  const parts = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Meta');

  for (const k of heldKeys) {
    const display = k.length === 1 ? k.toUpperCase() : k.charAt(0).toUpperCase() + k.slice(1);
    parts.push(display);
  }

  if (parts.length === 0) {
    heldKeys.delete(e.key);
    return;
  }

  const shortcut = parts.join('+');
  const storageKey = activeInput.dataset.key;
  activeInput.value = shortcut;

  const data = {};
  data[storageKey] = shortcut;
  chrome.storage.sync.set(data);

  const labels = { hideShortcut: '隐藏代币', trenchesShortcut: '返回战壕', trendingShortcut: '跳转热门', monitorShortcut: '跳转监控', openFomoShortcut: 'GMGN/FOMO 互跳', xSearchShortcut: 'X 搜索', explorerShortcut: '区块浏览器', openSocialShortcut: '打开社媒' };
  showStatus((labels[storageKey] || '') + ' 快捷键已设为 ' + shortcut);

  activeInput = null;
  heldKeys.clear();
});

function showStatus(msg) {
  status.textContent = msg;
  status.className = 'status ok';
  setTimeout(() => {
    status.textContent = '';
    status.className = 'status';
  }, 2000);
}
