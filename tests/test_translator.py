# tests/test_translator.py
from webtool.srt_utils import Cue
from webtool.translator import (
    build_batch_prompt, build_retry_prompt, parse_claude_response,
    ParsedLine, TranslationParseError,
)

GLOSSARY = [{"chinese": "上人", "english": "Dharma Master", "locked": 1}]


def test_build_batch_prompt_includes_rules_glossary_and_cues():
    batch = [Cue(1, "00:00:00,000", "00:00:01,000", "上人開示")]
    prompt = build_batch_prompt(batch, GLOSSARY, context_tail=[])
    assert "1:1" in prompt or "逐行" in prompt
    assert "上人" in prompt and "Dharma Master" in prompt
    assert "1|||上人開示" in prompt or "1 | 上人開示" in prompt or "上人開示" in prompt


def test_build_retry_prompt_appends_error_detail():
    prompt = build_retry_prompt("original prompt text", "missing index 3")
    assert "original prompt text" in prompt
    assert "missing index 3" in prompt


def test_parse_claude_response_happy_path():
    raw = "1|||Dharma Master gave a talk\n2|||on compassion"
    parsed = parse_claude_response(raw, expected_indices=[1, 2])
    assert parsed == [
        ParsedLine(index=1, text="Dharma Master gave a talk", unsure=[]),
        ParsedLine(index=2, text="on compassion", unsure=[]),
    ]


def test_parse_claude_response_extracts_unsure_markers():
    raw = "1|||[[UNSURE:某道場|Some Place]] held an event"
    parsed = parse_claude_response(raw, expected_indices=[1])
    assert parsed[0].text == "Some Place held an event"
    assert parsed[0].unsure == [("某道場", "Some Place")]


def test_parse_claude_response_raises_on_index_mismatch():
    raw = "1|||text one\n3|||text three"
    try:
        parse_claude_response(raw, expected_indices=[1, 2])
        assert False, "expected TranslationParseError"
    except TranslationParseError:
        pass


def test_parse_claude_response_raises_on_malformed_line():
    raw = "1: text without delimiter"
    try:
        parse_claude_response(raw, expected_indices=[1])
        assert False, "expected TranslationParseError"
    except TranslationParseError:
        pass
