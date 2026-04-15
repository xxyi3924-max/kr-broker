// ─── KR Broker — Dashboard JS ───
const API_BASE = '/api';
let state = {
  apiKey: null,
  portfolio: null,
  assets: [],
  pendingOrders: [],
  conditionalOrders: [],
  priceHistory: {},        // assetCode -> [{ts, price}]
  editingConditional: null, // id of the conditional order being edited
  orderWindow: null,
  lastFetch: null,
  sortCol: 'ticker',
  sortDir: 'asc',
  searchQuery: '',
  currentOrder: { side: 'buy', type: 'MARKET', asset: null },
  agentLog: [],
  agentFilter: 'all',
};

let pollTimer = null;
let fetchCount = 0;

// ─── KR Broker API Key ───
const HARDCODED_API_KEY = 'ak_5aba203bf6275a7e6f5578686182f67bc23068b557ab8ed33fc16488af3b1d51';

// ─── Init ───
document.addEventListener('DOMContentLoaded', async () => {
  // Auto-fill the API key input
  const input = document.getElementById('api-key-input');
  if (input && !input.value) {
    input.value = HARDCODED_API_KEY;
  }
  
  // Auto-connect with hardcoded key
  setupApiKey();
  
  const saved = sessionStorage.getItem('kr_api_key');
  if (saved) {
    state.apiKey = saved;
    document.getElementById('api-key-screen').style.display = 'none';
    document.getElementById('main-dashboard').style.display = 'block';
    initDashboard();
  }

  // Tab nav
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Refresh
  document.getElementById('refresh-btn').addEventListener('click', refreshAll);

  // Search
  document.getElementById('asset-search').addEventListener('input', e => {
    state.searchQuery = e.target.value.toLowerCase();
    renderAssets();
  });
});

