from __future__ import annotations

import argparse
import json
import os
import re
import shutil
from datetime import datetime, timedelta
from pathlib import Path
from typing import Iterable, Optional
from urllib.parse import quote


BASE_DIR = Path(__file__).resolve().parent
WEB_DIR = BASE_DIR / "web"
IMG_DIR = BASE_DIR / "img"
VIDEO_DIR = BASE_DIR / "video"
SOUND_DIR = BASE_DIR / "sound"
DOCS_DIR = BASE_DIR / "docs"
DOCS_DATA_DIR = DOCS_DIR / "data"
DOCS_REPORT_DIR = DOCS_DATA_DIR / "reports"
DOCS_SEARCH_DIR = DOCS_DATA_DIR / "word-search"
DOCS_ASSET_DIR = DOCS_DIR / "assets"
DEFAULT_SOURCE_PROJECT_ROOT = BASE_DIR.parent / "chzzk-chat-analyzer"
SOURCE_PROJECT_ROOT = Path(
    os.getenv("CHZZK_SOURCE_PROJECT_ROOT") or DEFAULT_SOURCE_PROJECT_ROOT
).resolve()
LOG_DIR = Path(
    os.getenv("CHZZK_SOURCE_LOG_DIR") or (SOURCE_PROJECT_ROOT / "analysis_logs")
).resolve()
CLIP_TITLE_PATH = VIDEO_DIR / "videoname.txt"
WORD_SEARCH_EXAMPLES_PATH = BASE_DIR / "word_search_examples.txt"
TOP_CLIP_RE = re.compile(r"^top(\d+)\.mp4$", re.IGNORECASE)
TITLE_LINE_RE = re.compile(r"^\s*T(\d+)\.\s*(.+?)\s*$")
SUPPORTED_SOUND_SUFFIXES = {".mp3", ".wav", ".ogg", ".m4a"}


def parse_datetime(value) -> Optional[datetime]:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value))
    except ValueError:
        return None


def normalize_text(value, fallback: str = "") -> str:
    text = str(value or "").strip()
    return text or fallback


def normalize_lookup_token(value) -> str:
    return "".join(str(value or "").strip().lower().split())


def format_bucket_label(bucket_key: str, bucket_minutes: int) -> str:
    normalized = normalize_text(bucket_key)
    if not normalized:
        return "-"
    try:
        bucket_dt = datetime.strptime(normalized, "%Y-%m-%d %H:%M")
    except ValueError:
        return normalized
    end_dt = bucket_dt + timedelta(minutes=max(int(bucket_minutes or 1), 1))
    return f"{bucket_dt.strftime('%H:%M')} - {end_dt.strftime('%H:%M')}"


def ensure_log_dir() -> None:
    if not LOG_DIR.exists():
        raise FileNotFoundError(f"월별 로그 폴더를 찾지 못했습니다: {LOG_DIR}")


