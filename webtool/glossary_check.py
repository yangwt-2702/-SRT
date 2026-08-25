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