// ─── API Key Setup ───
async function setupApiKey() {
  const key = document.getElementById('api-key-input').value.trim();
  if (!key) return showToast('error', 'Missing API Key', 'Please enter your API key');

  showLoading(true);

  try {
    const res = await fetch(`${API_BASE}/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: key }),
    });
    const data = await res.json();
    showLoading(false);

    if (data.ok) {
      state.apiKey = key;
      sessionStorage.setItem('kr_api_key', key);
      document.getElementById('api-key-screen').style.display = 'none';
      document.getElementById('main-dashboard').style.display = 'block';
      initDashboard();
    } else {
      showToast('error', 'Connection Failed', data.error || 'Invalid API key');
    }
  } catch (err) {
    showLoading(false);
    showToast('error', 'Connection Error', err.message);
  }
}

// ─── Dashboard Init ───
async function initDashboard() {
  await refreshAll();
  fetchAgentLog();
  setInterval(fetchAgentLog, 30_000);
  scheduleNextPoll();
}

function scheduleNextPoll() {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    await refreshAll();
    scheduleNextPoll();
  }, 10000);
}

// ─── Refresh ───
let _refreshing = false;
async function refreshAll() {
  if (_refreshing) return;
  _refreshing = true;
  showLoading(true);
  try {
    const [portfolio, assets, pending, conditional] = await Promise.all([
      fetchPortfolio(),
      fetchAssets(),
      fetchPendingOrders(),
      fetchConditionalOrders(),
    ]);
    state.portfolio = portfolio;
    state.assets = assets.assets || [];
    state.pendingOrders = pending.pending_orders || [];
    state.conditionalOrders = conditional.orders || [];
    state.lastFetch = new Date();
    fetchCount++;

    // Fetch price history for held positions + waiting conditional order assets
    const positions = state.portfolio?.positions || [];
    const condAssets = [...new Set(
      state.conditionalOrders.filter(o => o.status === 'WAITING').map(o => o.asset_code)
    )];
    const allAssets = [...new Set([...positions.map(p => p.assetCode), ...condAssets])];
    await Promise.all(allAssets.map(async code => {
      const data = await fetchAPI(`/price-history/${code}`).catch(() => ({ history: [] }));
      state.priceHistory[code] = data.history || [];
    }));

    renderAll();
  } catch (e) {
    if (fetchCount > 0) showToast('error', 'Connection Error', e.message);
  }
  showLoading(false);
  _refreshing = false;
}

function showLoading(on) {
  const el = document.getElementById('loading-indicator');
  if (el) el.style.display = on ? 'inline-flex' : 'none';
}

// ─── API Calls ───
async function fetchAPI(path, opts = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(state.apiKey ? { 'Authorization': `Bearer ${state.apiKey}` } : {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

async function fetchPortfolio() {
  return fetchAPI('/portfolio');
}

async function fetchAssets() {
  return fetchAPI('/assets');
}

async function fetchPendingOrders() {
  return fetchAPI('/orders/pending');
}

async function fetchConditionalOrders() {
  return fetchAPI('/conditional-orders');
}

async function placeOrder(payload) {
  return fetchAPI('/orders', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

async function placeConditionalOrder(payload) {
  return fetchAPI('/conditional-orders', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

async function cancelConditionalOrder(id) {
  return fetchAPI(`/conditional-orders/${id}/cancel`, { method: 'POST' });
}

async function cancelOrder(id) {
  return fetchAPI(`/orders/${id}/cancel`, { method: 'POST' });
}

async function fetchAgentLog() {
  try {
    const data = await fetchAPI('/agent-log');
    state.agentLog = data.events || [];
    renderAgentLog();
    renderAgentBadge();
  } catch (e) { console.warn('fetchAgentLog failed', e); }
}

// ─── Render All ───
function renderAll() {
  renderOrderWindow();
  renderKPIs();
  renderPositions();
  renderPendingOrders();
  renderConditionalOrders();
  renderConditionalCharts();
  renderAssets();
  renderEquityChart();
}

// ─── Order Window ───
function renderOrderWindow() {
  const w = state.portfolio?.orderWindow;
  const el = document.getElementById('order-window-banner');
  if (!el) return;
  if (w && !w.isOpen) {
    el.textContent = '⚠️ Trading window is closed';
    el.className = 'banner visible';
  } else {
    el.className = 'banner';
  }
}

// ─── KPIs ───
function renderKPIs() {
  const p = state.portfolio;
  if (!p) return;

  const fmt = (n, dec = 2) => n != null ? `$${Number(n).toFixed(dec)}` : '—';
  const fmtPct = (n) => n != null ? `${n >= 0 ? '+' : ''}${n.toFixed(2)}%` : '—';

  const unrealPnL = p.unrealizedPnl || 0;
  const unrealPct = p.holdingsValue > 0 ? (unrealPnL / p.holdingsValue) * 100 : 0;
  const totalPnL = unrealPnL;

  document.getElementById('kpi-equity').textContent = fmt(p.totalEquity);
  document.getElementById('kpi-cash').textContent = fmt(p.availableCash);
  document.getElementById('kpi-unrealized').textContent = fmt(unrealPnL);
  document.getElementById('kpi-unrealized-pct').textContent = fmtPct(unrealPct);
  document.getElementById('kpi-total-pnl').textContent = fmt(totalPnL);
  document.getElementById('kpi-total-pnl-pct').textContent = fmtPct(p.totalReturn || 0);

  // P&L coloring
  const pnlClass = (n) => n >= 0 ? 'positive' : 'negative';
  document.getElementById('kpi-unrealized').className = `kpi-value ${pnlClass(unrealPnL)}`;
  document.getElementById('kpi-total-pnl').className = `kpi-value ${pnlClass(totalPnL)}`;
}

// ─── Positions ───
function renderPositions() {
  const tbody = document.getElementById('positions-body');
  const positions = state.portfolio?.positions || [];

  if (!positions.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-state">No open positions</td></tr>`;
    document.getElementById('position-charts').innerHTML = '';
    return;
  }

  const sorted = [...positions].sort((a, b) => {
    let av, bv;
    if (state.sortCol === 'ticker')        { av = a.assetCode; bv = b.assetCode; }
    else if (state.sortCol === 'avg_cost') { av = a.avgCost ?? 0; bv = b.avgCost ?? 0; }
    else if (state.sortCol === 'current_price') { av = a.currentPrice || 0; bv = b.currentPrice || 0; }
    else if (state.sortCol === 'unrealized')    { av = a.unrealizedPnl ?? 0; bv = b.unrealizedPnl ?? 0; }
    else if (state.sortCol === 'pct')           { av = a.unrealizedPnlPct ?? 0; bv = b.unrealizedPnlPct ?? 0; }
    if (typeof av === 'string') {
      return state.sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
    }
    return state.sortDir === 'asc' ? av - bv : bv - av;
  });

  tbody.innerHTML = sorted.map(pos => {
    const curPrice = pos.currentPrice || 0;
    const avgPrice = pos.avgCost ?? 0;
    const unrealized = pos.unrealizedPnl ?? ((curPrice - avgPrice) * pos.quantity);
    const pct = pos.unrealizedPnlPct ?? (avgPrice > 0 ? (curPrice - avgPrice) / avgPrice * 100 : 0);
    const pClass = unrealized >= 0 ? 'positive' : 'negative';

    return `<tr>
      <td>
        <div class="ticker">${pos.assetCode}</div>
        <div class="asset-name">${pos.assetName || ''}</div>
        <div style="font-size:11px; color:var(--muted); font-family:monospace;">${(pos.quantity||0).toFixed(4)} sh</div>
      </td>
      <td class="num">$${avgPrice.toFixed(2)}</td>
      <td class="num">$${curPrice.toFixed(2)}</td>
      <td class="num ${pClass}">${unrealized >= 0 ? '+' : ''}$${unrealized.toFixed(2)}</td>
      <td class="num ${pClass}">${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%</td>
      <td class="num">$${(pos.quantity * curPrice).toFixed(2)}</td>
      <td>
        <button class="btn btn-sm btn-buy" onclick="openOrderModal('buy', '${pos.assetCode}', '${pos.assetId || ''}')">Buy</button>
        <button class="btn btn-sm btn-sell" onclick="openOrderModal('sell', '${pos.assetCode}', '${pos.assetId || ''}', ${pos.quantity || 0})">Sell</button>
      </td>
    </tr>`;
  }).join('');

  renderPositionCharts(sorted);
}

function renderPositionCharts(positions) {
  const container = document.getElementById('position-charts');
  if (!container) return;

  container.style.gridTemplateColumns = positions.length > 1 ? '1fr 1fr' : '1fr';

  container.innerHTML = positions.map(pos => {
    const history = state.priceHistory[pos.assetCode] || [];
    const condOrders = state.conditionalOrders.filter(
      o => o.asset_code === pos.assetCode && o.status === 'WAITING'
    );
    const above = (pos.currentPrice || 0) >= (pos.avgCost || 0);
    const pClass = above ? 'positive' : 'negative';
    return `
      <div class="card" style="padding:12px 16px;">
        <div style="display:flex; justify-content:space-between; align-items:baseline; margin-bottom:8px;">
          <span style="font-weight:700; font-size:13px;">${pos.assetCode} <span style="font-weight:400; font-size:11px; color:var(--muted)">${pos.assetName || ''}</span></span>
          <span class="${pClass}" style="font-size:12px; font-family:monospace;">
            $${(pos.currentPrice||0).toFixed(2)}
            (${(pos.unrealizedPnlPct??0) >= 0 ? '+' : ''}${(pos.unrealizedPnlPct??0).toFixed(2)}%)
          </span>
        </div>
        ${history.length < 2
          ? `<div style="height:120px; display:flex; align-items:center; justify-content:center; color:var(--muted); font-size:12px;">Collecting data…</div>`
          : `<canvas id="pchart-${pos.assetCode}" height="120" style="width:100%; height:120px; display:block;"></canvas>`
        }
        <div style="display:flex; gap:16px; margin-top:8px; font-size:11px; color:var(--muted);">
          <span><span style="color:#f0883e;">——</span> Avg cost $${(pos.avgCost||0).toFixed(2)}</span>
          ${condOrders.map(o => `<span style="color:${o.side==='BUY'?'#3fb950':'#f85149'};">- - ${o.order_type} ${o.side} @ $${o.limit_price.toFixed(2)}</span>`).join('')}
        </div>
      </div>`;
  }).join('');

  // Draw canvases after DOM update
  requestAnimationFrame(() => {
    positions.forEach(pos => {
      const history = state.priceHistory[pos.assetCode] || [];
      if (history.length < 2) return;
      const condOrders = state.conditionalOrders.filter(
        o => o.asset_code === pos.assetCode && o.status === 'WAITING'
      );
      drawPriceChart(`pchart-${pos.assetCode}`, history, pos.avgCost || 0, condOrders);
    });
  });
}

function drawPriceChart(canvasId, history, avgCost, condOrders) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  // Match canvas resolution to display size
  canvas.width = canvas.parentElement.offsetWidth - 32;
  const W = canvas.width, H = canvas.height;
  const ctx = canvas.getContext('2d');

  // Collect all Y values for range
  const allPrices = history.map(h => h.price).concat(avgCost != null ? [avgCost] : []);
  (condOrders || []).forEach(o => {
    if (o.limit_price)   allPrices.push(o.limit_price);
    if (o.trigger_price) allPrices.push(o.trigger_price);
  });
  const minP = Math.min(...allPrices) * 0.9995;
  const maxP = Math.max(...allPrices) * 1.0005;
  const range = maxP - minP || 1;

  const toY = p => H - ((p - minP) / range) * H * 0.82 - H * 0.09;
  const toX = i => (i / Math.max(history.length - 1, 1)) * W;

  ctx.clearRect(0, 0, W, H);

  // Subtle grid
  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const y = H * i / 3;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }

  // avgCost dashed line (only for held positions)
  if (avgCost != null) {
    const avgY = toY(avgCost);
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = '#f0883e';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(0, avgY); ctx.lineTo(W, avgY); ctx.stroke();
  }

  // Conditional order lines
  (condOrders || []).forEach(o => {
    const color = o.side === 'BUY' ? '#3fb950' : '#f85149';
    if (o.limit_price) {
      const ly = toY(o.limit_price);
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, ly); ctx.lineTo(W, ly); ctx.stroke();
      ctx.fillStyle = color;
      ctx.font = '10px monospace';
      ctx.fillText(`limit $${o.limit_price.toFixed(2)}`, W - 88, ly - 3);
    }
    if (o.trigger_price) {
      const ty = toY(o.trigger_price);
      ctx.setLineDash([2, 5]);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, ty); ctx.lineTo(W, ty); ctx.stroke();
      ctx.fillStyle = color;
      ctx.font = '10px monospace';
      ctx.fillText(`trigger $${o.trigger_price.toFixed(2)}`, W - 104, ty - 3);
    }
  });

  ctx.setLineDash([]);

  // Area fill
  const above = avgCost == null || history[history.length - 1].price >= avgCost;
  ctx.beginPath();
  history.forEach((h, i) => {
    i === 0 ? ctx.moveTo(toX(i), toY(h.price)) : ctx.lineTo(toX(i), toY(h.price));
  });
  ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath();
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, above ? 'rgba(63,185,80,0.18)' : 'rgba(248,81,73,0.18)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.fill();

  // Price line
  ctx.beginPath();
  ctx.strokeStyle = above ? '#3fb950' : '#f85149';
  ctx.lineWidth = 2;
  history.forEach((h, i) => {
    i === 0 ? ctx.moveTo(toX(i), toY(h.price)) : ctx.lineTo(toX(i), toY(h.price));
  });
  ctx.stroke();

  // Current price label
  const last = history[history.length - 1];
  const lx = toX(history.length - 1);
  const ly2 = toY(last.price);
  ctx.fillStyle = above ? '#3fb950' : '#f85149';
  ctx.font = 'bold 10px monospace';
  const label = `$${last.price.toFixed(2)}`;
  ctx.fillText(label, Math.min(lx - label.length * 3, W - 60), ly2 - 5);
}

