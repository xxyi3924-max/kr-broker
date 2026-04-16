"""
KR Broker — Flask Backend
Connects to Kaigora Agora Agent API.
Simulates LIMIT / STOP-LIMIT orders locally via price-monitor thread.
"""
import os, sqlite3, time, json, threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta
from functools import wraps
from flask import Flask, render_template, request, jsonify, session

app = Flask(__name__, template_folder='templates', static_folder='static')
app.secret_key = os.environ.get('SECRET_KEY', 'kr-broker-secret-2024')
SESSION_LIFETIME = 86400  # 24 hours

DB_PATH = os.path.join(os.path.dirname(__file__), 'data', 'kr_broker.db')
AGORA_BASE = os.environ.get('AGORA_URL', 'https://kaigora.com/api/v1')

# Only these assets (plus current holdings) are tracked in price_history
TRACK_ASSETS = {'QQQ', 'SPY'}

# ─── DB Setup ───
def get_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    db = get_db()
    db.executescript('''
        CREATE TABLE IF NOT EXISTS equity_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT,
            total_equity REAL,
            unrealized_pnl REAL,
            cash REAL
        );
        CREATE TABLE IF NOT EXISTS trade_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT,
            order_id TEXT,
            ticker TEXT,
            side TEXT,
            quantity REAL,
            price REAL,
            order_type TEXT,
            status TEXT
        );
        CREATE TABLE IF NOT EXISTS conditional_orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at TEXT NOT NULL,
            api_key TEXT NOT NULL,
            asset_code TEXT NOT NULL,
            side TEXT NOT NULL,
            order_type TEXT NOT NULL,
            limit_price REAL NOT NULL,
            trigger_price REAL,
            order_amount REAL,
            order_quantity REAL,
            status TEXT NOT NULL DEFAULT "WAITING",
            triggered_at TEXT,
            filled_at TEXT,
            fill_order_id TEXT,
            cancel_reason TEXT
        );
        CREATE TABLE IF NOT EXISTS bad_data_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT,
            endpoint TEXT,
            reason TEXT,
            raw_response TEXT
        );
        CREATE TABLE IF NOT EXISTS price_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            asset_code TEXT NOT NULL,
            price REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_equity_ts ON equity_log(timestamp);
        CREATE INDEX IF NOT EXISTS idx_trade_ts ON trade_log(timestamp);
        CREATE INDEX IF NOT EXISTS idx_cond_status ON conditional_orders(status);
        CREATE INDEX IF NOT EXISTS idx_price_hist ON price_history(asset_code, timestamp);
    ''')
    db.commit()
    db.close()

# ─── Agora API Client ───
import requests as req_lib

class AgoraClient:
    def __init__(self, api_key):
        self.api_key = api_key
        self.base = AGORA_BASE
        self.session = req_lib.Session()
        self.session.headers.update({
            'Authorization': f'Bearer {api_key}',
            'Content-Type': 'application/json',
        })

    # Routine polling endpoints — full response bodies are never interesting
    _SKIP_LOG = frozenset({'/available-assets', '/my-portfolio', '/my-participant-info'})

    def _log(self, method, path, body):
        # Only log POST actions (orders, cancels) and unexpected GET responses.
        # Routine polling responses would bloat the log with hundreds of MB/day.
        if method == 'GET' and path in self._SKIP_LOG:
            return
        entry = {
            'ts': datetime.utcnow().isoformat(),
            'method': method,
            'endpoint': path,
            'body': body,
        }
        log_path = os.path.join(os.path.dirname(DB_PATH), 'api_log.jsonl')
        with open(log_path, 'a') as f:
            f.write(json.dumps(entry) + '\n')

    def _get(self, path, timeout=10):
        resp = self.session.get(f'{self.base}{path}', timeout=timeout)
        resp.raise_for_status()
        body = resp.json()
        self._log('GET', path, body)
        return body

    def _post(self, path, data=None, timeout=10):
        resp = self.session.post(f'{self.base}{path}', json=data, timeout=timeout)
        resp.raise_for_status()
        body = resp.json()
        self._log('POST', path, body)
        return body

    def get_portfolio(self):
        return self._get('/my-portfolio')

    def get_participant_info(self):
        return self._get('/my-participant-info')

    def get_available_assets(self, page=None):
        path = '/available-assets'
        if page is not None:
            path += f'?page={page}'
        return self._get(path)

    def place_order(self, asset_code, side, order_amount=None, order_quantity=None):
        side = side.upper()
        if side == 'BUY':
            item = {'assetCode': asset_code, 'side': 'BUY', 'orderAmount': float(order_amount)}
        else:
            item = {'assetCode': asset_code, 'side': 'SELL', 'orderQuantity': float(order_quantity)}
        return self._post('/orders', data={'items': [item]})

    def cancel_order(self, order_id):
        return self._post(f'/orders/{order_id}/cancel')

