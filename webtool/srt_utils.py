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
    content = content.replace("﻿", "").replace("\r\n", "\n").strip() + "\n"
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