function sortBy(col) {
  if (state.sortCol === col) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
  else { state.sortCol = col; state.sortDir = 'asc'; }
  renderPositions();
}

// ─── Pending Orders ───
function renderPendingOrders() {
  const tbody = document.getElementById('pending-body');
  const orders = state.pendingOrders || [];

  if (!orders.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-state">No pending orders</td></tr>`;
    return;
  }

  tbody.innerHTML = orders.map(o => {
    const pClass = o.side === 'BUY' ? 'positive' : 'negative';
    const valueStr = o.side === 'BUY'
      ? `$${(o.orderAmount || 0).toFixed(2)}`
      : `${o.orderQuantity} shares`;
    return `<tr>
      <td><span class="pending-badge">Pending</span></td>
      <td><span class="${pClass}" style="font-weight:600">${o.side}</span></td>
      <td><div class="ticker">${o.assetCode}</div></td>
      <td class="num">${valueStr}</td>
      <td class="num">${o.status}</td>
      <td>
        <button class="btn-cancel" onclick="handleCancel('${o.orderId}')" id="cancel-${o.orderId}">
          Cancel
        </button>
      </td>
    </tr>`;
  }).join('');
}

async function handleCancel(id) {
  const btn = document.getElementById(`cancel-${id}`);
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  try {
    await cancelOrder(id);
    showToast('success', 'Order Cancelled', `Order ${id} has been cancelled`);
    await refreshAll();
  } catch (e) {
    showToast('error', 'Cancel Failed', e.message);
    if (btn) { btn.disabled = false; btn.textContent = 'Cancel'; }
  }
}

