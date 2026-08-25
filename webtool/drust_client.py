import requests


class DrustClient:
    def __init__(self, base_url: str, tenant_id: str, anon_token: str, service_token: str):
        self.base_url = base_url.rstrip("/")
        self.tenant_id = tenant_id
        self.anon_token = anon_token
        self.service_token = service_token

    def _tenant_path(self, path: str) -> str:
        return f"{self.base_url}/t/{self.tenant_id}/{path}"

    def fetch_glossary(self) -> list[dict]:
        rows = []
        page = 1
        per_page = 200
        total = None
        while True:
            resp = requests.post(
                self._tenant_path("collections/translation_glossary/list"),
                json={"page": page, "per_page": per_page},
                headers={"Authorization": f"Bearer {self.anon_token}"},
                timeout=30,
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
        resp = requests.post(
            self._tenant_path("records/pending_terms"),
            json={
                "data": {
                    "term": term,
                    "stage": stage,
                    "context": context,
                    "suggested_fix": suggested_fix,
                    "video_title": video_title,
                },
            },
            headers={"Authorization": f"Bearer {self.service_token}"},
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()
        # Live tenant wraps the created row under "record"; fall back to the
        # top-level payload for tenants/mocks that return the row directly.
        return data.get("record", data)
