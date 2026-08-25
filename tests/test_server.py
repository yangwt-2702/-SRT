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