// ─── Conditional Orders ───
function renderConditionalCharts() {
  const container = document.getElementById('conditional-charts');
  if (!container) return;

  const heldCodes = new Set((state.portfolio?.positions || []).map(p => p.assetCode));
  const waitingOrders = state.conditionalOrders.filter(o => o.status === 'WAITING');

  // Group by asset_code, only assets NOT already shown in positions charts
  const byAsset = {};
  waitingOrders.forEach(o => {
    if (!heldCodes.has(o.asset_code)) {
      (byAsset[o.asset_code] = byAsset[o.asset_code] || []).push(o);
    }
  });

  const assets = Object.keys(byAsset);
  if (!assets.length) {
    container.innerHTML = '';
    return;
  }

  container.style.gridTemplateColumns = assets.length > 1 ? '1fr 1fr' : '1fr';

  container.innerHTML = assets.map(code => {
    const orders = byAsset[code];
    const history = state.priceHistory[code] || [];
    const curPrice = history.length ? history[history.length - 1].price : null;

    return `
      <div class="card" style="padding:12px 16px;">
        <div style="display:flex; justify-content:space-between; align-items:baseline; margin-bottom:8px;">
          <span style="font-weight:700; font-size:13px;">${code}</span>
          <span style="font-size:12px; font-family:monospace; color:var(--muted);">
            ${curPrice != null ? `$${curPrice.toFixed(2)}` : '—'}
          </span>
        </div>
        ${history.length < 2
          ? `<div style="height:120px; display:flex; align-items:center; justify-content:center; color:var(--muted); font-size:12px;">Collecting data…</div>`
          : `<canvas id="cchart-${code}" height="120" style="width:100%; height:120px; display:block;"></canvas>`
        }
        <div style="display:flex; flex-wrap:wrap; gap:12px; margin-top:8px; font-size:11px; color:var(--muted);">
          ${orders.map(o => `
            <span style="color:${o.side==='BUY'?'#3fb950':'#f85149'};">
              ${o.order_type} ${o.side} @ $${o.limit_price.toFixed(2)}
              ${o.trigger_price != null ? `/ trigger $${o.trigger_price.toFixed(2)}` : ''}
            </span>`).join('')}
        </div>
      </div>`;
  }).join('');

  requestAnimationFrame(() => {
    assets.forEach(code => {
      const history = state.priceHistory[code] || [];
      if (history.length < 2) return;
      drawPriceChart(`cchart-${code}`, history, null, byAsset[code]);
    });
  });
}

