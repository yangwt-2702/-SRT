# tests/test_server.py
from pathlib import Path
from unittest.mock import patch
from webtool.server import app, translate_cues
from webtool.srt_utils import Cue, parse_srt
from webtool.translator import ParsedLine, TranslationParseError

FIXTURE = Path(__file__).parent / "fixtures" / "sample_zh.srt"


def fake_glossary():
    return [{"chinese": "志工", "english": "volunteer", "locked": 1}]


@patch("webtool.server.call_claude")
def test_translate_cues_happy_path_all_batches_succeed(mock_call):
    cues = parse_srt(FIXTURE.read_text(encoding="utf-8"))
    # one batch (12 cues < batch size), claude echoes back English text per index
    mock_call.return_value = "\n".join(f"{c.index}|||English {c.index}" for c in cues)

    translated, warnings, pending = translate_cues(cues, fake_glossary(), batch_size=50,
                                                     max_retries=3, video_title="test")
    assert [c.text for c in translated] == [f"English {i}" for i in range(1, 13)]
    assert warnings == []
    assert pending == []


@patch("webtool.server.call_claude")
def test_translate_cues_retries_then_succeeds(mock_call):
    cues = parse_srt(FIXTURE.read_text(encoding="utf-8"))
    good = "\n".join(f"{c.index}|||English {c.index}" for c in cues)
    bad = "1|||only one line"
    mock_call.side_effect = [bad, good]

    translated, warnings, pending = translate_cues(cues, fake_glossary(), batch_size=50,
                                                     max_retries=3, video_title="test")
    assert [c.text for c in translated] == [f"English {i}" for i in range(1, 13)]
    assert mock_call.call_count == 2


@patch("webtool.server.call_claude")
def test_translate_cues_marks_batch_failed_after_max_retries(mock_call):
    cues = parse_srt(FIXTURE.read_text(encoding="utf-8"))
    mock_call.return_value = "garbled non-conforming output"

    translated, warnings, pending = translate_cues(cues, fake_glossary(), batch_size=50,
                                                     max_retries=2, video_title="test")
    assert all(c.text == "[翻譯失敗-請人工確認]" for c in translated)
    assert len(warnings) == 1
    assert mock_call.call_count == 2


def test_get_index_renders_page():
    client = app.test_client()
    resp = client.get("/")
    assert resp.status_code == 200


def test_post_translate_rejects_non_srt_file():
    client = app.test_client()
    resp = client.post("/translate", data={"file": (b"not an srt", "notes.txt")},
                        content_type="multipart/form-data")
    assert resp.status_code == 400


@patch("webtool.server.DrustClient.fetch_glossary")
@patch("webtool.server.call_claude")
def test_post_translate_rejects_srt_missing_blank_line_between_cues(mock_call, mock_fetch):
    mock_call.side_effect = AssertionError("call_claude should not be invoked")
    mock_fetch.side_effect = AssertionError("fetch_glossary should not be invoked")

    # Missing blank line between cue 1 and cue 2 causes parse_srt to swallow
    # cue 2 into cue 1's text (see webtool/srt_utils.py _CUE_RE).
    malformed = (
        "1\n00:00:00,000 --> 00:00:01,000\nHello\n"
        "2\n00:00:01,000 --> 00:00:02,000\nWorld\n"
    )
    client = app.test_client()
    resp = client.post(
        "/translate",
        data={"file": (malformed.encode("utf-8"), "sample.srt")},
        content_type="multipart/form-data",
    )
    assert resp.status_code == 400
    body = resp.get_json()
    assert "error" in body
    mock_call.assert_not_called()
    mock_fetch.assert_not_called()


@patch("webtool.server.DrustClient.insert_pending_term")
@patch("webtool.server.DrustClient.fetch_glossary")
@patch("webtool.server.call_claude")
def test_post_translate_skips_pending_insert_for_already_known_glossary_term(
    mock_call, mock_fetch, mock_insert,
):
    cues = parse_srt(FIXTURE.read_text(encoding="utf-8"))
    mock_fetch.return_value = [
        {"chinese": "守護生命", "english": "Protect Life", "locked": 1},
    ]

    lines = []
    for c in cues:
        if c.index == 1:
            lines.append(f"{c.index}|||[[UNSURE:守護生命|Protect Life]] talk")
        elif c.index == 2:
            lines.append(f"{c.index}|||[[UNSURE:新詞彙|New term]] test")
        else:
            lines.append(f"{c.index}|||English {c.index}")
    mock_call.return_value = "\n".join(lines)
    mock_insert.return_value = {"id": 1}

    client = app.test_client()
    with FIXTURE.open("rb") as f:
        resp = client.post(
            "/translate",
            data={"file": (f, "sample_zh.srt")},
            content_type="multipart/form-data",
        )

    assert resp.status_code == 200
    body = resp.get_json()
    pending_terms = [p["term"] for p in body["pending_terms"]]
    assert "新詞彙" in pending_terms
    assert "守護生命" not in pending_terms

    inserted_terms = [call.kwargs.get("term") for call in mock_insert.call_args_list]
    assert "新詞彙" in inserted_terms
    assert "守護生命" not in inserted_terms
