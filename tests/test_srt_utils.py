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