function renderConditionalOrders() {
  const tbody = document.getElementById('conditional-body');
  if (!tbody) return;
  const orders = state.conditionalOrders || [];

  if (!orders.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="empty-state">No conditional orders</td></tr>`;
    return;
  }

  const statusClass = s => ({ WAITING: '', FILLED: 'positive', CANCELLED: 'negative', FAILED: 'negative', TRIGGERED: 'positive' }[s] || '');

  tbody.innerHTML = orders.map(o => {
    const sideClass = o.side === 'BUY' ? 'positive' : 'negative';
    const limitPx = o.limit_price || 0;
    const valueStr = o.side === 'BUY'
      ? `${(o.order_quantity||0).toFixed(4)} sh<br><span style="font-size:11px;color:var(--muted);">~$${limitPx > 0 ? ((o.order_quantity||0)*limitPx).toFixed(2) : '?'} @ limit</span>`
      : `${(o.order_quantity||0).toFixed(4)} sh<br><span style="font-size:11px;color:var(--muted);">~$${limitPx > 0 ? ((o.order_quantity||0)*limitPx).toFixed(2) : '?'} @ limit</span>`;
    const created = o.created_at ? o.created_at.slice(0,16).replace('T',' ') : '—';
    const canEdit = o.status === 'WAITING';
    const isEditing = state.editingConditional === o.id;

    const limitCell = isEditing
      ? `<input id="edit-limit-${o.id}" type="number" step="any" value="${o.limit_price.toFixed(2)}"
           style="width:80px; font-family:monospace; font-size:12px; background:var(--input,#161b22); border:1px solid var(--accent); border-radius:4px; color:inherit; padding:2px 4px;" />`
      : `$${o.limit_price.toFixed(2)}`;

    const triggerCell = isEditing && o.order_type === 'STOP_LIMIT'
      ? `<input id="edit-trigger-${o.id}" type="number" step="any" value="${o.trigger_price != null ? o.trigger_price.toFixed(2) : ''}"
           style="width:80px; font-family:monospace; font-size:12px; background:var(--input,#161b22); border:1px solid var(--accent); border-radius:4px; color:inherit; padding:2px 4px;" />`
      : o.trigger_price != null ? `$${o.trigger_price.toFixed(2)}` : '—';

    const actions = canEdit
      ? isEditing
        ? `<button class="btn-cancel" onclick="handleSaveConditional(${o.id})">Save</button>
           <button class="btn-cancel" style="margin-left:4px;" onclick="state.editingConditional=null; renderConditionalOrders();">✕</button>`
        : `<button class="btn-cancel" onclick="state.editingConditional=${o.id}; renderConditionalOrders();">Edit</button>
           <button class="btn-cancel" style="margin-left:4px;" onclick="handleCancelConditional(${o.id})" id="cc-${o.id}">Cancel</button>`
      : '—';

    return `<tr>
      <td><div class="ticker">${o.asset_code}</div></td>
      <td><span class="${sideClass}" style="font-weight:600">${o.side}</span></td>
      <td>${o.order_type}</td>
      <td class="num">${valueStr}</td>
      <td class="num">${limitCell}</td>
      <td class="num">${triggerCell}</td>
      <td><span class="${statusClass(o.status)}">${o.status}</span></td>
      <td style="font-size:11px;color:var(--muted)">${created}</td>
      <td>${actions}</td>
    </tr>`;
  }).join('');
}

async function handleSaveConditional(id) {
  const limitInput = document.getElementById(`edit-limit-${id}`);
  const triggerInput = document.getElementById(`edit-trigger-${id}`);
  const limitPrice = parseFloat(limitInput?.value);
  if (!limitPrice || limitPrice <= 0) {
    showToast('error', 'Invalid Price', 'Enter a valid limit price');
    return;
  }
  const payload = { limit_price: limitPrice };
  if (triggerInput) {
    const tp = parseFloat(triggerInput.value);
    if (!tp || tp <= 0) {
      showToast('error', 'Invalid Price', 'Enter a valid trigger price');
      return;
    }
    payload.trigger_price = tp;
  }
  try {
    await fetchAPI(`/conditional-orders/${id}`, { method: 'PATCH', body: JSON.stringify(payload) });
    state.editingConditional = null;
    showToast('success', 'Order Updated', `Limit price set to $${limitPrice.toFixed(2)}`);
    await refreshAll();
  } catch (e) {
    showToast('error', 'Update Failed', e.message);
  }
}

async function handleCancelConditional(id) {
  const btn = document.getElementById(`cc-${id}`);
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  try {
    await cancelConditionalOrder(id);
    showToast('success', 'Cancelled', 'Conditional order removed');
    await refreshAll();
  } catch (e) {
    showToast('error', 'Cancel Failed', e.message);
    if (btn) { btn.disabled = false; btn.textContent = 'Cancel'; }
  }
}

// ─── Available Assets ───
function renderAssets() {
  const tbody = document.getElementById('assets-body');
  const all = state.assets || [];

  if (!state.searchQuery) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty-state">Type to search ${all.length.toLocaleString()} assets…</td></tr>`;
    return;
  }

  const q = state.searchQuery;
  const matches = all.filter(a =>
    (a.assetCode || '').toLowerCase().includes(q) ||
    (a.assetName || '').toLowerCase().includes(q)
  );

  if (!matches.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty-state">No assets found for "${q}"</td></tr>`;
    return;
  }

  const shown = matches.slice(0, 100);
  tbody.innerHTML = shown.map(a => {
    const changeClass = a.isUp ? 'positive' : 'negative';
    return `<tr>
      <td>
        <div class="ticker">${a.assetCode}</div>
        <div class="asset-name">${a.assetName}</div>
      </td>
      <td class="num">${a.currentPrice != null ? a.currentPrice.toFixed(2) : '—'}</td>
      <td class="num ${changeClass}">${a.change || '—'}</td>
      <td>${a.assetType || 'Stock'}</td>
      <td>
        <button class="btn btn-sm btn-buy" onclick="openOrderModal('buy', '${a.assetCode}', '${a.assetId}')">Buy</button>
        <button class="btn btn-sm btn-sell" onclick="openOrderModal('sell', '${a.assetCode}', '${a.assetId}')">Sell</button>
      </td>
    </tr>`;
  }).join('');

  if (matches.length > 100) {
    tbody.innerHTML += `<tr><td colspan="5" class="empty-state" style="font-size:11px;">${matches.length - 100} more — refine your search</td></tr>`;
  }
}

