# webtool/translator.py
from dataclasses import dataclass, field
import re
import subprocess

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
        if row.get("chinese") and any(row.get("chinese") in cue.text for cue in batch)
    ]
    glossary_lines = "\n".join(
        f"- {row.get('chinese')} -> {row.get('english', '')}" for row in relevant
    )
    context_lines = "\n".join(f"（前情）{zh} -> {en}" for zh, en in context_tail)
    cue_lines = "\n".join(
        "{}|||{}".format(cue.index, cue.text.replace("\n", " ")) for cue in batch
    )

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
        if "[[UNSURE" in clean_text:
            raise TranslationParseError(f"未正確格式化的 UNSURE 標記殘留於譯文：{line!r}")
        parsed.append(ParsedLine(index=index, text=clean_text, unsure=unsure_matches))

    actual_indices = [p.index for p in parsed]
    if actual_indices != list(expected_indices):
        raise TranslationParseError(
            f"序號不符，預期 {expected_indices}，實際 {actual_indices}"
        )
    return parsed


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
