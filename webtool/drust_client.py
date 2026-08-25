import time

import requests

# Observed live: Python's `requests` occasionally hits a transient
# connection failure against the Drust host even when curl succeeds
# immediately after (same machine, same network). A single blip shouldn't
# fail a 30-50 minute translation request outright.
_MAX_ATTEMPTS = 3
_RETRY_BACKOFF_SECONDS = 1


class DrustClient:
    def __init__(self, base_url: str, tenant_id: str, anon_token: str, service_token: str):
        self.base_url = base_url.rstrip("/")
        self.tenant_id = tenant_id
        self.anon_token = anon_token
        self.service_token = service_token

    def _tenant_path(self, path: str) -> str:
        return f"{self.base_url}/t/{self.tenant_id}/{path}"

    def _post_with_retry(self, url: str, json_body: dict, headers: dict) -> requests.Response:
        last_error = None
        for attempt in range(_MAX_ATTEMPTS):
            try:
                return requests.post(url, json=json_body, headers=headers, timeout=30)
            except (requests.exceptions.ConnectionError, requests.exceptions.Timeout) as e:
                last_error = e
                if attempt < _MAX_ATTEMPTS - 1:
                    time.sleep(_RETRY_BACKOFF_SECONDS)
        raise last_error

    def fetch_glossary(self) -> list[dict]:
        rows = []
        page = 1
        per_page = 200
        total = None
        while True:
            resp = self._post_with_retry(
                self._tenant_path("collections/translation_glossary/list"),
                {"page": page, "per_page": per_page},
                {"Authorization": f"Bearer {self.anon_token}"},
            )
            resp.raise_for_status()
            data = resp.json()
            batch = data.get("records", [])
            if not batch:
                break
            rows.extend(batch)
            if total is None:
                total = data.get("total")
            if total is not None and len(rows) >= total:
                break
            page += 1
        return rows

    def insert_pending_term(self, term: str, stage: str, context: str,
                             suggested_fix: str, video_title: str) -> dict:
        resp = self._post_with_retry(
            self._tenant_path("records/pending_terms"),
            {
                "data": {
                    "term": term,
                    "stage": stage,
                    "context": context,
                    "suggested_fix": suggested_fix,
                    "video_title": video_title,
                },
            },
            {"Authorization": f"Bearer {self.service_token}"},
        )
        resp.raise_for_status()
        data = resp.json()
        # Live tenant wraps the created row under "record"; fall back to the
        # top-level payload for tenants/mocks that return the row directly.
        return data.get("record", data)