# ─── Price Cache (per api_key, 60s TTL) ───
_price_cache = {}          # api_key -> {'prices': {assetCode: price}, 'at': epoch}
_price_cache_lock = threading.Lock()
PRICE_CACHE_TTL = 60       # seconds

# ─── Market-Open Cache (per api_key, 60s TTL) ───
_market_cache = {}         # api_key -> {'open': bool, 'at': epoch}
_market_cache_lock = threading.Lock()

# ─── Assets Cache (per api_key, 10 min TTL — full universe, all pages) ───
_assets_cache = {}         # api_key -> {'assets': [...], 'at': epoch}
_assets_cache_lock = threading.Lock()
ASSETS_CACHE_TTL = 600     # 10 minutes

def is_market_open(api_key):
    """Return True if the order window is currently OPEN, with 60s caching."""
    now = time.time()
    with _market_cache_lock:
        entry = _market_cache.get(api_key)
        if entry and (now - entry['at']) < PRICE_CACHE_TTL:
            return entry['open']
    try:
        client = AgoraClient(api_key)
        info = client.get_participant_info()
        state = info.get('orderWindowState') or info.get('order_window_state', '')
        open_ = state.upper() == 'OPEN'
        with _market_cache_lock:
            _market_cache[api_key] = {'open': open_, 'at': now}
        return open_
    except Exception:
        return False

def get_prices(api_key):
    """Fetch all asset prices for an api_key, using a 60s in-memory cache.
    Loads all pages in parallel so conditional orders fire for every ticker."""
    now = time.time()
    with _price_cache_lock:
        entry = _price_cache.get(api_key)
        if entry and (now - entry['at']) < PRICE_CACHE_TTL:
            return entry['prices']
    try:
        all_assets = _load_all_assets(api_key)
        # Also refresh the assets cache as a side effect
        with _assets_cache_lock:
            _assets_cache[api_key] = {'assets': all_assets, 'at': now}
        prices = {a['assetCode']: float(a['currentPrice'])
                  for a in all_assets
                  if a.get('currentPrice') is not None}
        with _price_cache_lock:
            _price_cache[api_key] = {'prices': prices, 'at': now}
        return prices
    except Exception:
        return {}

# ─── Conditional Order Monitor ───
def _condition_met(order, price):
    """Return True if the current price satisfies this conditional order."""
    otype = order['order_type']
    side  = order['side']
    lp    = order['limit_price']
    tp    = order['trigger_price']

    if otype == 'LIMIT':
        return price <= lp if side == 'BUY' else price >= lp

    if otype == 'STOP_LIMIT':
        if side == 'BUY':
            # Trigger when price rises to trigger_price; only buy if still <= limit_price
            return price >= tp and price <= lp
        else:
            # Trigger when price falls to trigger_price; only sell if still >= limit_price
            return price <= tp and price >= lp

    return False

