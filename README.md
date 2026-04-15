# KR Broker

## What
Trading dashboard connecting to Kaigora Agora Agent API (localhost:3002).
User can buy, sell, manage portfolio, set limit/stop-limit orders.

## Structure
```
kr-broker/
├── run_server.py          ← start: python run_server.py
├── app.py                 ← Flask backend (:8085)
├── agora_client.py        ← Agora API wrapper
├── templates/
│   └── dashboard.html     ← main UI
├── static/
│   ├── css/dashboard.css
│   └── js/dashboard.js
└── data/
    └── kr_broker.db       ← trade history
```

## API Endpoints (Agora at localhost:3002)
- GET  /api/v1/my-portfolio
- GET  /api/v1/available-assets
- GET  /api/v1/my-participant-info
- POST /api/v1/orders
- POST /api/v1/orders/{id}/cancel

## Order Types
- MARKET
- LIMIT (price capped)
- STOP_LIMIT (trigger_price + limit_price)

## Port: 8085

## API Endpoints (broker, port 8084)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/portfolio` | Portfolio snapshot |
| GET | `/api/assets` | All tradable assets + prices |
| GET/POST | `/api/orders` | Pending orders / place market order |
| GET/POST | `/api/conditional-orders` | Limit/stop-limit orders |
| GET | `/api/agent-log` | KR-Agent activity feed (parsed from `~/agent.log`) |
| GET | `/api/price-history/<code>` | Price history for an asset |
| GET | `/api/equity-history` | Portfolio equity over time |
| GET | `/api/health` | Status check |

## Dashboard Tabs
- **Positions** — live holdings with price charts, avg cost line, conditional order lines
- **Pending Orders** — active exchange orders
- **Available Assets** — searchable asset list with buy/sell
- **Conditional Orders** — LIMIT/STOP_LIMIT orders with inline editing
- **Agent** — KR-Agent activity feed (cycles, orders, errors, dropped signals); refreshes every 30s

### Agent Tab
Parses `~/agent.log` server-side and returns structured events:
- `cycle_start` / `cycle_summary` — decision cycle markers
- `order_ok` / `order_fail` — order outcomes
- `error` — execution errors (e.g. price unavailable)
- `dropped` — signals filtered by composite or staleness
- `selected` — signals chosen for execution
- `broker_warn` — KR-broker timeout/error warnings (grouped by minute)

The **header badge** shows last cycle time (UTC + Toronto ET) and a ⚠N error count. Clicking it jumps to the Agent tab.

## Build Order Completed
1. ✅ agora_client.py       — full Agora API wrapper (portfolio, assets, orders, cancel, auth)
2. ✅ app.py                — Flask backend, 11 routes, SQLite trade history + asset cache
3. ✅ templates/dashboard.html — dark professional UI, API key modal, order form modal, assets browser
4. ✅ static/css/dashboard.css — dark theme, green/red P&L colors, responsive grid
5. ✅ static/js/dashboard.js    — all JS: API key, portfolio, positions, orders, history, polling
6. ✅ run_server.py         — startup script with port + API checks
7. ✅ Done ✅
