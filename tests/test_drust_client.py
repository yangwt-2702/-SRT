import responses
from webtool.drust_client import DrustClient

BASE = "https://tcdrust.tzuchi-org.tw"
TID = "9eec6c81-f435-4811-b86d-a4829edbecea"


@responses.activate
def test_fetch_glossary_paginates_until_empty_page():
    responses.add(
        responses.POST,
        f"{BASE}/t/{TID}/collections/translation_glossary/list",
        json={"records": [{"chinese": "上人", "english": "Dharma Master", "locked": 1}] * 200,
              "total": 250, "page": 1, "perPage": 200},
        status=200,
    )
    responses.add(
        responses.POST,
        f"{BASE}/t/{TID}/collections/translation_glossary/list",
        json={"records": [{"chinese": "靜思", "english": "Jing Si", "locked": 1}] * 50,
              "total": 250, "page": 2, "perPage": 200},
        status=200,
    )
    responses.add(
        responses.POST,
        f"{BASE}/t/{TID}/collections/translation_glossary/list",
        json={"records": [], "total": 250, "page": 3, "perPage": 200},
        status=200,
    )
    client = DrustClient(BASE, TID, "anon-tok", "service-tok")
    rows = client.fetch_glossary()
    assert len(rows) == 250
    assert rows[0]["chinese"] == "上人"
    # anon token used for reads
    assert responses.calls[0].request.headers["Authorization"] == "Bearer anon-tok"


@responses.activate
def test_insert_pending_term_uses_service_token_and_returns_row():
    responses.add(
        responses.POST,
        f"{BASE}/t/{TID}/records/pending_terms",
        json={"id": 99, "term": "某詞", "stage": "translation", "status": "pending",
              "context": "ctx", "suggested_fix": "fix", "video_title": "vid"},
        status=200,
    )
    client = DrustClient(BASE, TID, "anon-tok", "service-tok")
    row = client.insert_pending_term(term="某詞", stage="translation", context="ctx",
                                      suggested_fix="fix", video_title="vid")
    assert row["id"] == 99
    assert responses.calls[0].request.headers["Authorization"] == "Bearer service-tok"


@responses.activate
def test_insert_pending_term_wraps_body_and_unwraps_record_response():
    # Confirmed via live probe: the real API requires the insert body wrapped
    # in {"data": {...}} and returns {"id": N, "record": {...}} rather than a
    # flat row.
    import json as _json

    responses.add(
        responses.POST,
        f"{BASE}/t/{TID}/records/pending_terms",
        json={"id": 36, "record": {"id": 36, "term": "某詞", "stage": "translation",
                                    "status": "pending", "context": "ctx",
                                    "suggested_fix": "fix", "video_title": "vid"}},
        status=201,
    )
    client = DrustClient(BASE, TID, "anon-tok", "service-tok")
    row = client.insert_pending_term(term="某詞", stage="translation", context="ctx",
                                      suggested_fix="fix", video_title="vid")
    sent_body = _json.loads(responses.calls[0].request.body)
    assert sent_body["data"]["term"] == "某詞"
    assert row["id"] == 36
    assert row["term"] == "某詞"
