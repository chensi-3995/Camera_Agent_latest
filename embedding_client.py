from __future__ import annotations

from typing import Any

import requests


class EmbeddingClient:
    def __init__(
        self,
        base_url: str,
        endpoint: str = "/embed",
        timeout_seconds: int = 60,
        enabled: bool = True,
    ) -> None:
        self.enabled = enabled
        self.base_url = base_url.rstrip("/")
        self.endpoint = endpoint if endpoint.startswith("/") else f"/{endpoint}"
        self.timeout_seconds = timeout_seconds
        self.embed_url = self.base_url + self.endpoint

    def test_connection(self) -> bool:
        if not self.enabled:
            return False
        health_url = self.base_url + "/health"
        try:
            response = requests.get(health_url, timeout=5)
            return response.ok
        except requests.RequestException:
            return False

    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        if not self.enabled:
            raise RuntimeError("Embedding client is disabled.")

        normalized = [str(text).strip() for text in texts if str(text).strip()]
        if not normalized:
            return []

        try:
            response = requests.post(
                self.embed_url,
                json={"inputs": normalized},
                timeout=self.timeout_seconds,
            )
            response.raise_for_status()
        except requests.RequestException as exc:
            raise RuntimeError(f"Embedding service request failed: {exc}") from exc

        try:
            payload: Any = response.json()
        except ValueError as exc:
            raise RuntimeError("Embedding service returned invalid JSON.") from exc

        if not isinstance(payload, list):
            raise RuntimeError("Embedding service returned an unexpected payload.")
        return payload

    def embed_text(self, text: str) -> list[float]:
        embeddings = self.embed_texts([text])
        return embeddings[0] if embeddings else []