def load_payload(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def list_report_paths() -> list[Path]:
    ensure_log_dir()
    return sorted(
        [path for path in LOG_DIR.glob("*.json") if path.is_file()],
        key=lambda path: (
            parse_datetime(load_payload(path).get("generatedAt")) or datetime.min,
            path.name,
        ),
        reverse=True,
    )


def split_token_aliases(token: str, token_title: str = "") -> list[str]:
    aliases: list[str] = []
    for source in (normalize_text(token_title), normalize_text(token)):
        if not source:
            continue
        for raw_part in source.split("+"):
            alias = normalize_text(raw_part)
            if not alias or " 외 " in alias or alias in aliases:
                continue
            aliases.append(alias)
    return aliases


def display_token(token: str, token_title: str, token_type: str = "") -> str:
    if token_type == "word":
        aliases = split_token_aliases(token, token_title)
        if aliases:
            return aliases[0]
    return normalize_text(token, normalize_text(token_title, "-"))


def trim_ranked_rows(rows, limit: int = 20, token_type: str = "") -> list[dict]:
    result: list[dict] = []
    for row in list(rows or [])[:limit]:
        if not isinstance(row, dict):
            continue
        token = normalize_text(row.get("token"))
        if not token:
            continue
        token_title = normalize_text(row.get("tokenTitle"), token)
        result.append(
            {
                "token": token,
                "displayToken": display_token(token, token_title, token_type),
                "tokenTitle": token_title,
                "count": int(row.get("count") or 0),
                "ratio": float(row.get("ratio") or 0.0),
                "imageUrl": normalize_text(row.get("imageUrl")),
            }
        )
    return result


def build_moment(row: dict, bucket_minutes: int) -> dict:
    if not isinstance(row, dict):
        return {}
    bucket_key = normalize_text(row.get("bucketKey") or row.get("peakBucketKey"))
    return {
        "date": normalize_text(row.get("date"), "-"),
        "bucketKey": bucket_key,
        "bucketLabel": format_bucket_label(bucket_key, bucket_minutes),
        "count": int(row.get("count") or row.get("peakCount") or 0),
        "liftVsAverage": float(row.get("liftVsAverage") or 0.0),
        "topWords": trim_ranked_rows(row.get("topWords"), limit=3, token_type="word"),
        "topEmotes": trim_ranked_rows(row.get("topEmotes"), limit=3, token_type="emote"),
    }


def iter_token_stats(token_stats) -> Iterable[dict]:
    if isinstance(token_stats, dict):
        return token_stats.values()
    if isinstance(token_stats, list):
        return token_stats
    return []


def find_peak_bucket(bucket_counts) -> tuple[str, int]:
    best_key = ""
    best_count = 0
    for bucket_key, raw_count in dict(bucket_counts or {}).items():
        count = int(raw_count or 0)
        bucket_text = normalize_text(bucket_key)
        if count <= 0 or not bucket_text:
            continue
        if count > best_count or (count == best_count and bucket_text < best_key):
            best_key = bucket_text
            best_count = count
    return best_key, best_count


def build_word_search_items(summary: dict, bucket_minutes: int) -> list[dict]:
    advanced = summary.get("advancedInsights") if isinstance(summary.get("advancedInsights"), dict) else {}
    token_stats = advanced.get("tokenStats")
    rows: list[dict] = []
    total_word_count = 0
    for row in iter_token_stats(token_stats):
        if not isinstance(row, dict):
            continue
        if normalize_text(row.get("type")).lower() != "word":
            continue
        token = normalize_text(row.get("token"))
        token_title = normalize_text(row.get("tokenTitle"), token)
        count = int(row.get("count") or 0)
        if not token or count <= 0:
            continue
        total_word_count += count
        peak_bucket_key, peak_bucket_count = find_peak_bucket(row.get("bucketCounts"))
        rows.append(
            {
                "displayToken": display_token(token, token_title, "word"),
                "token": token,
                "tokenTitle": token_title,
                "count": count,
                "ratio": float(row.get("ratio") or 0.0),
                "aliases": split_token_aliases(token, token_title),
                "peakBucketKey": peak_bucket_key,
                "peakBucketLabel": format_bucket_label(peak_bucket_key, bucket_minutes) if peak_bucket_key else "-",
                "peakBucketCount": peak_bucket_count,
                "peakDate": peak_bucket_key[:10] if len(peak_bucket_key) >= 10 else "",
            }
        )
    if total_word_count > 0:
        for row in rows:
            if float(row.get("ratio") or 0.0) <= 0.0:
                row["ratio"] = (float(row.get("count") or 0.0) / float(total_word_count)) * 100.0
    rows.sort(
        key=lambda item: (
            -int(item.get("count") or 0),
            normalize_lookup_token(item.get("displayToken")),
            normalize_lookup_token(item.get("tokenTitle")),
        )
    )
    return [{**row, "rank": index} for index, row in enumerate(rows, start=1)]


def parse_clip_titles() -> dict[int, str]:
    if not CLIP_TITLE_PATH.exists():
        return {}
    titles: dict[int, str] = {}
    for line in CLIP_TITLE_PATH.read_text(encoding="utf-8").splitlines():
        match = TITLE_LINE_RE.match(line)
        if not match:
            continue
        titles[int(match.group(1))] = normalize_text(match.group(2))
    return titles


def list_top_clip_paths() -> list[tuple[int, Path]]:
    paths: list[tuple[int, Path]] = []
    for path in VIDEO_DIR.glob("top*.mp4"):
        if not path.is_file():
            continue
        match = TOP_CLIP_RE.match(path.name)
        if not match:
            continue
        paths.append((int(match.group(1)), path))
    return sorted(paths, key=lambda item: item[0])


def build_top_moment_clips(legend_rows: list[dict], bucket_minutes: int) -> list[dict]:
    title_map = parse_clip_titles()
    clips: list[dict] = []
    for clip_index, clip_path in list_top_clip_paths():
        moment = legend_rows[clip_index - 1] if 0 < clip_index <= len(legend_rows) else {}
        moment_bucket_key = normalize_text((moment or {}).get("bucketKey"))
        clips.append(
            {
                "rank": clip_index,
                "label": f"T{clip_index}",
                "title": normalize_text(title_map.get(clip_index), f"Top {clip_index}"),
                "videoUrl": f"./assets/video/{quote(clip_path.name)}",
                "date": normalize_text((moment or {}).get("date"), "-"),
                "timeLabel": normalize_text(
                    (moment or {}).get("bucketLabel"),
                    format_bucket_label(moment_bucket_key, bucket_minutes) if moment_bucket_key else "-",
                ),
                "liftVsAverage": float((moment or {}).get("liftVsAverage") or 0.0),
                "topWords": list((moment or {}).get("topWords") or [])[:3],
                "topEmotes": list((moment or {}).get("topEmotes") or [])[:3],
            }
        )
    return clips


def build_sound_lookup() -> dict[str, str]:
    lookup: dict[str, str] = {}
    if SOUND_DIR.exists():
        for path in SOUND_DIR.iterdir():
            if not path.is_file() or path.suffix.lower() not in SUPPORTED_SOUND_SUFFIXES:
                continue
            lookup[normalize_lookup_token(path.stem)] = f"./assets/sound/{quote(path.name)}"
    return lookup


def parse_word_search_examples() -> list[dict]:
    if not WORD_SEARCH_EXAMPLES_PATH.exists():
        return []
    sound_lookup = build_sound_lookup()
    rows: list[dict] = []
    for raw_line in WORD_SEARCH_EXAMPLES_PATH.read_text(encoding="utf-8").splitlines():
        line = normalize_text(raw_line)
        if not line or line.startswith("#"):
            continue
        parts = [normalize_text(part) for part in line.split("|")]
        query = parts[0]
        sound_name = parts[1] if len(parts) > 1 else ""
        audio_url = ""
        if sound_name:
            sound_path = SOUND_DIR / sound_name
            if sound_path.exists():
                audio_url = f"./assets/sound/{quote(sound_path.name)}"
        if not audio_url:
            audio_url = sound_lookup.get(normalize_lookup_token(query), "")
        rows.append(
            {
                "label": query,
                "query": query,
                "audioUrl": audio_url,
            }
        )
    return rows


def build_report_index(
    path: Path,
    payload: dict,
    *,
    report_file: str,
    word_search_file: str,
) -> dict:
    summary = payload.get("summary") if isinstance(payload.get("summary"), dict) else {}
    period = summary.get("analysisPeriod") if isinstance(summary.get("analysisPeriod"), dict) else {}
    channel_name = normalize_text(payload.get("channelName")) or normalize_text(summary.get("channelName")) or "CHZZK"
    label = normalize_text(payload.get("label"), "리포트")
    effective_start = normalize_text(period.get("effectiveStartDate") or payload.get("dateFrom"), "-")
    effective_end = normalize_text(period.get("effectiveEndDate") or payload.get("dateTo"), "-")
    return {
        "id": path.name,
        "channelName": channel_name,
        "label": label,
        "title": f"{channel_name} {label}",
        "subtitle": f"{effective_start} ~ {effective_end}",
        "generatedAt": normalize_text(payload.get("generatedAt"), "-"),
        "videoCount": int(summary.get("videoCount") or 0),
        "messageCount": int(summary.get("messageCount") or 0),
        "reportFile": f"./data/reports/{report_file}",
        "wordSearchFile": f"./data/word-search/{word_search_file}",
    }


def build_public_report(
    path: Path,
    payload: dict,
    *,
    word_search_file: str,
) -> tuple[dict, dict]:
    summary = payload.get("summary") if isinstance(payload.get("summary"), dict) else {}
    advanced = summary.get("advancedInsights") if isinstance(summary.get("advancedInsights"), dict) else {}
    highlights = advanced.get("streamerHighlights") if isinstance(advanced.get("streamerHighlights"), dict) else {}
    period = summary.get("analysisPeriod") if isinstance(summary.get("analysisPeriod"), dict) else {}
    bucket_minutes = int(advanced.get("bucketMinutes") or 2)
    top_words = trim_ranked_rows(summary.get("topWords"), limit=20, token_type="word")
    top_emotes = trim_ranked_rows(summary.get("topEmotes"), limit=20, token_type="emote")
    legend_rows = [
        build_moment(row, bucket_minutes)
        for row in list(highlights.get("legendTopMoments") or [])[:5]
        if isinstance(row, dict)
    ]
    search_items = build_word_search_items(summary, bucket_minutes)
    report_payload = {
        "id": path.name,
        "label": normalize_text(payload.get("label"), "리포트"),
        "title": f"{normalize_text(payload.get('channelName') or summary.get('channelName') or 'CHZZK')} {normalize_text(payload.get('label'), '리포트')} 채팅 리포트",
        "subtitle": f"{normalize_text(period.get('effectiveStartDate') or payload.get('dateFrom'), '-')}"
        f" ~ {normalize_text(period.get('effectiveEndDate') or payload.get('dateTo'), '-')}",
        "bucketMinutes": bucket_minutes,
        "overview": {
            "videoCount": int(summary.get("videoCount") or 0),
            "messageCount": int(summary.get("messageCount") or 0),
        },
        "topWords": top_words,
        "topEmotes": top_emotes,
        "topMomentClips": build_top_moment_clips(legend_rows, bucket_minutes),
        "wordSearchExamples": parse_word_search_examples(),
        "wordSearchFile": f"./data/word-search/{word_search_file}",
    }
    search_payload = {"items": search_items}
    return report_payload, search_payload


def reset_docs_dir() -> None:
    if DOCS_DIR.exists():
        shutil.rmtree(DOCS_DIR)
    DOCS_REPORT_DIR.mkdir(parents=True, exist_ok=True)
    DOCS_SEARCH_DIR.mkdir(parents=True, exist_ok=True)


def copy_static_assets() -> None:
    shutil.copy2(WEB_DIR / "index.html", DOCS_DIR / "index.html")
    shutil.copy2(WEB_DIR / "styles.css", DOCS_DIR / "styles.css")
    shutil.copy2(WEB_DIR / "app.js", DOCS_DIR / "app.js")
    shutil.copy2(IMG_DIR / "sign.webp", DOCS_ASSET_DIR / "img" / "sign.webp")


def ensure_asset_dirs() -> None:
    (DOCS_ASSET_DIR / "img").mkdir(parents=True, exist_ok=True)
    (DOCS_ASSET_DIR / "video").mkdir(parents=True, exist_ok=True)
    (DOCS_ASSET_DIR / "sound").mkdir(parents=True, exist_ok=True)


def copy_asset_folder(src_dir: Path, dst_dir: Path) -> None:
    if not src_dir.exists():
        return
    for path in src_dir.iterdir():
        if not path.is_file():
            continue
        shutil.copy2(path, dst_dir / path.name)


def write_json(path: Path, payload: dict | list) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def build_site() -> None:
    reset_docs_dir()
    ensure_asset_dirs()
    copy_static_assets()
    copy_asset_folder(VIDEO_DIR, DOCS_ASSET_DIR / "video")
    copy_asset_folder(SOUND_DIR, DOCS_ASSET_DIR / "sound")
    (DOCS_DIR / ".nojekyll").write_text("", encoding="utf-8")

    reports_index: list[dict] = []
    for index, path in enumerate(list_report_paths(), start=1):
        payload = load_payload(path)
        report_file = f"report-{index:03d}.json"
        word_search_file = f"search-{index:03d}.json"
        report_payload, search_payload = build_public_report(
            path,
            payload,
            word_search_file=word_search_file,
        )
        index_payload = build_report_index(
            path,
            payload,
            report_file=report_file,
            word_search_file=word_search_file,
        )
        reports_index.append(index_payload)
        write_json(DOCS_REPORT_DIR / report_file, report_payload)
        write_json(DOCS_SEARCH_DIR / word_search_file, search_payload)
    write_json(DOCS_DATA_DIR / "reports.json", {"reports": reports_index})


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="GitHub Pages용 월간 재첩 정적 사이트 빌드")
    return parser.parse_args()


if __name__ == "__main__":
    parse_args()
    build_site()
    print(f"Built static site into: {DOCS_DIR}")
