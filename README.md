# CandleChart

Real-time candlestick chart app powered by Interactive Brokers (IBKR) and LightweightCharts. Supports multiple simultaneous chart widgets, bar caching via DynamoDB.

---

## Prerequisites

- **Node.js** v18+ — https://nodejs.org
- **Docker** — https://docs.docker.com/get-docker/
- **IBKR Gateway or TWS** — https://www.interactivebrokers.com/en/trading/ibgateway.php
  - Paper trading account (free, for testing)
  - Or live account

---

## Install

```bash
git clone <repo-url>
cd candlechart
npm install
```

---

## Environment

Copy the example and adjust if needed:

```bash
cp .env.example .env
```

`.env` defaults:
```
GATEWAY_HOST=127.0.0.1
GATEWAY_PORT_PAPER=4002
GATEWAY_PORT_LIVE=4001
PORT=3000
DYNAMODB_ENDPOINT=http://localhost:8000
```

Only change these if your IBKR Gateway runs on a different host/port.

---

## Running

### 1. Start DynamoDB (bar cache)

```bash
npm run db
```

First run pulls the Docker image and creates a container named `candlechart-db`. Subsequent runs restart the existing container. App works without it but won't cache bars.

### 2. Start IBKR Gateway

- Download and launch **IB Gateway** (lighter) or **TWS**
- Log in with your IBKR credentials
- In settings, enable **API access**:
  - `Edit → Global Configuration → API → Settings`
  - Check **Enable ActiveX and Socket Clients**
  - Paper port: `4002`, Live port: `4001`
  - Uncheck **Read-Only API** if you plan to trade

### 3. Start the app

```bash
npm run dev     # development (auto-restarts on file change)
# or
npm start       # production
```

Open **http://localhost:3000**

---

## Usage

1. Click **Connect** → select Paper or Live → connects to IBKR Gateway
2. Type a company name or ticker in the search bar (e.g. `Apple` or `AAPL`)
3. Select a result from the dropdown → widget created immediately
4. Change timeframe per widget using the dropdown in the widget header
5. Click **⤢** to expand a widget fullscreen, again to collapse
6. Click **×** to remove a widget

---

## Architecture

```
client/
  index.html    — UI shell
  main.js       — WebSocket client, widget lifecycle, chart rendering
  style.css     — Dark theme, CSS Grid widget layout

server/
  index.js      — Express + WebSocket server, cache-first subscribe flow
  ibkr.js       — IBKR API wrapper (multi-subscription, real-time bars)
  db.js         — DynamoDB client, bar read/write
```

**Data flow:**
1. Client subscribes to symbol+timeframe
2. Server sends cached bars from DynamoDB immediately
3. Server requests fresh bars from IBKR
4. New bars written to DynamoDB + sent to client
5. Real-time bar updates streamed as they arrive

---

## Data retention

| Timeframe | Max IBKR history |
|-----------|-----------------|
| 1 min     | 1 month         |
| 5 mins    | 6 months        |
| 15/30 min | 1 year          |
| 1 hour    | 1 year          |
| 1 day     | 20 years        |

Currently fetches **5 days** per request (configurable in `server/ibkr.js` — the `'5 D'` duration string).

---

## Troubleshooting

**"Connection timeout" on connect**
→ IBKR Gateway is not running, or API access not enabled in Gateway settings.

**"DynamoDB not running — bar caching disabled"**
→ Run `npm run db` to start the Docker container.

**No data / empty chart**
→ Market may be closed. Try a daily (`1D`) timeframe which shows historical data regardless of market hours.

**Port conflict**
→ Change `PORT` or `GATEWAY_PORT_*` in `.env`.
