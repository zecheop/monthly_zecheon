from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import unicodedata
from datetime import datetime, timedelta
from pathlib import Path
from typing import Iterable, Optional
from urllib.parse import quote


BASE_DIR = Path(__file__).resolve().parent
WEB_DIR = BASE_DIR / "web"
IMG_DIR = BASE_DIR / "img"
VIDEO_DIR = BASE_DIR / "video"
SOUND_DIR = BASE_DIR / "sound"
GAME_IMAGE_DIR = BASE_DIR / "game_images"
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
PUBLIC_WORD_EXCLUDE_PATH = BASE_DIR / "public_word_exclude.txt"
PUBLIC_WORD_MERGES_PATH = BASE_DIR / "public_word_merges.txt"
PUBLIC_GAME_EXCLUDE_PATH = BASE_DIR / "public_game_exclude.txt"
PUBLIC_GAME_WORDS_PATH = BASE_DIR / "public_game_words.txt"
TOP_CLIP_RE = re.compile(r"^top(\d+)\.mp4$", re.IGNORECASE)
HERO_VIDEO_RE = re.compile(r"^video(\d+)\.(mp4|webm|mov|m4v)$", re.IGNORECASE)
TITLE_LINE_RE = re.compile(r"^\s*T(\d+)\.\s*(.+?)\s*$")
SUPPORTED_SOUND_SUFFIXES = {".mp3", ".wav", ".ogg", ".m4a"}
SUPPORTED_IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"}
SUPPORTED_VIDEO_SUFFIXES = {".mp4", ".webm", ".mov", ".m4v"}
PUBLIC_GAME_MIN_COUNT = 120


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
    normalized = unicodedata.normalize("NFC", str(value or ""))
    return "".join(normalized.strip().lower().split())


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


def format_issue_label(value: str) -> str:
    text = normalize_text(value)
    match = re.match(r"^(\d{4})-(\d{2})$", text)
    if match:
        return f"{match.group(1)}.{match.group(2)}"
    return text


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
                "bucketCounts": {
                    normalize_text(bucket_key): int(raw_count or 0)
                    for bucket_key, raw_count in dict(row.get("bucketCounts") or {}).items()
                    if normalize_text(bucket_key)
                },
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


def list_hero_video_paths() -> list[Path]:
    paths: list[tuple[int, Path]] = []
    for path in VIDEO_DIR.iterdir():
        if not path.is_file():
            continue
        match = HERO_VIDEO_RE.match(path.name)
        if not match:
            continue
        paths.append((int(match.group(1)), path))
    return [path for _, path in sorted(paths, key=lambda item: item[0])]


