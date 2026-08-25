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