def check_conditional_orders():
    """Called by background thread: check all WAITING orders and fire market orders."""
    db = get_db()
    rows = db.execute(
        "SELECT * FROM conditional_orders WHERE status = 'WAITING'"
    ).fetchall()
    db.close()

    if not rows:
        return

    # Group by api_key to minimise price fetches
    by_key = {}
    for r in rows:
        by_key.setdefault(r['api_key'], []).append(dict(r))

    for api_key, orders in by_key.items():
        prices = get_prices(api_key)
        if not prices:
            continue

        # Record prices for QQQ and SPY only when market is open
        if is_market_open(api_key):
            now_str = datetime.utcnow().isoformat()
            db_ph = get_db()
            for ticker in TRACK_ASSETS:
                price = prices.get(ticker)
                if price is not None:
                    db_ph.execute(
                        'INSERT INTO price_history (timestamp, asset_code, price) VALUES (?,?,?)',
                        (now_str, ticker, price)
                    )
            db_ph.commit()
            db_ph.close()

        client = AgoraClient(api_key)
        for order in orders:
            price = prices.get(order['asset_code'])
            if price is None:
                continue
            if not _condition_met(order, price):
                continue

            # Condition met — fire a market order
            now = datetime.utcnow().isoformat()
            try:
                fill_amount = order['order_amount']
                if order['side'] == 'BUY' and order['order_quantity'] and not fill_amount:
                    fill_amount = order['order_quantity'] * price
                result = client.place_order(
                    asset_code=order['asset_code'],
                    side=order['side'],
                    order_amount=fill_amount,
                    order_quantity=order['order_quantity'],
                )
                order_ids = result.get('orderIds', [])
                fill_id = order_ids[0] if order_ids else ''

                db2 = get_db()
                db2.execute(
                    "UPDATE conditional_orders SET status='FILLED', triggered_at=?, filled_at=?, fill_order_id=? WHERE id=?",
                    (now, now, fill_id, order['id'])
                )
                db2.execute(
                    'INSERT INTO trade_log (timestamp,order_id,ticker,side,quantity,price,order_type,status) VALUES (?,?,?,?,?,?,?,?)',
                    (now, fill_id, order['asset_code'], order['side'],
                     order['order_quantity'] or 0, order['order_amount'] or price,
                     order['order_type'], 'TRIGGERED')
                )
                db2.commit()
                db2.close()
            except Exception as e:
                db2 = get_db()
                db2.execute(
                    "UPDATE conditional_orders SET status='FAILED', cancel_reason=? WHERE id=?",
                    (str(e), order['id'])
                )
                db2.commit()
                db2.close()

def _monitor_loop():
    last_compact = datetime.utcnow().date()
    while True:
        try:
            check_conditional_orders()
        except Exception:
            pass
        today = datetime.utcnow().date()
        if today != last_compact:
            try:
                compact_old_data()
                compact_api_log()
            except Exception:
                pass
            last_compact = today
        time.sleep(30)

