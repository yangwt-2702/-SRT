# tests/test_translator.py
import re

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


def test_build_batch_prompt_flattens_multiline_cue_text():
    batch = [Cue(1, "00:00:00,000", "00:00:01,000", "上人開示\n慈悲喜捨")]
    prompt = build_batch_prompt(batch, GLOSSARY, context_tail=[])

    # The cue-list section is everything after the "序號|||英文譯文" instruction line.
    marker = "請翻譯以下字幕，輸出格式為每行「序號|||英文譯文」，不要加任何其他文字或說明："
    cue_section = prompt.split(marker, 1)[1]
    assert "慈悲喜捨" in cue_section  # the second text line is preserved, just flattened
    for line in cue_section.splitlines():
        line = line.strip()
        if not line:
            continue
        assert re.match(r"^\d+\|\|\|", line), f"bare unprefixed line leaked: {line!r}"


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


def test_parse_claude_response_raises_on_malformed_unsure_marker_missing_pipe():
    raw = "1|||[[UNSURE:某道場]] held an event"
    try:
        parse_claude_response(raw, expected_indices=[1])
        assert False, "expected TranslationParseError"
    except TranslationParseError:
        pass


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


import responses
import requests

from webtool.translator import call_llm, LlmApiError

BASE_URL = "https://sberecognition.tzuchi-org.tw/functions/v1/llm-proxy/v1"


@responses.activate
def test_call_llm_returns_message_content_on_success():
    responses.add(
        responses.POST,
        f"{BASE_URL}/chat/completions",
        json={"choices": [{"message": {"content": "1|||hello world"}}]},
        status=200,
    )

    result = call_llm("prompt text", BASE_URL, api_key="sk-test", model="gpt-oss-120b", timeout=60)

    assert result == "1|||hello world"
    sent = responses.calls[0].request
    assert sent.headers["Authorization"] == "Bearer sk-test"
    import json
    body = json.loads(sent.body)
    assert body["model"] == "gpt-oss-120b"
    assert body["messages"] == [{"role": "user", "content": "prompt text"}]


def test_call_llm_raises_immediately_when_api_key_missing():
    try:
        call_llm("prompt text", BASE_URL, api_key="", model="gpt-oss-120b", timeout=60)
        assert False, "expected LlmApiError"
    except LlmApiError as e:
        assert "LLM_PROXY_API_KEY" in str(e)


@responses.activate
def test_call_llm_raises_on_authentication_error():
    responses.add(
        responses.POST, f"{BASE_URL}/chat/completions",
        json={"error": "invalid key"}, status=401,
    )
    try:
        call_llm("prompt text", BASE_URL, api_key="sk-bad", model="gpt-oss-120b", timeout=60)
        assert False, "expected LlmApiError"
    except LlmApiError as e:
        assert "金鑰無效" in str(e)


@responses.activate
def test_call_llm_raises_on_rate_limit_error():
    responses.add(
        responses.POST, f"{BASE_URL}/chat/completions",
        json={"error": "rate limited"}, status=429,
    )
    try:
        call_llm("prompt text", BASE_URL, api_key="sk-test", model="gpt-oss-120b", timeout=60)
        assert False, "expected LlmApiError"
    except LlmApiError as e:
        assert "速率限制" in str(e)


@responses.activate
def test_call_llm_raises_on_connection_error():
    responses.add(
        responses.POST, f"{BASE_URL}/chat/completions",
        body=requests.exceptions.ConnectionError("boom"),
    )
    try:
        call_llm("prompt text", BASE_URL, api_key="sk-test", model="gpt-oss-120b", timeout=60)
        assert False, "expected LlmApiError"
    except LlmApiError as e:
        assert "無法連線" in str(e)