// ─── Equity Chart ───
function renderEquityChart() {
  const canvas = document.getElementById('equity-chart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const history = state.portfolio?.equity_history || [];

  if (!history.length) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }

  const W = canvas.width;
  const H = canvas.height;
  const pts = history;
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const range = max - min || 1;

  ctx.clearRect(0, 0, W, H);

  // Grid lines
  ctx.strokeStyle = '#21262d';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = H - (i / 4) * H;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }

  // Draw area fill
  ctx.beginPath();
  pts.forEach((p, i) => {
    const x = (i / (pts.length - 1)) * W;
    const y = H - ((p - min) / range) * H * 0.8 - H * 0.1;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.lineTo(W, H);
  ctx.lineTo(0, H);
  ctx.closePath();
  const gradient = ctx.createLinearGradient(0, 0, 0, H);
  gradient.addColorStop(0, 'rgba(47, 129, 247, 0.3)');
  gradient.addColorStop(1, 'rgba(47, 129, 247, 0.02)');
  ctx.fillStyle = gradient;
  ctx.fill();

  // Draw line
  ctx.beginPath();
  ctx.strokeStyle = '#2f81f7';
  ctx.lineWidth = 2;
  pts.forEach((p, i) => {
    const x = (i / (pts.length - 1)) * W;
    const y = H - ((p - min) / range) * H * 0.8 - H * 0.1;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();

  // Value label
  const last = pts[pts.length - 1];
  const lastX = W;
  const lastY = H - ((last - min) / range) * H * 0.8 - H * 0.1;
  ctx.fillStyle = '#2f81f7';
  ctx.beginPath();
  ctx.arc(lastX, lastY, 3, 0, Math.PI * 2);
  ctx.fill();
}

// ─── Order Modal ───
function openOrderModal(side, ticker, assetId, maxQty) {
  const quantity = (side === 'sell' && maxQty > 0) ? String(maxQty) : '';
  state.currentOrder = { side, type: 'MARKET', ticker, assetId: assetId || '', quantity, price: '', stopPrice: '', maxQty: maxQty || 0 };
  renderModal();
  document.getElementById('modal-overlay').classList.add('active');
}

function closeModal() {
  document.getElementById('modal-overlay').classList.remove('active');
}

function renderModal() {
  const o = state.currentOrder;

  // Buy/Sell tabs
  document.querySelectorAll('.order-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.side === o.side);
    t.classList.toggle('buy', t.dataset.side === 'buy');
    t.classList.toggle('sell', t.dataset.side === 'sell');
  });

  // Order type tabs
  document.querySelectorAll('.type-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.type === o.type);
  });

  // Ticker + live price from assets list
  document.getElementById('modal-ticker').textContent = o.ticker || '—';
  const asset = state.assets.find(a => a.assetCode === o.ticker);
  const curPrice = asset?.currentPrice;
  document.getElementById('modal-current-price').textContent =
    curPrice != null ? `$${curPrice.toFixed(2)}` : 'Market Price';

  // Main input label
  const label = document.getElementById('order-input-label');
  const input = document.getElementById('order-quantity');
  label.textContent = 'Quantity (shares)';
  input.placeholder = 'e.g. 10';
  input.value = o.quantity || '';

  // Show "Max" link for sell orders so user can fill exact position quantity
  const maxBtn = document.getElementById('order-quantity-max');
  if (maxBtn) {
    if (o.side === 'sell' && o.maxQty > 0) {
      maxBtn.style.display = 'inline';
      maxBtn.onclick = () => { input.value = o.maxQty; state.currentOrder.quantity = String(o.maxQty); updateOrderSummary(); };
    } else {
      maxBtn.style.display = 'none';
    }
  }

  // Limit / trigger fields
  const isLimit     = o.type === 'LIMIT';
  const isStopLimit = o.type === 'STOP_LIMIT';
  document.getElementById('limit-price-group').style.display   = (isLimit || isStopLimit) ? 'block' : 'none';
  document.getElementById('trigger-price-group').style.display = isStopLimit ? 'block' : 'none';

  document.getElementById('order-limit-price').value   = o.limitPrice || '';
  document.getElementById('order-trigger-price').value = o.triggerPrice || '';

  // Contextual hint text
  if (curPrice != null) {
    const lhint = document.getElementById('limit-price-hint');
    const thint = document.getElementById('trigger-price-hint');
    if (isLimit) {
      lhint.textContent = o.side === 'buy'
        ? `Execute when price ≤ limit. Current: $${curPrice.toFixed(2)}`
        : `Execute when price ≥ limit. Current: $${curPrice.toFixed(2)}`;
    } else if (isStopLimit) {
      thint.textContent = o.side === 'buy'
        ? `Activates when price rises to trigger. Current: $${curPrice.toFixed(2)}`
        : `Activates when price falls to trigger. Current: $${curPrice.toFixed(2)}`;
      lhint.textContent = o.side === 'buy'
        ? 'Max execution price (must be ≥ trigger)'
        : 'Min execution price (must be ≤ trigger)';
    }
  }

  updateOrderSummary();

  const btn = document.getElementById('order-submit-btn');
  btn.className = `btn-submit ${o.side}`;
  const typeLabel = o.type === 'MARKET' ? '' : ` ${o.type}`;
  btn.textContent = `${o.side === 'buy' ? 'Buy' : 'Sell'} ${o.ticker}${typeLabel}`;
}

function updateOrderSummary() {
  const o = state.currentOrder;
  const feeRate = state.portfolio?.feeEstimate?.buyFeeRate || 0.001;
  const val = parseFloat(o.quantity) || 0;
  const asset = state.assets.find(a => a.assetCode === o.ticker);
  const curPrice = asset?.currentPrice || 0;
  const execPrice = parseFloat(o.limitPrice) || curPrice;
  const summaryEl = document.getElementById('order-summary');
  const isConditional = o.type !== 'MARKET';

  if (o.side === 'buy') {
    if (isConditional) {
      const dollarValue = val * execPrice;
      const fee = dollarValue * feeRate;
      summaryEl.innerHTML = `
        <div class="summary-row"><span>Shares</span><span>${val.toFixed(4)} sh</span></div>
        <div class="summary-row"><span>Limit Price</span><span>$${execPrice.toFixed(2)}/sh</span></div>
        <div class="summary-row"><span>Est. Cost</span><span>$${dollarValue.toFixed(2)}</span></div>
        <div class="summary-row"><span>Fee (${(feeRate*100).toFixed(1)}%)</span><span>$${fee.toFixed(2)}</span></div>
        <div class="summary-row total"><span>Total Cost</span><span>$${(dollarValue+fee).toFixed(2)}</span></div>
      `;
    } else {
      const dollarValue = val * curPrice;
      const fee = dollarValue * feeRate;
      summaryEl.innerHTML = `
        <div class="summary-row"><span>Shares</span><span>${val.toFixed(4)} sh</span></div>
        <div class="summary-row"><span>Market Price</span><span>$${curPrice.toFixed(2)}/sh</span></div>
        <div class="summary-row"><span>Est. Cost</span><span>$${dollarValue.toFixed(2)}</span></div>
        <div class="summary-row"><span>Fee (${(feeRate*100).toFixed(1)}%)</span><span>$${fee.toFixed(2)}</span></div>
        <div class="summary-row total"><span>Total Cost</span><span>$${(dollarValue+fee).toFixed(2)}</span></div>
      `;
    }
  } else {
    const proceeds = val * (isConditional ? execPrice : curPrice);
    const fee = proceeds * feeRate;
    summaryEl.innerHTML = `
      <div class="summary-row"><span>Shares</span><span>${val.toFixed(4)}</span></div>
      ${isConditional ? `<div class="summary-row"><span>Exec. at least</span><span>$${execPrice.toFixed(2)}/sh</span></div>` : ''}
      <div class="summary-row"><span>Est. Proceeds</span><span>$${proceeds.toFixed(2)}</span></div>
      <div class="summary-row"><span>Fee (${(feeRate*100).toFixed(1)}%)</span><span>$${fee.toFixed(2)}</span></div>
      <div class="summary-row total"><span>Net Proceeds</span><span>$${(proceeds-fee).toFixed(2)}</span></div>
    `;
  }
}

async function handleSubmitOrder() {
  const o = state.currentOrder;
  const val = parseFloat(document.getElementById('order-quantity').value);
  if (!val || val <= 0) {
    showToast('error', 'Invalid Quantity', 'Enter a positive share quantity');
    return;
  }

  const btn = document.getElementById('order-submit-btn');
  btn.disabled = true;
  btn.textContent = 'Placing Order…';

  try {
    if (o.type === 'MARKET') {
      const asset = state.assets.find(a => a.assetCode === o.ticker);
      const curPrice = asset?.currentPrice || 0;
      const payload = { side: o.side.toUpperCase(), ticker: o.ticker };
      if (o.side === 'buy') {
        if (!curPrice) {
          showToast('error', 'No Price', 'Current price unavailable');
          btn.disabled = false;
          btn.textContent = `Buy ${o.ticker}`;
          return;
        }
        payload.order_amount = val * curPrice;
      } else {
        payload.order_quantity = val;
      }
      const result = await placeOrder(payload);
      if (result.failedCount > 0) {
        const reason = result.failures?.[0]?.reason || 'Order rejected by exchange';
        showToast('error', 'Order Failed', reason);
        return;
      }
      const label = `${val} shares`;
      showToast('success', 'Order Placed!', `${o.side.toUpperCase()} ${o.ticker} — ${label}`);

    } else {
      // LIMIT or STOP_LIMIT — store as conditional order
      const limitPrice = parseFloat(document.getElementById('order-limit-price').value);
      if (!limitPrice || limitPrice <= 0) {
        showToast('error', 'Missing Limit Price', 'Enter a valid limit price');
        btn.disabled = false;
        btn.textContent = `${o.side === 'buy' ? 'Buy' : 'Sell'} ${o.ticker} ${o.type}`;
        return;
      }

      const payload = {
        ticker: o.ticker,
        side: o.side.toUpperCase(),
        order_type: o.type,
        limit_price: limitPrice,
      };
      payload.order_quantity = val;

      if (o.type === 'STOP_LIMIT') {
        const triggerPrice = parseFloat(document.getElementById('order-trigger-price').value);
        if (!triggerPrice || triggerPrice <= 0) {
          showToast('error', 'Missing Trigger Price', 'Enter a valid trigger price');
          btn.disabled = false;
          btn.textContent = `${o.side === 'buy' ? 'Buy' : 'Sell'} ${o.ticker} ${o.type}`;
          return;
        }
        payload.trigger_price = triggerPrice;
      }

      await placeConditionalOrder(payload);
      showToast('success', 'Conditional Order Set', `${o.type} ${o.side.toUpperCase()} ${o.ticker} @ $${limitPrice.toFixed(2)}`);
    }

    closeModal();
    await refreshAll();
  } catch (e) {
    showToast('error', 'Order Failed', e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = `${o.side === 'buy' ? 'Buy' : 'Sell'} ${o.ticker}`;
  }
}

// ─── Agent Activity ───
function fmtAgentTs(ts) {
  // ts = "2026-04-09 18:00:00" (UTC from log)
  const d = new Date(ts.replace(' ', 'T') + 'Z');
  const utc = d.toLocaleString('en-US', {
    timeZone: 'UTC', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const et = d.toLocaleString('en-US', {
    timeZone: 'America/Toronto',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  return { utc, et };
}

function fmtCycleHeader(ts) {
  const d = new Date(ts.replace(' ', 'T') + 'Z');
  const date = d.toLocaleDateString('en-US', { timeZone: 'America/Toronto', month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString('en-US', { timeZone: 'America/Toronto', hour: '2-digit', minute: '2-digit', hour12: false });
  return `${date} · ${time} ET`;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const AGENT_EVENT_STYLE = {
  cycle_start:   ['●', 'CYCLE'],
  cycle_summary: ['·', 'SUMMARY'],
  order_ok:      ['✅', 'ORDER'],
  order_fail:    ['❌', 'ORDER'],
  error:         ['⚠', 'ERROR'],
  dropped:       ['○', 'DROPPED'],
  selected:      ['→', 'SIGNAL'],
  broker_warn:   ['⚡', 'BROKER'],
};

function renderAgentEvent(e) {
  const [icon, label] = AGENT_EVENT_STYLE[e.type] || ['·', e.type.toUpperCase()];
  const { utc, et } = fmtAgentTs(e.ts);
  return `<div class="agent-event ae-${escHtml(e.type)}">
    <span class="ae-icon">${icon}</span>
    <span class="ae-time" title="${escHtml(utc)} UTC">${escHtml(et)}</span>
    <span class="ae-label">${label}</span>
    <span class="ae-msg">${escHtml(e.msg)}</span>
  </div>`;
}

function renderAgentFilterBar() {
  const f = state.agentFilter;
  const filters = [
    ['all', 'All'],
    ['errors', 'Errors'],
    ['orders', 'Orders'],
    ['signals', 'Signals'],
    ['dropped', 'Dropped'],
  ];
  return `<div class="ae-filter-bar">${
    filters.map(([id, label]) =>
      `<button class="ae-filter-btn${f === id ? ' active' : ''}" onclick="setAgentFilter('${id}')">${label}</button>`
    ).join('')
  }</div>`;
}

function renderAgentLog() {
  const el = document.getElementById('agent-log-feed');
  if (!el) return;
  const events = state.agentLog;
  const filterBar = renderAgentFilterBar();

  if (!events.length) {
    el.innerHTML = filterBar + '<p class="empty-state">No agent activity found.</p>';
    return;
  }

  const filter = state.agentFilter;

  if (filter !== 'all') {
    const typeMap = {
      errors:  ['error', 'order_fail', 'broker_warn'],
      orders:  ['order_ok', 'order_fail'],
      signals: ['selected'],
      dropped: ['dropped'],
    };
    const allowed = typeMap[filter] || [];
    const filtered = events.filter(e => allowed.includes(e.type));
    if (!filtered.length) {
      el.innerHTML = filterBar + `<p class="empty-state" style="margin-top:16px;">No ${filter} in log.</p>`;
      return;
    }
    el.innerHTML = filterBar + filtered.map(e => renderAgentEvent(e)).join('');
    return;
  }

  // Group events into cycles (events are newest-first)
  const cycles = [];
  let current = null;
  for (const e of events) {
    if (e.type === 'cycle_start') {
      current = { ts: e.ts, events: [] };
      cycles.push(current);
    } else if (current) {
      current.events.push(e);
    } else {
      if (!cycles.length) cycles.push({ ts: null, events: [] });
      cycles[cycles.length - 1].events.push(e);
    }
  }

  const cyclesHtml = cycles.map((cycle, i) => {
    const isOpen = i === 0;
    const timeStr = cycle.ts ? escHtml(fmtCycleHeader(cycle.ts)) : 'Before first cycle';

    const orderCount  = cycle.events.filter(e => e.type === 'order_ok' || e.type === 'order_fail').length;
    const errorCount  = cycle.events.filter(e => e.type === 'error' || e.type === 'order_fail' || e.type === 'broker_warn').length;
    const signalCount = cycle.events.filter(e => e.type === 'selected').length;

    const badges = [
      orderCount  > 0 ? `<span class="ae-cycle-badge orders">${orderCount} order${orderCount > 1 ? 's' : ''}</span>` : '',
      errorCount  > 0 ? `<span class="ae-cycle-badge errors">${errorCount} error${errorCount > 1 ? 's' : ''}</span>` : '',
      signalCount > 0 ? `<span class="ae-cycle-badge signals">${signalCount} signal${signalCount > 1 ? 's' : ''}</span>` : '',
    ].join('');

    const bodyHtml = cycle.events.length
      ? cycle.events.map(e => renderAgentEvent(e)).join('')
      : '<div style="font-size:12px; color:#2d4060; padding:6px 0;">No events recorded in this cycle</div>';

    return `<div class="ae-cycle-group${isOpen ? ' open' : ''}">
      <div class="ae-cycle-header" onclick="toggleCycleGroup(this)">
        <span class="ae-cycle-toggle">▶</span>
        <span class="ae-cycle-time">${timeStr}</span>
        <span class="ae-cycle-badges">${badges}</span>
      </div>
      <div class="ae-cycle-body" style="${isOpen ? '' : 'display:none;'}">
        ${bodyHtml}
      </div>
    </div>`;
  }).join('');

  el.innerHTML = filterBar + cyclesHtml;
}

function setAgentFilter(filter) {
  state.agentFilter = filter;
  renderAgentLog();
}

function toggleCycleGroup(headerEl) {
  const group = headerEl.parentElement;
  const body = group.querySelector('.ae-cycle-body');
  if (!body) return;
  const isOpen = group.classList.contains('open');
  group.classList.toggle('open', !isOpen);
  body.style.display = isOpen ? 'none' : '';
}

function renderAgentBadge() {
  const events = state.agentLog;
  const lastCycle = events.find(e => e.type === 'cycle_start');
  const badgeTime = document.getElementById('agent-badge-time');
  if (badgeTime && lastCycle) {
    const { utc, et } = fmtAgentTs(lastCycle.ts);
    badgeTime.textContent = `${utc} UTC / ${et} ET`;
  } else if (badgeTime) {
    badgeTime.textContent = '–';
  }

  const errCount = events.filter(e =>
    e.type === 'error' || e.type === 'order_fail' || e.type === 'broker_warn'
  ).length;
  const errEl = document.getElementById('agent-badge-errors');
  const errNum = document.getElementById('agent-error-count');
  const tabBtn = document.getElementById('agent-tab-btn');
  if (errEl) errEl.style.display = errCount > 0 ? 'inline' : 'none';
  if (errNum) errNum.textContent = errCount;
  if (tabBtn) tabBtn.textContent = errCount > 0 ? `Agent ⚠` : 'Agent';
}

// ─── Tabs ───
function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  document.querySelectorAll('.tab-pane').forEach(p => {
    p.style.display = p.dataset.tab === tab ? 'block' : 'none';
  });
}

// ─── Toast Notifications ───
function showToast(type, title, msg) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<div class="toast-title">${title}</div><div class="toast-msg">${msg}</div>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(20px)';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// ─── Expose to HTML onclick ───
window.openOrderModal = openOrderModal;
window.closeModal = closeModal;
window.handleSubmitOrder = handleSubmitOrder;
window.handleCancel = handleCancel;
window.handleCancelConditional = handleCancelConditional;
window.handleSaveConditional = handleSaveConditional;
window.sortBy = sortBy;
window.switchTab = switchTab;
window.setupApiKey = setupApiKey;
