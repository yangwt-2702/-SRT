# SRT 中翻英網頁工具 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local Flask web app where a colleague uploads a Stage-2/3-clean Chinese `.srt`, gets back a Stage-4-rule-compliant English `.srt`, using the `translation_glossary` Drust collection for term consistency, with new/uncertain terms recorded into `pending_terms` for later human confirmation.

**Architecture:** Flask serves both the single-page frontend and a `/translate` API from one origin (so a later `cloudflared tunnel` needs no CORS work). The backend parses the uploaded SRT into cues, batches them (40–60 cues/batch), translates each batch via a subprocess call to the local `claude` CLI in headless print mode, validates cue-count/index integrity per batch with automatic retry, flags glossary-consistency mismatches, and writes newly-encountered uncertain terms to Drust's `pending_terms`.

**Tech Stack:** Python 3.12, Flask, `requests` (Drust REST calls), stdlib `subprocess` (invoking `claude -p`), pytest for tests. No frontend framework — plain HTML/CSS/JS.

**Spec:** `docs/superpowers/specs/2026-08-25-srt-translation-webtool-design.md`

## Global Constraints

- Drust REST host: `https://tcdrust.tzuchi-org.tw`, tenant id `9eec6c81-f435-4811-b86d-a4829edbecea`.
- Drust list endpoint is `POST /t/{tenant}/collections/{collection}/list` with body `{"page": N, "per_page": M}` — **never send a `filter`** (server-side FilterAst filtering is broken on this tenant per prior investigation: `FILTER_PARSE_ERROR` on any input). The response wraps rows under the key `records` (not `items`, despite the tenant's published OpenAPI doc — confirmed by a live probe on 2026-08-25), plus `total`, `page`, `perPage`.
- Drust insert endpoint is `POST /t/{tenant}/records/{collection}` with the collection's `*Insert` shape as the JSON body; response is the created row directly (no wrapper).
- Reading `translation_glossary` uses the **anon** bearer token (its `anon_caps` includes `select`). Writing to `pending_terms` uses the **service** bearer token (`anon_caps`/`user_caps` on both collections are `select`-only — only the service token can insert). The service token must never reach the browser or any file served to the client — keep it server-side in `config.py` only.
- Anon token: `drust_qikOlcix2GBK-PxsAU8rLC0rEbGhC0AaUMR2_tAma0w`. Service token: `drust_uQcGNoyEbu6CY5abgvB95fhYokLTaavGVskwaegZ6vw`.
- `claude` CLI binary is at `C:\Users\user\.local\bin\claude.exe`, supports `-p "<prompt>"` for non-interactive output.
- Batch size: 40–60 cues (use 50). Max retries per batch: 3.
- MVP scope is Stage 4 translation only — no Stage 1/2/3 automation, no glossary-editing UI, no auth.
- Line-for-line 1:1 rule: translated output must have the exact same cue count, indices, and timecodes as the input; only cue text changes.
- Glossary-consistency mismatches are surfaced as **warnings for human review**, never silently rewritten — mechanically rewriting an already-translated sentence to force in a missing term risks producing ungrammatical English, which is a worse failure than flagging it (see Task 5 for detail; this is a deliberate, safety-motivated deviation from the design doc's "directly overwrite" wording).

---

### Task 1: Project scaffolding

**Files:**
- Create: `webtool/config.py`
- Create: `webtool/__init__.py` (empty — makes `webtool` importable)
- Create: `requirements.txt`
- Create: `webtool/static/.gitkeep`
- Create: `webtool/templates/.gitkeep`

**Interfaces:**
- Produces (used by every later task): `webtool/config.py` module-level constants:
  - `DRUST_BASE = "https://tcdrust.tzuchi-org.tw"`
  - `DRUST_TENANT_ID = "9eec6c81-f435-4811-b86d-a4829edbecea"`
  - `DRUST_ANON_TOKEN = "drust_qikOlcix2GBK-PxsAU8rLC0rEbGhC0AaUMR2_tAma0w"`
  - `DRUST_SERVICE_TOKEN = "drust_uQcGNoyEbu6CY5abgvB95fhYokLTaavGVskwaegZ6vw"`
  - `CLAUDE_BIN = r"C:\Users\user\.local\bin\claude.exe"`
  - `BATCH_SIZE = 50`
  - `MAX_RETRIES = 3`
  - `CLAUDE_TIMEOUT_SECONDS = 180`
  - `PORT = 8787`

- [ ] **Step 1: Create the directory layout and config module**

```python
# webtool/config.py
DRUST_BASE = "https://tcdrust.tzuchi-org.tw"
DRUST_TENANT_ID = "9eec6c81-f435-4811-b86d-a4829edbecea"
DRUST_ANON_TOKEN = "drust_qikOlcix2GBK-PxsAU8rLC0rEbGhC0AaUMR2_tAma0w"
DRUST_SERVICE_TOKEN = "drust_uQcGNoyEbu6CY5abgvB95fhYokLTaavGVskwaegZ6vw"

CLAUDE_BIN = r"C:\Users\user\.local\bin\claude.exe"

BATCH_SIZE = 50
MAX_RETRIES = 3
CLAUDE_TIMEOUT_SECONDS = 180

PORT = 8787
```

- [ ] **Step 2: Create `webtool/__init__.py`** (empty file)

- [ ] **Step 3: Create `requirements.txt`**

```
flask==3.0.3
requests==2.32.3
pytest==8.3.2
```

- [ ] **Step 4: Install dependencies and verify import**

Run: `pip install -r requirements.txt && python -c "from webtool import config; print(config.PORT)"`
Expected: prints `8787` with no errors.

- [ ] **Step 5: Commit**

```bash
git init
git add webtool requirements.txt tests
git commit -m "chore: scaffold webtool project structure and config"
```

(If this directory is not yet a git repo, `git init` creates one — confirm with the user before running `git init` if they'd rather not version this folder.)

---

### Task 2: SRT parsing and serialization

**Files:**
- Create: `webtool/srt_utils.py`
- Test: `tests/test_srt_utils.py`

**Interfaces:**
- Produces:
  - `class Cue: index: int; start: str; end: str; text: str` (dataclass, `webtool/srt_utils.py`)
  - `def parse_srt(content: str) -> list[Cue]`
  - `def serialize_srt(cues: list[Cue]) -> str`

- [ ] **Step 1: Write the failing round-trip test**

```python
# tests/test_srt_utils.py
from pathlib import Path
from webtool.srt_utils import parse_srt, serialize_srt, Cue

FIXTURE = Path(__file__).parent / "fixtures" / "sample_zh.srt"

def test_parse_srt_returns_expected_cues():
    content = FIXTURE.read_text(encoding="utf-8")
    cues = parse_srt(content)
    assert len(cues) == 12
    assert cues[0] == Cue(index=1, start="00:00:00,000", end="00:00:01,433", text="我當時分享的")
    assert cues[-1].index == 12
    assert cues[-1].text == "雖然是由我們的常住師父來主持"

def test_serialize_srt_round_trip():
    content = FIXTURE.read_text(encoding="utf-8")
    cues = parse_srt(content)
    rebuilt = parse_srt(serialize_srt(cues))
    assert rebuilt == cues
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_srt_utils.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'webtool.srt_utils'`

- [ ] **Step 3: Implement `webtool/srt_utils.py`**

```python
# webtool/srt_utils.py
from dataclasses import dataclass
import re

_CUE_RE = re.compile(
    r"(\d+)\s*\n"
    r"(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})\s*\n"
    r"(.*?)(?=\n\s*\n\d+\s*\n|\Z)",
    re.DOTALL,
)


@dataclass
class Cue:
    index: int
    start: str
    end: str
    text: str


def parse_srt(content: str) -> list[Cue]:
    content = content.replace("\ufeff", "").replace("\r\n", "\n").strip() + "\n"
    cues = []
    for match in _CUE_RE.finditer(content):
        index, start, end, text = match.groups()
        cues.append(Cue(index=int(index), start=start, end=end, text=text.strip()))
    return cues


def serialize_srt(cues: list[Cue]) -> str:
    blocks = [
        f"{cue.index}\n{cue.start} --> {cue.end}\n{cue.text}\n"
        for cue in cues
    ]
    return "\n".join(blocks) + "\n"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_srt_utils.py -v`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add webtool/srt_utils.py tests/test_srt_utils.py tests/fixtures/sample_zh.srt
git commit -m "feat: add SRT parse/serialize round trip"
```

---

### Task 3: Batch splitting and cue-integrity validation

**Files:**
- Modify: `webtool/srt_utils.py`
- Test: `tests/test_srt_utils.py`

**Interfaces:**
- Consumes: `Cue` from Task 2.
- Produces:
  - `def split_batches(cues: list[Cue], batch_size: int) -> list[list[Cue]]`
  - `def validate_indices(source_batch: list[Cue], returned_indices: list[int]) -> bool` — `True` only if `returned_indices` is exactly `[c.index for c in source_batch]` in the same order.

- [ ] **Step 1: Write the failing tests**

```python
# append to tests/test_srt_utils.py
from webtool.srt_utils import split_batches, validate_indices

def test_split_batches_respects_batch_size():
    cues = [Cue(index=i, start="00:00:00,000", end="00:00:01,000", text=f"t{i}") for i in range(1, 13)]
    batches = split_batches(cues, batch_size=5)
    assert [len(b) for b in batches] == [5, 5, 2]
    assert batches[0][0].index == 1
    assert batches[-1][-1].index == 12

def test_validate_indices_true_for_exact_match():
    cues = [Cue(index=i, start="", end="", text="") for i in (1, 2, 3)]
    assert validate_indices(cues, [1, 2, 3]) is True

def test_validate_indices_false_for_missing_or_reordered():
    cues = [Cue(index=i, start="", end="", text="") for i in (1, 2, 3)]
    assert validate_indices(cues, [1, 3]) is False
    assert validate_indices(cues, [1, 3, 2]) is False
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/test_srt_utils.py -v`
Expected: FAIL — `ImportError: cannot import name 'split_batches'`

- [ ] **Step 3: Implement in `webtool/srt_utils.py`**

```python
# append to webtool/srt_utils.py

def split_batches(cues: list[Cue], batch_size: int) -> list[list[Cue]]:
    return [cues[i:i + batch_size] for i in range(0, len(cues), batch_size)]


def validate_indices(source_batch: list[Cue], returned_indices: list[int]) -> bool:
    return [c.index for c in source_batch] == list(returned_indices)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/test_srt_utils.py -v`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add webtool/srt_utils.py tests/test_srt_utils.py
git commit -m "feat: add batch splitting and cue-index validation"
```

---

### Task 4: Drust client (read glossary, write pending terms)

**Files:**
- Create: `webtool/drust_client.py`
- Test: `tests/test_drust_client.py`

**Interfaces:**
- Consumes: `config.DRUST_BASE`, `config.DRUST_TENANT_ID`, `config.DRUST_ANON_TOKEN`, `config.DRUST_SERVICE_TOKEN` from Task 1.
- Produces:
  - `class DrustClient: def __init__(self, base_url: str, tenant_id: str, anon_token: str, service_token: str)`
  - `def fetch_glossary(self) -> list[dict]` — returns every row of `translation_glossary` (paginates internally, `per_page=200`, until an empty page), each row a dict with at least `chinese`, `english`, `locked` keys.
  - `def insert_pending_term(self, term: str, stage: str, context: str, suggested_fix: str, video_title: str) -> dict` — returns the created row.

- [ ] **Step 1: Write the failing tests (mocking `requests`)**

```python
# tests/test_drust_client.py
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
```

- [ ] **Step 2: Add `responses` to test dependencies and verify the test fails**

Run: `pip install responses==0.25.3` then add `responses==0.25.3` to `requirements.txt`.
Run: `pytest tests/test_drust_client.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'webtool.drust_client'`

- [ ] **Step 3: Implement `webtool/drust_client.py`**

```python
# webtool/drust_client.py
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
            page += 1
        return rows

    def insert_pending_term(self, term: str, stage: str, context: str,
                             suggested_fix: str, video_title: str) -> dict:
        resp = requests.post(
            self._tenant_path("records/pending_terms"),
            json={
                "term": term,
                "stage": stage,
                "context": context,
                "suggested_fix": suggested_fix,
                "video_title": video_title,
            },
            headers={"Authorization": f"Bearer {self.service_token}"},
            timeout=30,
        )
        resp.raise_for_status()
        return resp.json()
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/test_drust_client.py -v`
Expected: PASS (2 tests)

- [ ] **Step 5: Live smoke test against the real tenant (uses real service token — will write one real row)**

```python
# run once from a scratch interpreter, not part of the test suite
from webtool.drust_client import DrustClient
from webtool import config

client = DrustClient(config.DRUST_BASE, config.DRUST_TENANT_ID,
                      config.DRUST_ANON_TOKEN, config.DRUST_SERVICE_TOKEN)
rows = client.fetch_glossary()
print(len(rows), rows[0])
created = client.insert_pending_term(
    term="webtool-smoke-test",
    stage="translation",
    context="webtool Task 4 live smoke test",
    suggested_fix="(none)",
    video_title="webtool-dev-smoke-test",
)
print(created)
```

Run this snippet with `python`. Expected: prints `1525 {...}` (or current row count) and a created record with a non-null `id`. Confirm in Drust (or ask the user) that this smoke-test row in `pending_terms` is acceptable to leave (status `pending`) or should be deleted afterward — it is real data per the user's earlier approval, but flag its `id` so it can be cleaned up on request.

- [ ] **Step 6: Commit**

```bash
git add webtool/drust_client.py tests/test_drust_client.py requirements.txt
git commit -m "feat: add Drust REST client for glossary reads and pending-term writes"
```

---

### Task 5: Glossary consistency checker

**Files:**
- Create: `webtool/glossary_check.py`
- Test: `tests/test_glossary_check.py`

**Interfaces:**
- Consumes: `Cue` from Task 2.
- Produces: `def check_consistency(zh_cues: list[Cue], en_cues: list[Cue], glossary: list[dict]) -> list[str]` — returns a list of human-readable warning strings (empty if none). Does **not** mutate `en_cues` (see Global Constraints on why this is a warning-only check, not an auto-fix).

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_glossary_check.py
from webtool.srt_utils import Cue
from webtool.glossary_check import check_consistency

GLOSSARY = [
    {"chinese": "上人", "english": "Dharma Master", "locked": 1},
    {"chinese": "靜思精舍", "english": "Jing Si Abode", "locked": 1},
    {"chinese": "隨喜", "english": "rejoice", "locked": 0},  # unlocked: never flagged
]


def test_flags_missing_locked_term():
    zh = [Cue(1, "00:00:00,000", "00:00:01,000", "上人開示")]
    en = [Cue(1, "00:00:00,000", "00:00:01,000", "The teacher gave a talk")]
    warnings = check_consistency(zh, en, GLOSSARY)
    assert len(warnings) == 1
    assert "上人" in warnings[0] and "Dharma Master" in warnings[0]


def test_no_warning_when_term_present():
    zh = [Cue(1, "00:00:00,000", "00:00:01,000", "上人開示")]
    en = [Cue(1, "00:00:00,000", "00:00:01,000", "Dharma Master gave a talk")]
    assert check_consistency(zh, en, GLOSSARY) == []


def test_unlocked_terms_are_never_flagged():
    zh = [Cue(1, "00:00:00,000", "00:00:01,000", "隨喜功德")]
    en = [Cue(1, "00:00:00,000", "00:00:01,000", "meritorious deed")]
    assert check_consistency(zh, en, GLOSSARY) == []
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/test_glossary_check.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'webtool.glossary_check'`

- [ ] **Step 3: Implement `webtool/glossary_check.py`**

```python
# webtool/glossary_check.py
from webtool.srt_utils import Cue


def check_consistency(zh_cues: list[Cue], en_cues: list[Cue], glossary: list[dict]) -> list[str]:
    locked_terms = [row for row in glossary if row.get("locked")]
    en_by_index = {cue.index: cue for cue in en_cues}
    warnings = []
    for zh_cue in zh_cues:
        en_cue = en_by_index.get(zh_cue.index)
        if en_cue is None:
            continue
        for row in locked_terms:
            chinese = row["chinese"]
            english = row["english"]
            if chinese in zh_cue.text and english not in en_cue.text:
                warnings.append(
                    f"第 {zh_cue.index} 條：原文含鎖定詞「{chinese}」，"
                    f"但譯文未包含鎖定譯法「{english}」，請人工確認 —— 譯文：{en_cue.text}"
                )
    return warnings
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/test_glossary_check.py -v`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add webtool/glossary_check.py tests/test_glossary_check.py
git commit -m "feat: add glossary consistency warning check"
```

---

### Task 6: Translator — prompt building and response parsing (pure functions)

**Files:**
- Create: `webtool/translator.py`
- Test: `tests/test_translator.py`

**Interfaces:**
- Consumes: `Cue` from Task 2.
- Produces:
  - `class ParsedLine: index: int; text: str; unsure: list[tuple[str, str]]` (dataclass) — `unsure` is `[(zh_term, suggested_fix), ...]` extracted from that line.
  - `def build_batch_prompt(batch: list[Cue], glossary: list[dict], context_tail: list[tuple[str, str]]) -> str`
  - `def build_retry_prompt(original_prompt: str, error_detail: str) -> str`
  - `class TranslationParseError(Exception)`
  - `def parse_claude_response(raw: str, expected_indices: list[int]) -> list[ParsedLine]` — raises `TranslationParseError` if the parsed indices don't exactly match `expected_indices` in order, or if any line doesn't match the `N|||text` format.

Output line format contract (must be stated in the prompt built by `build_batch_prompt`): one line per cue, `<index>|||<English text>`, no blank lines, no extra commentary. Uncertain terms are wrapped inline as `[[UNSURE:chinese_term|english_used]]`.

- [ ] **Step 1: Write the failing tests**

```python
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/test_translator.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'webtool.translator'`

- [ ] **Step 3: Implement `webtool/translator.py`**

```python
# webtool/translator.py
from dataclasses import dataclass, field
import re

_UNSURE_RE = re.compile(r"\[\[UNSURE:(.*?)\|(.*?)\]\]")


class TranslationParseError(Exception):
    pass


@dataclass
class ParsedLine:
    index: int
    text: str
    unsure: list[tuple[str, str]] = field(default_factory=list)


def build_batch_prompt(batch, glossary: list[dict], context_tail: list[tuple[str, str]]) -> str:
    relevant = [
        row for row in glossary
        if any(row["chinese"] in cue.text for cue in batch)
    ]
    glossary_lines = "\n".join(f"- {row['chinese']} -> {row['english']}" for row in relevant)
    context_lines = "\n".join(f"（前情）{zh} -> {en}" for zh, en in context_tail)
    cue_lines = "\n".join(f"{cue.index}|||{cue.text}" for cue in batch)

    return f"""你是慈濟法師開示字幕的中翻英譯者。規則：
- 逐行 1:1 對應，輸出的行數、序號必須與輸入完全相同，不可合併或拆分。
- 海外志工姓名一律用漢語拼音，不用威妥瑪拼音。
- 經典/書名意譯，不要音譯。
- 不確定的詞彙翻譯，把該詞彙包成 [[UNSURE:中文詞|你採用的英文譯法]] 內嵌在譯文中，其餘照常翻譯，不要整行留白。

已鎖定詞彙庫（必須採用以下譯法）：
{glossary_lines if glossary_lines else "（本批次無相關詞彙庫條目）"}

{("語境（前一批結尾）：\n" + context_lines) if context_lines else ""}

請翻譯以下字幕，輸出格式為每行「序號|||英文譯文」，不要加任何其他文字或說明：
{cue_lines}
"""


def build_retry_prompt(original_prompt: str, error_detail: str) -> str:
    return (
        f"{original_prompt}\n\n"
        f"上一次回覆格式不符規定，錯誤原因：{error_detail}\n"
        f"請重新輸出，務必每行格式為「序號|||英文譯文」，序號需與輸入完全一致，不要有多餘文字。"
    )


def parse_claude_response(raw: str, expected_indices: list[int]) -> list[ParsedLine]:
    lines = [line for line in raw.strip().splitlines() if line.strip()]
    parsed = []
    for line in lines:
        if "|||" not in line:
            raise TranslationParseError(f"格式不符，缺少分隔符號 |||：{line!r}")
        index_str, text = line.split("|||", 1)
        try:
            index = int(index_str.strip())
        except ValueError:
            raise TranslationParseError(f"序號無法解析：{line!r}")
        unsure_matches = _UNSURE_RE.findall(text)
        clean_text = _UNSURE_RE.sub(lambda m: m.group(2), text).strip()
        parsed.append(ParsedLine(index=index, text=clean_text, unsure=unsure_matches))

    actual_indices = [p.index for p in parsed]
    if actual_indices != list(expected_indices):
        raise TranslationParseError(
            f"序號不符，預期 {expected_indices}，實際 {actual_indices}"
        )
    return parsed
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/test_translator.py -v`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add webtool/translator.py tests/test_translator.py
git commit -m "feat: add translation prompt builder and response parser"
```

---

### Task 7: Translator — claude CLI invocation

**Files:**
- Modify: `webtool/translator.py`
- Test: `tests/test_translator.py`

**Interfaces:**
- Consumes: `config.CLAUDE_BIN`, `config.CLAUDE_TIMEOUT_SECONDS` from Task 1.
- Produces:
  - `class ClaudeCliError(Exception)`
  - `def call_claude(prompt: str, claude_bin: str, timeout: int) -> str` — runs `claude -p <prompt> --dangerously-skip-permissions`, returns stdout on exit code 0, raises `ClaudeCliError` on non-zero exit or timeout.

- [ ] **Step 1: Write the failing test (mocking `subprocess.run`)**

```python
# append to tests/test_translator.py
from unittest.mock import patch, MagicMock
from webtool.translator import call_claude, ClaudeCliError


@patch("webtool.translator.subprocess.run")
def test_call_claude_returns_stdout_on_success(mock_run):
    mock_run.return_value = MagicMock(returncode=0, stdout="1|||hello", stderr="")
    result = call_claude("prompt text", claude_bin="claude.exe", timeout=60)
    assert result == "1|||hello"
    args = mock_run.call_args[0][0]
    assert args[0] == "claude.exe"
    assert "-p" in args
    assert "prompt text" in args


@patch("webtool.translator.subprocess.run")
def test_call_claude_raises_on_nonzero_exit(mock_run):
    mock_run.return_value = MagicMock(returncode=1, stdout="", stderr="boom")
    try:
        call_claude("prompt text", claude_bin="claude.exe", timeout=60)
        assert False, "expected ClaudeCliError"
    except ClaudeCliError as e:
        assert "boom" in str(e)


@patch("webtool.translator.subprocess.run")
def test_call_claude_raises_on_timeout(mock_run):
    import subprocess
    mock_run.side_effect = subprocess.TimeoutExpired(cmd="claude", timeout=60)
    try:
        call_claude("prompt text", claude_bin="claude.exe", timeout=60)
        assert False, "expected ClaudeCliError"
    except ClaudeCliError:
        pass
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/test_translator.py -v`
Expected: FAIL — `ImportError: cannot import name 'call_claude'`

- [ ] **Step 3: Implement in `webtool/translator.py`** (add near the top: `import subprocess`)

```python
# add to top of webtool/translator.py
import subprocess


class ClaudeCliError(Exception):
    pass


def call_claude(prompt: str, claude_bin: str, timeout: int) -> str:
    try:
        result = subprocess.run(
            [claude_bin, "-p", prompt, "--dangerously-skip-permissions"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as e:
        raise ClaudeCliError(f"claude CLI 逾時（{timeout}秒）") from e

    if result.returncode != 0:
        raise ClaudeCliError(f"claude CLI 失敗（exit {result.returncode}）：{result.stderr}")
    return result.stdout
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/test_translator.py -v`
Expected: PASS (9 tests total in this file)

- [ ] **Step 5: Live smoke test with the real CLI**

Run: `python -c "from webtool.translator import call_claude; from webtool import config; print(call_claude('回覆兩個字：測試成功', config.CLAUDE_BIN, 60))"`
Expected: prints a short response containing something like "測試成功" — confirms headless `-p` mode works non-interactively on this machine before wiring it into the full pipeline.

- [ ] **Step 6: Commit**

```bash
git add webtool/translator.py tests/test_translator.py
git commit -m "feat: invoke local claude CLI in headless mode for batch translation"
```

---

### Task 8: Orchestration — Flask `/translate` endpoint

**Files:**
- Create: `webtool/server.py`
- Test: `tests/test_server.py`

**Interfaces:**
- Consumes:
  - `parse_srt`, `serialize_srt`, `split_batches`, `validate_indices`, `Cue` (Task 2/3)
  - `DrustClient` (Task 4)
  - `check_consistency` (Task 5)
  - `build_batch_prompt`, `build_retry_prompt`, `parse_claude_response`, `call_claude`, `TranslationParseError`, `ClaudeCliError` (Task 6/7)
  - `config` (Task 1)
- Produces: Flask app `webtool.server.app` with:
  - `GET /` — renders `templates/index.html`
  - `POST /translate` — multipart form field `file` (the `.srt`); JSON response `{"filename": str, "srt": str, "warnings": list[str], "pending_terms": list[dict]}` on success, or `{"error": str}` with 4xx status on bad input.

- [ ] **Step 1: Write the failing tests (monkeypatching translation + Drust calls)**

```python
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/test_server.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'webtool.server'`

- [ ] **Step 3: Implement `webtool/server.py`**

```python
# webtool/server.py
from flask import Flask, request, jsonify, render_template

from webtool import config
from webtool.srt_utils import parse_srt, serialize_srt, split_batches, validate_indices, Cue
from webtool.drust_client import DrustClient
from webtool.glossary_check import check_consistency
from webtool.translator import (
    build_batch_prompt, build_retry_prompt, parse_claude_response,
    call_claude, TranslationParseError, ClaudeCliError,
)

app = Flask(__name__)

drust_client = DrustClient(
    config.DRUST_BASE, config.DRUST_TENANT_ID,
    config.DRUST_ANON_TOKEN, config.DRUST_SERVICE_TOKEN,
)


def translate_cues(cues: list[Cue], glossary: list[dict], batch_size: int,
                    max_retries: int, video_title: str):
    translated: list[Cue] = []
    warnings: list[str] = []
    pending: list[tuple[str, str]] = []
    context_tail: list[tuple[str, str]] = []

    for batch in split_batches(cues, batch_size):
        expected_indices = [c.index for c in batch]
        prompt = build_batch_prompt(batch, glossary, context_tail)
        parsed = None
        last_error = ""

        for attempt in range(max_retries):
            try:
                raw = call_claude(prompt, config.CLAUDE_BIN, config.CLAUDE_TIMEOUT_SECONDS)
                parsed = parse_claude_response(raw, expected_indices)
                break
            except (TranslationParseError, ClaudeCliError) as e:
                last_error = str(e)
                prompt = build_retry_prompt(prompt, last_error)

        if parsed is None:
            for cue in batch:
                translated.append(Cue(cue.index, cue.start, cue.end, "[翻譯失敗-請人工確認]"))
            warnings.append(
                f"批次 {batch[0].index}-{batch[-1].index} 翻譯失敗（{last_error}），請人工確認"
            )
            context_tail = []
            continue

        for cue, line in zip(batch, parsed):
            translated.append(Cue(cue.index, cue.start, cue.end, line.text))
            pending.extend(line.unsure)
        context_tail = [(cue.text, line.text) for cue, line in zip(batch, parsed)][-3:]

    return translated, warnings, pending


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/translate", methods=["POST"])
def translate():
    uploaded = request.files.get("file")
    if uploaded is None or not uploaded.filename.lower().endswith(".srt"):
        return jsonify({"error": "請上傳 .srt 檔案"}), 400

    content = uploaded.stream.read().decode("utf-8-sig")
    cues = parse_srt(content)
    if not cues:
        return jsonify({"error": "無法解析 SRT 內容，請確認檔案格式"}), 400

    try:
        glossary = drust_client.fetch_glossary()
    except Exception:
        return jsonify({"error": "無法連線詞彙庫，請稍後再試"}), 502

    video_title = uploaded.filename.rsplit(".", 1)[0]
    translated, warnings, pending_raw = translate_cues(
        cues, glossary, config.BATCH_SIZE, config.MAX_RETRIES, video_title,
    )

    warnings.extend(check_consistency(cues, translated, glossary))

    zh_text_by_index = {c.index: c.text for c in cues}
    seen_terms = set()
    pending_terms = []
    for zh_term, suggested_fix in pending_raw:
        if zh_term in seen_terms:
            continue
        seen_terms.add(zh_term)
        try:
            drust_client.insert_pending_term(
                term=zh_term, stage="translation",
                context=next((t for t in zh_text_by_index.values() if zh_term in t), ""),
                suggested_fix=suggested_fix, video_title=video_title,
            )
            pending_terms.append({"term": zh_term, "suggested_fix": suggested_fix})
        except Exception:
            warnings.append(f"待確認詞彙「{zh_term}」寫入 Drust 失敗，請自行記錄")

    output_filename = f"[英文字幕]{video_title.replace('[中文字幕]', '')}.srt"
    return jsonify({
        "filename": output_filename,
        "srt": serialize_srt(translated),
        "warnings": warnings,
        "pending_terms": pending_terms,
    })
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/test_server.py -v`
Expected: PASS (5 tests) — note `test_get_index_renders_page` will fail until Task 9 creates `templates/index.html`; if run before Task 9, expect that one test to fail with `TemplateNotFound` and treat it as a known pending dependency, not a regression. Run `pytest tests/test_server.py -v -k "not renders_page"` to confirm the other 4 pass now.

- [ ] **Step 5: Commit**

```bash
git add webtool/server.py tests/test_server.py
git commit -m "feat: wire up /translate endpoint with batching, retry, and pending-term writes"
```

---

### Task 9: Frontend page

**Files:**
- Create: `webtool/templates/index.html`
- Create: `webtool/static/app.js`
- Create: `webtool/static/style.css`
- Create: `webtool/run.py`

**Interfaces:**
- Consumes: `webtool.server.app`, `config.PORT` (Task 1/8).
- Produces: `webtool/run.py` — `if __name__ == "__main__": app.run(host="0.0.0.0", port=config.PORT)`, the entry point used to start the server.

- [ ] **Step 1: Create `webtool/templates/index.html`**

```html
<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <title>慈濟字幕中翻英工具</title>
  <link rel="stylesheet" href="{{ url_for('static', filename='style.css') }}">
</head>
<body>
  <h1>中文字幕 → 英文字幕</h1>
  <p>上傳已完成糾錯/格式化的中文 .srt，系統會依詞彙庫產出英文 .srt。</p>

  <input type="file" id="fileInput" accept=".srt">
  <button id="translateBtn">開始翻譯</button>

  <div id="status"></div>
  <div id="warnings"></div>
  <div id="pendingTerms"></div>
  <a id="downloadLink" style="display:none" download>下載英文字幕</a>

  <script src="{{ url_for('static', filename='app.js') }}"></script>
</body>
</html>
```

- [ ] **Step 2: Create `webtool/static/style.css`**

```css
body { font-family: sans-serif; max-width: 640px; margin: 2rem auto; }
#status { margin-top: 1rem; font-weight: bold; }
#warnings, #pendingTerms { margin-top: 1rem; white-space: pre-wrap; color: #a33; }
#downloadLink { display: block; margin-top: 1rem; }
```

- [ ] **Step 3: Create `webtool/static/app.js`**

```javascript
document.getElementById("translateBtn").addEventListener("click", async () => {
  const fileInput = document.getElementById("fileInput");
  const statusEl = document.getElementById("status");
  const warningsEl = document.getElementById("warnings");
  const pendingEl = document.getElementById("pendingTerms");
  const downloadLink = document.getElementById("downloadLink");

  if (!fileInput.files.length) {
    statusEl.textContent = "請先選擇一個 .srt 檔案";
    return;
  }

  statusEl.textContent = "翻譯中，請稍候（可能需要數分鐘）...";
  warningsEl.textContent = "";
  pendingEl.textContent = "";
  downloadLink.style.display = "none";

  const formData = new FormData();
  formData.append("file", fileInput.files[0]);

  try {
    const resp = await fetch("/translate", { method: "POST", body: formData });
    const data = await resp.json();

    if (!resp.ok) {
      statusEl.textContent = "錯誤：" + data.error;
      return;
    }

    statusEl.textContent = "翻譯完成！";
    if (data.warnings.length) {
      warningsEl.textContent = "警告：\n" + data.warnings.join("\n");
    }
    if (data.pending_terms.length) {
      pendingEl.textContent = "本次新增待確認詞彙：\n" +
        data.pending_terms.map(t => `${t.term} -> ${t.suggested_fix}`).join("\n");
    }

    const blob = new Blob([data.srt], { type: "text/plain;charset=utf-8" });
    downloadLink.href = URL.createObjectURL(blob);
    downloadLink.download = data.filename;
    downloadLink.textContent = `下載 ${data.filename}`;
    downloadLink.style.display = "block";
  } catch (err) {
    statusEl.textContent = "發生錯誤：" + err;
  }
});
```

- [ ] **Step 4: Create `webtool/run.py`**

```python
# webtool/run.py
from webtool.server import app
from webtool import config

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=config.PORT)
```

- [ ] **Step 5: Run the full test suite now that the template exists**

Run: `pytest tests/ -v`
Expected: PASS (all tests, including `test_get_index_renders_page` from Task 8)

- [ ] **Step 6: Manual browser smoke test**

Run: `python -m webtool.run`
Open `http://localhost:8787` in a browser, upload `tests/fixtures/sample_zh.srt`, click 開始翻譯, confirm the page shows a completed status, a download link appears, and the downloaded file has 12 cues with English text in the same timecodes as the source. Stop the server with Ctrl+C when done.

- [ ] **Step 7: Commit**

```bash
git add webtool/templates webtool/static webtool/run.py
git commit -m "feat: add frontend page for SRT upload/translate/download"
```

---

### Task 10: End-to-end verification with a real production-size file

**Files:** none created — verification only.

- [ ] **Step 1: Pick a real file and trim a realistic-size sample**

Copy `[中文字幕]志工早會二.srt` (or any file with 80+ cues) into a scratch copy, keep only the first ~100 cues (find the 100th cue block and truncate after it, keeping the file otherwise intact) so the run exercises at least 2 batches at `BATCH_SIZE=50`.

- [ ] **Step 2: Run it through the running server**

With `python -m webtool.run` running, upload the trimmed file via the browser (or `curl -F "file=@sample.srt" http://localhost:8787/translate -o result.json`).

- [ ] **Step 3: Manually review the result**

Check: cue count in the output matches the input, timecodes are untouched, translated text reads as coherent English, any known glossary terms (e.g. 上人 -> Dharma Master) appear correctly, and any warnings/pending terms reported make sense given the content.

- [ ] **Step 4: Report findings**

If translation quality or batch-boundary continuity looks off, note specific cue numbers and phrasing — that feedback drives prompt-wording tweaks in `build_batch_prompt`, not a new task in this plan.

---

## Deferred to a later plan (explicitly out of scope here)

- Exposing the running Flask app via `cloudflared tunnel` for colleague access — the user will handle this themselves once the local version is verified.
- Stage 1/2/3 automation (transcription, homophone correction, formatting) as web-tool features.
- Any UI for browsing/editing `translation_glossary`, `homophone_corrections`, or confirming `pending_terms` — those stay in the existing Claude Code + Drust MCP workflow.