def build_top_moment_clips(legend_rows: list[dict], bucket_minutes: int) -> list[dict]:
    title_map = parse_clip_titles()
    clips: list[dict] = []
    for clip_index, clip_path in list_top_clip_paths():
        moment = legend_rows[clip_index - 1] if 0 < clip_index <= len(legend_rows) else {}
        moment_bucket_key = normalize_text((moment or {}).get("bucketKey"))
        clips.append(
            {
                "rank": clip_index,
                "label": str(clip_index),
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


def build_game_audio_manifest() -> dict[str, Any]:
    manifest: dict[str, Any] = {
        "click": "",
        "success": "",
        "fail": "",
        "tokens": {},
    }
    if not SOUND_DIR.exists():
        return manifest

    for path in SOUND_DIR.iterdir():
        if not path.is_file() or path.suffix.lower() not in SUPPORTED_SOUND_SUFFIXES:
            continue
        stem_key = normalize_lookup_token(path.stem)
        asset_url = f"./assets/sound/{quote(path.name)}"
        if stem_key in {"click", "button", "buttonclick", "button-click"}:
            manifest["click"] = asset_url
            continue
        if stem_key in {"success", "correct", "win"}:
            manifest["success"] = asset_url
            continue
        if stem_key in {"fail", "wrong", "lose", "error"}:
            manifest["fail"] = asset_url
            continue
        manifest["tokens"][stem_key] = asset_url
    return manifest


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


def parse_public_word_excludes() -> set[str]:
    if not PUBLIC_WORD_EXCLUDE_PATH.exists():
        return set()
    excluded: set[str] = set()
    for raw_line in PUBLIC_WORD_EXCLUDE_PATH.read_text(encoding="utf-8").splitlines():
        line = normalize_text(raw_line)
        if not line or line.startswith("#"):
            continue
        excluded.add(normalize_lookup_token(line))
    return excluded


def parse_public_game_excludes() -> set[str]:
    if not PUBLIC_GAME_EXCLUDE_PATH.exists():
        return set()
    excluded: set[str] = set()
    for raw_line in PUBLIC_GAME_EXCLUDE_PATH.read_text(encoding="utf-8").splitlines():
        line = normalize_text(raw_line)
        if not line or line.startswith("#"):
            continue
        excluded.add(normalize_lookup_token(line))
    return excluded


def parse_public_game_words() -> list[str]:
    if not PUBLIC_GAME_WORDS_PATH.exists():
        return []
    words: list[str] = []
    seen: set[str] = set()
    for raw_line in PUBLIC_GAME_WORDS_PATH.read_text(encoding="utf-8").splitlines():
        line = normalize_text(raw_line)
        if not line or line.startswith("#"):
            continue
        token_key = normalize_lookup_token(line)
        if not token_key or token_key in seen:
            continue
        seen.add(token_key)
        words.append(token_key)
    return words


def parse_public_word_merges() -> list[dict]:
    if not PUBLIC_WORD_MERGES_PATH.exists():
        return []
    groups: list[dict] = []
    for raw_line in PUBLIC_WORD_MERGES_PATH.read_text(encoding="utf-8").splitlines():
        line = normalize_text(raw_line)
        if not line or line.startswith("#"):
            continue
        parsed_parts: list[str] = []
        if "=" in line or ":" in line:
            delimiter = "=" if "=" in line else ":"
            canonical_part, alias_part = line.split(delimiter, 1)
            canonical = normalize_text(canonical_part)
            alias_values = [
                normalize_text(raw_part)
                for raw_part in re.split(r"[|,]", alias_part)
            ]
            parsed_parts = [canonical, *alias_values]
        else:
            parsed_parts = [normalize_text(raw_part) for raw_part in line.split("|")]
        aliases: list[str] = []
        alias_keys: set[str] = set()
        for alias in parsed_parts:
            alias_key = normalize_lookup_token(alias)
            if not alias or not alias_key or alias_key in alias_keys:
                continue
            aliases.append(alias)
            alias_keys.add(alias_key)
        if not aliases:
            continue
        groups.append(
            {
                "canonical": aliases[0],
                "aliases": aliases,
                "aliasKeys": alias_keys,
            }
        )
    return groups


def find_public_merge_group(item: dict, merge_groups: list[dict]) -> Optional[dict]:
    if not merge_groups:
        return None
    aliases = item.get("aliases") if isinstance(item.get("aliases"), list) else []
    candidate_keys = {
        normalize_lookup_token(value)
        for value in [
            item.get("displayToken"),
            item.get("token"),
            item.get("tokenTitle"),
            *aliases,
        ]
        if normalize_lookup_token(value)
    }
    for group in merge_groups:
        alias_keys = group.get("aliasKeys")
        if isinstance(alias_keys, set) and candidate_keys & alias_keys:
            return group
    return None


def merge_bucket_counts(target: dict[str, int], source) -> None:
    for bucket_key, raw_count in dict(source or {}).items():
        bucket_text = normalize_text(bucket_key)
        if not bucket_text:
            continue
        target[bucket_text] = int(target.get(bucket_text) or 0) + int(raw_count or 0)


def merge_text_list(target: list[str], values) -> None:
    for value in list(values or []):
        text = normalize_text(value)
        if text and text not in target:
            target.append(text)


def merge_public_search_items(search_items: list[dict], merge_groups: list[dict], bucket_minutes: int) -> list[dict]:
    if not merge_groups:
        return search_items

    merged_rows: dict[str, dict] = {}
    passthrough_rows: list[dict] = []

    for item in search_items:
        if not isinstance(item, dict):
            continue
        group = find_public_merge_group(item, merge_groups)
        if not group:
            passthrough_rows.append(item)
            continue

        canonical = normalize_text(group.get("canonical"))
        canonical_key = normalize_lookup_token(canonical)
        if not canonical or not canonical_key:
            passthrough_rows.append(item)
            continue

        merged = merged_rows.get(canonical_key)
        if merged is None:
            merged = {
                "displayToken": canonical,
                "token": canonical,
                "tokenTitle": canonical,
                "count": 0,
                "ratio": 0.0,
                "aliases": [],
                "bucketCounts": {},
                "_canonicalKey": canonical_key,
                "_presentAliasKeys": set(),
                "_groupAliases": list(group.get("aliases") or [canonical]),
            }
            merged_rows[canonical_key] = merged

        merged["count"] += int(item.get("count") or 0)
        merged["ratio"] += float(item.get("ratio") or 0.0)
        merge_bucket_counts(merged["bucketCounts"], item.get("bucketCounts"))

        item_aliases = item.get("aliases") if isinstance(item.get("aliases"), list) else []
        for alias in [item.get("displayToken"), item.get("token"), item.get("tokenTitle"), *item_aliases]:
            alias_key = normalize_lookup_token(alias)
            if alias_key:
                merged["_presentAliasKeys"].add(alias_key)

    finalized_rows: list[dict] = []
    for row in merged_rows.values():
        present_alias_keys = row.get("_presentAliasKeys")
        group_aliases = row.get("_groupAliases")
        canonical_key = row.get("_canonicalKey")
        ordered_aliases: list[str] = [normalize_text(row.get("displayToken"))]
        if isinstance(group_aliases, list) and isinstance(present_alias_keys, set):
            for alias in group_aliases:
                alias_text = normalize_text(alias)
                alias_key = normalize_lookup_token(alias_text)
                if not alias_text or alias_key == canonical_key:
                    continue
                if alias_key in present_alias_keys and alias_text not in ordered_aliases:
                    ordered_aliases.append(alias_text)
        row["aliases"] = ordered_aliases
        row["tokenTitle"] = "+".join(ordered_aliases)
        peak_bucket_key, peak_bucket_count = find_peak_bucket(row.get("bucketCounts"))
        row["peakBucketKey"] = peak_bucket_key
        row["peakBucketLabel"] = format_bucket_label(peak_bucket_key, bucket_minutes) if peak_bucket_key else "-"
        row["peakBucketCount"] = peak_bucket_count
        row["peakDate"] = peak_bucket_key[:10] if len(peak_bucket_key) >= 10 else ""
        row.pop("_canonicalKey", None)
        row.pop("_presentAliasKeys", None)
        row.pop("_groupAliases", None)
        finalized_rows.append(row)

    rows = passthrough_rows + finalized_rows
    rows.sort(
        key=lambda item: (
            -int(item.get("count") or 0),
            normalize_lookup_token(item.get("displayToken")),
            normalize_lookup_token(item.get("tokenTitle")),
        )
    )
    return [{**row, "rank": index} for index, row in enumerate(rows, start=1)]


def is_public_word_excluded(item: dict, excluded_words: set[str]) -> bool:
    if not excluded_words:
        return False
    aliases = item.get("aliases") if isinstance(item.get("aliases"), list) else []
    candidates = [
        item.get("displayToken"),
        item.get("token"),
        item.get("tokenTitle"),
        *aliases,
    ]
    return any(normalize_lookup_token(candidate) in excluded_words for candidate in candidates)


def copy_game_assets_and_build_lookup() -> dict[str, dict[str, str]]:
    lookup: dict[str, dict[str, str]] = {}
    if not GAME_IMAGE_DIR.exists():
        return lookup
    dst_dir = DOCS_ASSET_DIR / "game"
    dst_dir.mkdir(parents=True, exist_ok=True)
    for path in GAME_IMAGE_DIR.iterdir():
        suffix = path.suffix.lower()
        if not path.is_file() or suffix not in (SUPPORTED_IMAGE_SUFFIXES | SUPPORTED_VIDEO_SUFFIXES):
            continue
        lookup_key = normalize_lookup_token(path.stem)
        if not lookup_key:
            continue
        content_hash = hashlib.sha256(path.read_bytes()).hexdigest()[:12]
        dst_name = f"token-{content_hash}{suffix}"
        shutil.copy2(path, dst_dir / dst_name)
        lookup[lookup_key] = {
            "url": f"./assets/game/{dst_name}",
            "kind": "video" if suffix in SUPPORTED_VIDEO_SUFFIXES else "image",
        }
    return lookup


def find_game_media_payload(item: dict, media_lookup: dict[str, dict[str, str]]) -> dict[str, str]:
    aliases = item.get("aliases") if isinstance(item.get("aliases"), list) else []
    for candidate in [item.get("displayToken"), item.get("token"), item.get("tokenTitle"), *aliases]:
        key = normalize_lookup_token(candidate)
        if key and key in media_lookup:
            return dict(media_lookup[key])
    item_id = normalize_text(item.get("id"))
    if item_id:
        return {"url": f"./assets/game/generated/{quote(item_id)}.svg", "kind": "image"}
    return {"url": "./assets/game/generated/fallback.svg", "kind": "image"}


def build_generated_game_palette(seed: str) -> tuple[str, str, str]:
    palettes = [
        ("#22140f", "#7a432f", "#f7c89a"),
        ("#101828", "#32507a", "#e2ecff"),
        ("#1b1026", "#6840a5", "#efe1ff"),
        ("#11211d", "#1d7b69", "#d7fff2"),
        ("#261612", "#9e5a33", "#ffe1c7"),
        ("#171726", "#4657ad", "#edf0ff"),
    ]
    digest = hashlib.sha256(seed.encode("utf-8")).hexdigest()
    return palettes[int(digest[:2], 16) % len(palettes)]


def write_generated_game_placeholders(game_payload: dict) -> None:
    generated_dir = DOCS_ASSET_DIR / "game" / "generated"
    generated_dir.mkdir(parents=True, exist_ok=True)

    fallback_path = generated_dir / "fallback.svg"
    fallback_path.write_text(
        (
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 1200">'
            '<rect width="1200" height="1200" fill="#151515"/>'
            '<circle cx="920" cy="220" r="240" fill="#8b5cf6" opacity="0.2"/>'
            '<circle cx="240" cy="930" r="320" fill="#f59e0b" opacity="0.14"/>'
            '<text x="96" y="930" fill="#f6f0ea" font-size="112" font-family="Noto Sans KR, Noto Sans, sans-serif" '
            'font-weight="700">Replace</text>'
            '<text x="96" y="1035" fill="#b9b2aa" font-size="52" font-family="Noto Sans KR, Noto Sans, sans-serif">'
            'Add token image files in game_images/ to override this poster.</text>'
            "</svg>"
        ),
        encoding="utf-8",
    )

    for item in list(game_payload.get("items") or []):
        media_url = normalize_text(item.get("mediaUrl"))
        media_kind = normalize_text(item.get("mediaKind"), "image")
        if media_kind != "image" or not media_url.startswith("./assets/game/generated/"):
            continue
        display_token_value = normalize_text(item.get("displayToken"), "CHAT")
        token_title = normalize_text(item.get("tokenTitle"), display_token_value)
        count = int(item.get("count") or 0)
        rank = int(item.get("rank") or 0)
        seed = normalize_lookup_token(item.get("id") or display_token_value)
        base_color, accent_color, text_color = build_generated_game_palette(seed)
        file_name = Path(media_url).name
        output_path = generated_dir / file_name
        output_path.write_text(
            (
                '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 1200">'
                f'<rect width="1200" height="1200" fill="{base_color}"/>'
                f'<circle cx="960" cy="260" r="290" fill="{accent_color}" opacity="0.28"/>'
                f'<circle cx="260" cy="930" r="340" fill="{text_color}" opacity="0.08"/>'
                f'<rect x="70" y="70" width="1060" height="1060" rx="54" fill="none" stroke="{text_color}" opacity="0.12"/>'
                f'<text x="96" y="190" fill="{text_color}" opacity="0.72" font-size="42" '
                'font-family="Noto Sans KR, Noto Sans, sans-serif">MONTHLY RECAP GAME</text>'
                f'<text x="96" y="760" fill="{text_color}" font-size="166" font-family="Noto Sans KR, Noto Sans, sans-serif" '
                f'font-weight="800">{display_token_value}</text>'
                f'<text x="96" y="860" fill="{text_color}" opacity="0.78" font-size="54" '
                f'font-family="Noto Sans KR, Noto Sans, sans-serif">{token_title}</text>'
                f'<text x="96" y="1015" fill="{text_color}" opacity="0.92" font-size="70" '
                f'font-family="Noto Sans KR, Noto Sans, sans-serif" font-weight="700">{count:,} chats</text>'
                f'<text x="915" y="1015" text-anchor="end" fill="{text_color}" opacity="0.52" font-size="86" '
                f'font-family="Noto Sans KR, Noto Sans, sans-serif" font-weight="800">#{rank}</text>'
                "</svg>"
            ),
            encoding="utf-8",
        )


def build_public_top_words(search_items: list[dict], excluded_words: set[str], limit: int = 20) -> list[dict]:
    rows: list[dict] = []
    for item in search_items:
        if not isinstance(item, dict) or is_public_word_excluded(item, excluded_words):
            continue
        token = normalize_text(item.get("token"))
        display = normalize_text(item.get("displayToken"), token)
        if not token or not display:
            continue
        rows.append(
            {
                "token": token,
                "displayToken": display,
                "tokenTitle": normalize_text(item.get("tokenTitle"), token),
                "count": int(item.get("count") or 0),
                "ratio": float(item.get("ratio") or 0.0),
                "imageUrl": "",
            }
        )
        if len(rows) >= limit:
            break
    return rows


def build_public_game_payload(report_paths: list[Path], media_lookup: dict[str, dict[str, str]]) -> dict:
    merge_groups = parse_public_word_merges()
    excluded_words = parse_public_word_excludes()
    game_excluded_words = parse_public_game_excludes()
    curated_game_words = parse_public_game_words()
    aggregate_rows: dict[str, dict] = {}
    source_labels: list[str] = []
    total_count = 0

    for path in sorted(report_paths):
        payload = load_payload(path)
        label = normalize_text(payload.get("label"), path.stem)
        if label and label not in source_labels:
            source_labels.append(label)
        summary = payload.get("summary") if isinstance(payload.get("summary"), dict) else {}
        advanced = summary.get("advancedInsights") if isinstance(summary.get("advancedInsights"), dict) else {}
        bucket_minutes = int(advanced.get("bucketMinutes") or 2)
        search_items = build_word_search_items(summary, bucket_minutes)
        search_items = merge_public_search_items(search_items, merge_groups, bucket_minutes)

        for item in search_items:
            if not isinstance(item, dict) or is_public_word_excluded(item, excluded_words):
                continue
            display_token_value = normalize_text(item.get("displayToken"), item.get("token"))
            lookup_key = normalize_lookup_token(display_token_value)
            count = int(item.get("count") or 0)
            if not lookup_key or count <= 0:
                continue

            total_count += count
            row = aggregate_rows.get(lookup_key)
            if row is None:
                row = {
                    "id": lookup_key,
                    "displayToken": display_token_value,
                    "tokenTitle": normalize_text(item.get("tokenTitle"), display_token_value),
                    "count": 0,
                    "aliases": [],
                    "monthCounts": {},
                }
                aggregate_rows[lookup_key] = row

            row["count"] += count
            row["monthCounts"][label] = int(row["monthCounts"].get(label) or 0) + count
            merge_text_list(row["aliases"], [display_token_value, *(item.get("aliases") or [])])
            if len(normalize_text(item.get("tokenTitle"))) > len(normalize_text(row.get("tokenTitle"))):
                row["tokenTitle"] = normalize_text(item.get("tokenTitle"), row["tokenTitle"])

    all_rows: list[dict] = []
    for item in aggregate_rows.values():
        aliases = list(item.get("aliases") or [])
        if aliases:
            item["tokenTitle"] = "+".join(aliases)
        else:
            item["tokenTitle"] = normalize_text(item.get("tokenTitle"), item.get("displayToken"))
        count = int(item.get("count") or 0)
        month_breakdown = [
            {
                "label": format_issue_label(label),
                "count": int(item.get("monthCounts", {}).get(label) or 0),
            }
            for label in source_labels
            if int(item.get("monthCounts", {}).get(label) or 0) > 0
        ]
        media_payload = find_game_media_payload(item, media_lookup)
        all_rows.append(
            {
                "id": normalize_text(item.get("id")),
                "displayToken": normalize_text(item.get("displayToken")),
                "tokenTitle": normalize_text(item.get("tokenTitle"), item.get("displayToken")),
                "count": count,
                "ratio": ((count / total_count) * 100.0) if total_count > 0 else 0.0,
                "monthBreakdown": month_breakdown,
                "mediaUrl": normalize_text(media_payload.get("url")),
                "mediaKind": normalize_text(media_payload.get("kind"), "image"),
            }
        )

    all_rows.sort(
        key=lambda item: (
            -int(item.get("count") or 0),
            normalize_lookup_token(item.get("displayToken")),
        )
    )

    for index, row in enumerate(all_rows, start=1):
        row["rank"] = index

    if curated_game_words:
        rows_by_id = {
            normalize_lookup_token(row.get("id") or row.get("displayToken")): row
            for row in all_rows
        }
        rows = [
            rows_by_id[word_key]
            for word_key in curated_game_words
            if word_key in rows_by_id
        ]
    else:
        rows = [
            row
            for row in all_rows
            if int(row.get("count") or 0) >= PUBLIC_GAME_MIN_COUNT
            and not is_public_word_excluded(row, game_excluded_words)
        ]

    issue_labels = [format_issue_label(label) for label in source_labels if format_issue_label(label)]
    return {
        "title": "더 많이 더 적게",
        "subtitle": "전체 월간 로그 채팅 단어 게임",
        "issueLabel": " + ".join(issue_labels),
        "sourceIssues": issue_labels,
        "items": rows[:140],
    }


def build_content_version() -> str:
    hasher = hashlib.sha256()
    for path in [
        Path(__file__),
        PUBLIC_WORD_EXCLUDE_PATH,
        PUBLIC_WORD_MERGES_PATH,
        PUBLIC_GAME_EXCLUDE_PATH,
        PUBLIC_GAME_WORDS_PATH,
        WORD_SEARCH_EXAMPLES_PATH,
    ]:
        hasher.update(path.name.encode("utf-8"))
        if path.exists():
            hasher.update(path.read_bytes())
    return hasher.hexdigest()[:8]


def build_report_file_suffix(index: int, payload: dict, content_version: str) -> str:
    label = normalize_text(payload.get("label"), f"report-{index:03d}")
    normalized_label = re.sub(r"[^0-9A-Za-z._-]+", "-", label).strip("-") or f"report-{index:03d}"
    generated_at = normalize_text(payload.get("generatedAt"))
    generated_stamp = re.sub(r"[^0-9]", "", generated_at)[:14]
    if not generated_stamp:
        generated_stamp = f"{index:03d}"
    return f"{normalized_label}-{generated_stamp}-{content_version}"


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
    search_items = build_word_search_items(summary, bucket_minutes)
    search_items = merge_public_search_items(search_items, parse_public_word_merges(), bucket_minutes)
    top_words = build_public_top_words(search_items, parse_public_word_excludes(), limit=20)
    top_emotes = trim_ranked_rows(summary.get("topEmotes"), limit=20, token_type="emote")
    legend_rows = [
        build_moment(row, bucket_minutes)
        for row in list(highlights.get("legendTopMoments") or [])[:5]
        if isinstance(row, dict)
    ]
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
    (DOCS_ASSET_DIR / "game").mkdir(parents=True, exist_ok=True)
    (DOCS_ASSET_DIR / "game" / "generated").mkdir(parents=True, exist_ok=True)


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
    GAME_IMAGE_DIR.mkdir(parents=True, exist_ok=True)
    copy_static_assets()
    copy_asset_folder(VIDEO_DIR, DOCS_ASSET_DIR / "video")
    copy_asset_folder(SOUND_DIR, DOCS_ASSET_DIR / "sound")
    media_lookup = copy_game_assets_and_build_lookup()
    (DOCS_DIR / ".nojekyll").write_text("", encoding="utf-8")

    reports_index: list[dict] = []
    content_version = build_content_version()
    report_paths = list_report_paths()
    for index, path in enumerate(report_paths, start=1):
        payload = load_payload(path)
        file_suffix = build_report_file_suffix(index, payload, content_version)
        report_file = f"report-{file_suffix}.json"
        word_search_file = f"search-{file_suffix}.json"
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
    game_payload = build_public_game_payload(report_paths, media_lookup)
    write_generated_game_placeholders(game_payload)
    game_file = f"game-{content_version}.json"
    write_json(DOCS_DATA_DIR / game_file, game_payload)
    write_json(
        DOCS_DATA_DIR / "reports.json",
        {
            "reports": reports_index,
            "gameFile": f"./data/{game_file}",
            "heroVideos": [f"./assets/video/{quote(path.name)}" for path in list_hero_video_paths()],
            "gameAudio": build_game_audio_manifest(),
        },
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="GitHub Pages용 월간 재첩 정적 사이트 빌드")
    return parser.parse_args()


if __name__ == "__main__":
    parse_args()
    build_site()
    print(f"Built static site into: {DOCS_DIR}")
