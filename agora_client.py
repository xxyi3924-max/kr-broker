"""
agora_client.py — KR Broker
Agora Agent API wrapper for Kaigora trading game.
"""

import requests
import json
from typing import Optional

BASE_URL = "https://kaigora.com/api/v1"


class AgoraClient:
    def __init__(self, api_key: str):
        self.api_key = api_key
        self.headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json"
        }

    # ── Portfolio ──────────────────────────────────────────────

    def get_portfolio(self) -> dict:
        """Full portfolio snapshot: cash, holdings, live prices, P&L, order window."""
        resp = requests.get(f"{BASE_URL}/my-portfolio", headers=self.headers, timeout=10)
        resp.raise_for_status()
        return resp.json()

    def get_participant_info(self) -> dict:
        """Participant info: cash, pending orders, limits."""
        resp = requests.get(f"{BASE_URL}/my-participant-info", headers=self.headers, timeout=10)
        resp.raise_for_status()
        return resp.json()

    # ── Assets ──────────────────────────────────────────────────

    def get_available_assets(self) -> dict:
        """List all tradable assets."""
        resp = requests.get(f"{BASE_URL}/available-assets", headers=self.headers, timeout=10)
        resp.raise_for_status()
        return resp.json()

    # ── Orders ──────────────────────────────────────────────────

    def get_pending_orders(self) -> list:
        """Return only pending (open) orders."""
        info = self.get_participant_info()
        return info.get("pending_orders", [])

    def place_order(
        self,
        asset_id: str,
        order_type: str,
        side: str,          # "BUY" or "SELL"
        quantity: Optional[float] = None,
        amount: Optional[float] = None,
        limit_price: Optional[float] = None,
        trigger_price: Optional[float] = None,
        stop_price: Optional[float] = None,
    ) -> dict:
        """
        Place an order.

        order_type: "MARKET" | "LIMIT" | "STOP_LIMIT"
        For LIMIT: provide limit_price
        For STOP_LIMIT: provide trigger_price (stop_price) AND limit_price
        Either quantity OR amount must be provided.
        """
        payload = {
            "asset_id": asset_id,
            "order_type": order_type,
            "side": side.upper(),
        }

        if quantity is not None:
            payload["quantity"] = quantity
        if amount is not None:
            payload["amount"] = amount
        if limit_price is not None:
            payload["limit_price"] = limit_price
        if stop_price is not None:
            payload["stop_price"] = stop_price
        if trigger_price is not None:
            payload["trigger_price"] = trigger_price

        resp = requests.post(f"{BASE_URL}/orders", headers=self.headers, json=payload, timeout=10)
        resp.raise_for_status()
        return resp.json()

    def cancel_order(self, order_id: str) -> dict:
        """Cancel a pending order."""
        resp = requests.post(
            f"{BASE_URL}/orders/{order_id}/cancel",
            headers=self.headers,
            timeout=10
        )
        resp.raise_for_status()
        return resp.json()

    # ── Utility ─────────────────────────────────────────────────

    def is_trading_open(self) -> bool:
        """Check if the order window is currently open."""
        try:
            info = self.get_participant_info()
            state = info.get("order_window_state", "CLOSED")
            return state.upper() == "OPEN"
        except Exception:
            return False

    def test_connection(self) -> bool:
        """Ping the API to verify auth works."""
        try:
            self.get_participant_info()
            return True
        except Exception:
            return False
