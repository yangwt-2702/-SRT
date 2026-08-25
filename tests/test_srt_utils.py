from pathlib import Path
from webtool.srt_utils import parse_srt, serialize_srt, Cue, split_batches, validate_indices

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