# ─── Auth ───
def require_api_key(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        auth = request.headers.get('Authorization', '')
        api_key = auth.replace('Bearer ', '') if auth.startswith('Bearer ') else None
        if not api_key:
            return jsonify({'error': 'Missing API key'}), 401
        session['api_key'] = api_key
        session.permanent = True
        app.permanent_session_lifetime = SESSION_LIFETIME
        return f(*args, **kwargs)
    return decorated

def get_api_key():
    auth = request.headers.get('Authorization', '')
    return auth.replace('Bearer ', '') if auth.startswith('Bearer ') else session.get('api_key')

def get_client():
    api_key = get_api_key()
    if not api_key:
        raise ValueError('No API key')
    return AgoraClient(api_key)

# ─── Routes ───
@app.route('/')
def index():
    return render_template('dashboard.html')

@app.route('/api/portfolio')
@require_api_key
def api_portfolio():
    try:
        client = get_client()
        portfolio = client.get_portfolio()
        try:
            now = datetime.utcnow().isoformat()
            db = get_db()
            api_key_for_prices = get_api_key()

            if api_key_for_prices and is_market_open(api_key_for_prices):
                db.execute(
                    'INSERT INTO equity_log (timestamp,total_equity,unrealized_pnl,cash) VALUES (?,?,?,?)',
                    (now,
                     portfolio.get('totalEquity', 0),
                     portfolio.get('unrealizedPnl', 0),
                     portfolio.get('availableCash', 0))
                )

                # Record price history for held positions only
                for pos in portfolio.get('positions', []):
                    if pos.get('currentPrice') is not None:
                        db.execute(
                            'INSERT INTO price_history (timestamp, asset_code, price) VALUES (?,?,?)',
                            (now, pos['assetCode'], pos['currentPrice'])
                        )

                # Always record QQQ and SPY prices (using cached price fetch)
                all_prices = get_prices(api_key_for_prices)
                for ticker in TRACK_ASSETS:
                    price = all_prices.get(ticker)
                    if price is not None:
                        db.execute(
                            'INSERT INTO price_history (timestamp, asset_code, price) VALUES (?,?,?)',
                            (now, ticker, price)
                        )

            # Log any holdings with null/zero avgCost
            bad_holdings = [
                h for h in portfolio.get('positions', [])
                if not h.get('avgCost')
            ]
            if bad_holdings:
                db.execute(
                    'INSERT INTO bad_data_log (timestamp,endpoint,reason,raw_response) VALUES (?,?,?,?)',
                    (now, '/my-portfolio',
                     f'{len(bad_holdings)} holding(s) with null/zero avgCost: ' +
                     ', '.join(h.get('assetCode', '?') for h in bad_holdings),
                     json.dumps(portfolio))
                )

            db.commit()
            db.close()
        except Exception:
            pass
        return jsonify(portfolio)
    except Exception as e:
        return jsonify({'error': str(e)}), 500

def _fetch_asset_page(api_key, page):
    """Fetch a single page from Kaigora /available-assets (for parallel loading)."""
    resp = req_lib.get(
        f'{AGORA_BASE}/available-assets?page={page}',
        headers={'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'},
        timeout=15,
    )
    resp.raise_for_status()
    return resp.json()

def _load_all_assets(api_key):
    """Fetch all pages of Kaigora assets in parallel. Returns list of asset dicts."""
    first = _fetch_asset_page(api_key, 1)
    total_pages = first.get('pagination', {}).get('totalPages', 1)
    all_assets = list(first.get('available_assets', first.get('assets', [])))

    if total_pages > 1:
        with ThreadPoolExecutor(max_workers=20) as ex:
            futures = {ex.submit(_fetch_asset_page, api_key, p): p
                       for p in range(2, total_pages + 1)}
            for fut in as_completed(futures):
                try:
                    data = fut.result()
                    all_assets.extend(data.get('available_assets', data.get('assets', [])))
                except Exception as e:
                    app.logger.warning(f'Asset page load error: {e}')

    return all_assets

@app.route('/api/assets')
@require_api_key
def api_assets():
    try:
        api_key = get_api_key()
        now = time.time()
        with _assets_cache_lock:
            entry = _assets_cache.get(api_key)
            if entry and (now - entry['at']) < ASSETS_CACHE_TTL:
                return jsonify({'assets': entry['assets']})

        all_assets = _load_all_assets(api_key)

        with _assets_cache_lock:
            _assets_cache[api_key] = {'assets': all_assets, 'at': now}

        return jsonify({'assets': all_assets})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/orders', methods=['GET', 'POST'])
@require_api_key
def api_orders():
    try:
        client = get_client()
        if request.method == 'POST':
            body = request.get_json() or {}
            side = (body.get('side') or '').upper()
            result = client.place_order(
                asset_code=body.get('ticker'),
                side=side,
                order_amount=body.get('order_amount'),
                order_quantity=body.get('order_quantity'),
            )
            try:
                order_ids = result.get('orderIds', [])
                ticker = body.get('ticker', '')
                qty = body.get('order_quantity') or 0
                amount = body.get('order_amount') or 0
                # For sells (qty-based), look up current market price as fill price
                if side == 'SELL' and qty and not amount:
                    prices = get_prices(get_api_key())
                    amount = prices.get(ticker, 0)
                db = get_db()
                db.execute(
                    'INSERT INTO trade_log (timestamp,order_id,ticker,side,quantity,price,order_type,status) VALUES (?,?,?,?,?,?,?,?)',
                    (datetime.utcnow().isoformat(),
                     order_ids[0] if order_ids else '',
                     ticker, side, qty, amount,
                     'MARKET', 'FILLED')
                )
                db.commit()
                db.close()
            except Exception:
                pass
            return jsonify(result)
        else:
            info = client.get_participant_info()
            return jsonify({'orders': info.get('pendingOrders', [])})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/orders/pending')
@require_api_key
def api_pending():
    try:
        client = get_client()
        info = client.get_participant_info()
        return jsonify({'pending_orders': info.get('pendingOrders', [])})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/orders/<order_id>/cancel', methods=['POST'])
@require_api_key
def api_cancel(order_id):
    try:
        client = get_client()
        result = client.cancel_order(order_id)
        return jsonify(result)
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# ─── Conditional Orders ───
@app.route('/api/conditional-orders', methods=['GET', 'POST'])
@require_api_key
def api_conditional_orders():
    api_key = get_api_key()
    if request.method == 'POST':
        body = request.get_json() or {}
        order_type = (body.get('order_type') or '').upper()
        side = (body.get('side') or '').upper()

        if order_type not in ('LIMIT', 'STOP_LIMIT'):
            return jsonify({'error': 'order_type must be LIMIT or STOP_LIMIT'}), 400
        if side not in ('BUY', 'SELL'):
            return jsonify({'error': 'side must be BUY or SELL'}), 400

        limit_price = body.get('limit_price')
        trigger_price = body.get('trigger_price')
        order_amount = body.get('order_amount')
        order_quantity = body.get('order_quantity')

        if not limit_price or limit_price <= 0:
            return jsonify({'error': 'limit_price required and must be > 0'}), 400
        if order_type == 'STOP_LIMIT' and (not trigger_price or trigger_price <= 0):
            return jsonify({'error': 'trigger_price required for STOP_LIMIT'}), 400
        if side == 'BUY' and (not order_quantity or order_quantity <= 0):
            return jsonify({'error': 'order_quantity required for BUY'}), 400
        if side == 'SELL' and (not order_quantity or order_quantity <= 0):
            return jsonify({'error': 'order_quantity required for SELL'}), 400

        try:
            db = get_db()
            cur = db.execute(
                '''INSERT INTO conditional_orders
                   (created_at, api_key, asset_code, side, order_type,
                    limit_price, trigger_price, order_amount, order_quantity, status)
                   VALUES (?,?,?,?,?,?,?,?,?,'WAITING')''',
                (datetime.utcnow().isoformat(), api_key,
                 body.get('ticker', '').upper(), side, order_type,
                 float(limit_price), float(trigger_price) if trigger_price else None,
                 float(order_amount) if order_amount else None,
                 float(order_quantity) if order_quantity else None)
            )
            db.commit()
            row_id = cur.lastrowid
            db.close()
            return jsonify({'ok': True, 'id': row_id})
        except Exception as e:
            return jsonify({'error': str(e)}), 500

    else:
        try:
            db = get_db()
            rows = db.execute(
                "SELECT * FROM conditional_orders WHERE api_key=? ORDER BY id DESC LIMIT 100",
                (api_key,)
            ).fetchall()
            db.close()
            return jsonify({'orders': [dict(r) for r in rows]})
        except Exception as e:
            return jsonify({'error': str(e)}), 500

@app.route('/api/conditional-orders/<int:order_id>', methods=['PATCH'])
@require_api_key
def api_update_conditional(order_id):
    api_key = get_api_key()
    body = request.get_json() or {}
    limit_price = body.get('limit_price')
    trigger_price = body.get('trigger_price')

    if not limit_price or float(limit_price) <= 0:
        return jsonify({'error': 'limit_price required and must be > 0'}), 400

    try:
        db = get_db()
        row = db.execute(
            "SELECT * FROM conditional_orders WHERE id=? AND api_key=?",
            (order_id, api_key)
        ).fetchone()
        if not row:
            db.close()
            return jsonify({'error': 'Order not found'}), 404
        if row['status'] != 'WAITING':
            db.close()
            return jsonify({'error': f'Cannot modify order with status {row["status"]}'}), 400
        if row['order_type'] == 'STOP_LIMIT' and (not trigger_price or float(trigger_price) <= 0):
            db.close()
            return jsonify({'error': 'trigger_price required for STOP_LIMIT'}), 400

        db.execute(
            "UPDATE conditional_orders SET limit_price=?, trigger_price=? WHERE id=?",
            (float(limit_price),
             float(trigger_price) if trigger_price else row['trigger_price'],
             order_id)
        )
        db.commit()
        db.close()
        return jsonify({'ok': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/conditional-orders/<int:order_id>/cancel', methods=['POST'])
@require_api_key
def api_cancel_conditional(order_id):
    api_key = get_api_key()
    try:
        db = get_db()
        row = db.execute(
            "SELECT * FROM conditional_orders WHERE id=? AND api_key=?",
            (order_id, api_key)
        ).fetchone()
        if not row:
            db.close()
            return jsonify({'error': 'Order not found'}), 404
        if row['status'] != 'WAITING':
            db.close()
            return jsonify({'error': f'Cannot cancel order with status {row["status"]}'}), 400
        db.execute(
            "UPDATE conditional_orders SET status='CANCELLED', cancel_reason='User cancelled' WHERE id=?",
            (order_id,)
        )
        db.commit()
        db.close()
        return jsonify({'ok': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/history')
@require_api_key
def api_history():
    try:
        db = get_db()
        rows = db.execute(
            'SELECT * FROM trade_log ORDER BY timestamp DESC LIMIT 100'
        ).fetchall()
        db.close()
        return jsonify({'trades': [dict(r) for r in rows]})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/equity-history')
@require_api_key
def api_equity_history():
    try:
        db = get_db()
        rows = db.execute(
            'SELECT timestamp, total_equity FROM equity_log WHERE total_equity > 0 ORDER BY id ASC'
        ).fetchall()
        db.close()
        # Downsample to at most 300 points, evenly spaced
        pts = [r['total_equity'] for r in rows]
        if len(pts) > 300:
            step = len(pts) / 300
            pts = [pts[int(i * step)] for i in range(300)]
        return jsonify({'history': pts})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/connect', methods=['POST'])
def api_connect():
    body = request.get_json() or {}
    api_key = body.get('apiKey') or body.get('api_key')
    if not api_key:
        return jsonify({'ok': False, 'error': 'Missing API key'}), 400
    client = AgoraClient(api_key)
    try:
        portfolio = client.get_portfolio()
        session['api_key'] = api_key
        session.permanent = True
        app.permanent_session_lifetime = SESSION_LIFETIME
        return jsonify({
            'ok': True,
            'game_code': portfolio.get('gameCode'),
            'cash_balance': portfolio.get('cashBalance'),
            'total_return': portfolio.get('totalReturn'),
            'game_status': 'active',
        })
    except req_lib.exceptions.HTTPError as e:
        if e.response is not None and e.response.status_code == 401:
            return jsonify({'ok': False, 'error': 'Invalid API key'}), 401
        return jsonify({'ok': False, 'error': f'API error: {e}'}), 502
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)}), 502

@app.route('/api/price-history/<asset_code>')
@require_api_key
def api_price_history(asset_code):
    try:
        db = get_db()
        rows = db.execute(
            'SELECT timestamp, price FROM price_history WHERE asset_code=? ORDER BY id ASC LIMIT 500',
            (asset_code.upper(),)
        ).fetchall()
        db.close()
        return jsonify({'asset_code': asset_code.upper(), 'history': [{'ts': r['timestamp'], 'price': r['price']} for r in rows]})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/bad-data-log')
@require_api_key
def api_bad_data_log():
    try:
        db = get_db()
        rows = db.execute(
            'SELECT * FROM bad_data_log ORDER BY id DESC LIMIT 100'
        ).fetchall()
        db.close()
        return jsonify({'entries': [dict(r) for r in rows]})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/agent-log')
@require_api_key
def api_agent_log():
    """Parse ~/agent.log and return recent agent activity events (newest first)."""
    import re
    log_path = os.path.expanduser('~/agent.log')
    LOG_RE = re.compile(
        r'^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}),\d+ - ([\w\.]+) - (INFO|WARNING|ERROR) - (.+)$'
    )
    try:
        with open(log_path, 'r') as f:
            lines = f.readlines()
    except FileNotFoundError:
        return jsonify({'events': [], 'error': 'agent.log not found'})

    events = []
    broker_warn_bucket = None  # group consecutive timeout bursts by minute

    for line in lines[-2000:]:
        m = LOG_RE.match(line.strip())
        if not m:
            continue
        ts, module, level, msg = m.group(1), m.group(2), m.group(3), m.group(4)

        if 'Starting decision cycle at' in msg:
            etype = 'cycle_start'
        elif 'Plans Created:' in msg or ('Signals:' in msg and 'total' in msg):
            etype = 'cycle_summary'
        elif msg.startswith('\u2705'):
            etype = 'order_ok'
        elif msg.startswith('\u274c'):
            etype = 'order_fail'
        elif level == 'ERROR':
            etype = 'error'
        elif 'Low composite dropped:' in msg or 'Stale signal dropped:' in msg:
            etype = 'dropped'
        elif msg.startswith('Select') and '[selected]' in msg:
            etype = 'selected'
        elif level == 'WARNING' and module == 'kr_broker':
            minute = ts[:16]
            if broker_warn_bucket and broker_warn_bucket['minute'] == minute:
                broker_warn_bucket['count'] += 1
                continue
            else:
                if broker_warn_bucket:
                    e = broker_warn_bucket['event']
                    c = broker_warn_bucket['count']
                    if c > 1:
                        e['msg'] = f"[x{c}] {e['msg']}"
                    events.append(e)
                broker_warn_bucket = {
                    'minute': minute,
                    'count': 1,
                    'event': {'ts': ts, 'type': 'broker_warn', 'msg': msg},
                }
            continue
        else:
            continue

        if broker_warn_bucket:
            e = broker_warn_bucket['event']
            c = broker_warn_bucket['count']
            if c > 1:
                e['msg'] = f"[x{c}] {e['msg']}"
            events.append(e)
            broker_warn_bucket = None

        events.append({'ts': ts, 'type': etype, 'msg': msg})

    if broker_warn_bucket:
        e = broker_warn_bucket['event']
        c = broker_warn_bucket['count']
        if c > 1:
            e['msg'] = f"[x{c}] {e['msg']}"
        events.append(e)

    events.reverse()
    return jsonify({'events': events[:300]})

@app.route('/api/health')
def api_health():
    return jsonify({'status': 'ok', 'time': datetime.utcnow().isoformat()})

# ─── Cleanup / Compaction ───
def compact_old_data():
    """
    Compact previous days' high-frequency rows to one row per hour.
    Today's data is kept at full resolution.
    Also hard-deletes anything older than 30 days.
    """
    today = datetime.utcnow().date().isoformat()
    cutoff = (datetime.utcnow() - timedelta(days=30)).isoformat()
    db = get_db()
    try:
        # equity_log — keep MIN(id) per (date, hour) for days before today
        db.execute('''
            DELETE FROM equity_log
            WHERE date(timestamp) < ?
              AND id NOT IN (
                  SELECT MIN(id) FROM equity_log
                  WHERE date(timestamp) < ?
                  GROUP BY date(timestamp), strftime('%H', timestamp)
              )
        ''', (today, today))

        # price_history — keep MIN(id) per (asset, date, hour) for days before today
        db.execute('''
            DELETE FROM price_history
            WHERE date(timestamp) < ?
              AND id NOT IN (
                  SELECT MIN(id) FROM price_history
                  WHERE date(timestamp) < ?
                  GROUP BY asset_code, date(timestamp), strftime('%H', timestamp)
              )
        ''', (today, today))

        # Hard-delete anything beyond 30 days
        db.execute('DELETE FROM equity_log    WHERE timestamp < ?', (cutoff,))
        db.execute('DELETE FROM price_history WHERE timestamp < ?', (cutoff,))
        db.execute('DELETE FROM trade_log     WHERE timestamp < ?', (cutoff,))
        db.execute('DELETE FROM bad_data_log  WHERE timestamp < ?', (cutoff,))

        db.commit()
    except Exception:
        pass
    finally:
        db.close()

def compact_api_log():
    """Truncate api_log.jsonl to only today's entries."""
    log_path = os.path.join(os.path.dirname(DB_PATH), 'api_log.jsonl')
    if not os.path.exists(log_path):
        return
    today = datetime.utcnow().date().isoformat()
    kept = []
    try:
        with open(log_path) as f:
            for line in f:
                try:
                    if json.loads(line).get('ts', '').startswith(today):
                        kept.append(line)
                except Exception:
                    pass
        with open(log_path, 'w') as f:
            f.writelines(kept)
    except Exception:
        pass

if __name__ == '__main__':
    init_db()
    compact_old_data()
    compact_api_log()
    monitor = threading.Thread(target=_monitor_loop, daemon=True)
    monitor.start()
    app.run(host='0.0.0.0', port=8084, debug=False)
