#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Iterable, Optional
from zoneinfo import ZoneInfo


KST = ZoneInfo("Asia/Seoul")
BASE_DIR = Path(__file__).resolve().parents[1]
ANALYZER_ROOT = BASE_DIR.parent / "chzzk-chat-analyzer"
ANALYSIS_LOG_DIR = ANALYZER_ROOT / "analysis_logs"

if str(ANALYZER_ROOT) not in sys.path:
    sys.path.insert(0, str(ANALYZER_ROOT))

from analyze_chzzk_vod_chat import (  # type: ignore
    DEFAULT_USER_AGENT,
    analyze_video_set,
    apply_monthly_video_comparisons,
    apply_previous_period_comparisons,
    build_calendar_analysis_period,
    build_session,
    fetch_videos_in_date_range,
    load_all_mergeable_log_payloads,
    resolve_channel_name,
    save_mergeable_log,
)
from web_app import load_web_ui_preferences, resolve_python_session  # type: ignore


@dataclass
class RefreshResult:
    updated: bool
    built: bool
    pushed: bool
    message: str
    log_path: Optional[Path] = None


def run_command(
    args: list[str],
    *,
    cwd: Path,
    capture_output: bool = True,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args,
        cwd=str(cwd),
        text=True,
        capture_output=capture_output,
        check=check,
    )


def get_repo_status_lines(repo_dir: Path) -> list[str]:
    result = run_command(["git", "status", "--short"], cwd=repo_dir)
    return [line for line in result.stdout.splitlines() if line.strip()]


def ensure_pages_repo_clean() -> None:
    status_lines = get_repo_status_lines(BASE_DIR)
    if status_lines:
        raise RuntimeError(
            "chzzk-streamer-pages 저장소에 커밋되지 않은 변경이 있어 자동 반영을 중단합니다.\n"
            + "\n".join(status_lines)
        )


def month_label_from(dt: datetime) -> str:
    return dt.strftime("%Y-%m")


def month_date_range(dt: datetime) -> tuple[str, str]:
    return dt.strftime("%Y-%m-01"), dt.strftime("%Y-%m-%d")


def find_latest_month_log(month_label: str) -> Optional[Path]:
    candidates = sorted(ANALYSIS_LOG_DIR.glob(f"chzzk-merge-log-*-{month_label}-*.json"))
    return candidates[-1] if candidates else None


def load_logged_video_numbers(log_path: Optional[Path]) -> set[int]:
    if not log_path or not log_path.exists():
        return set()
    try:
        payload = json.loads(log_path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return set()
    videos = ((payload.get("summary") or {}).get("videos") or [])
    video_numbers: set[int] = set()
    for row in videos:
        try:
            value = int(row.get("videoNo"))
        except (TypeError, ValueError, AttributeError):
            continue
        video_numbers.add(value)
    return video_numbers


def normalize_video_numbers(videos: Iterable[dict]) -> set[int]:
    numbers: set[int] = set()
    for row in videos:
        try:
            value = int(row.get("videoNo"))
        except (TypeError, ValueError, AttributeError):
            continue
        numbers.add(value)
    return numbers


def detect_new_current_month_videos(*, force: bool = False) -> tuple[dict, list[dict], set[int], set[int]]:
    now = datetime.now(KST)
    month_label = month_label_from(now)
    date_from, date_to = month_date_range(now)
    channel_id, _, timeout = resolve_python_session()
    session = build_session(os.getenv("USER_AGENT", DEFAULT_USER_AGENT))
    videos = fetch_videos_in_date_range(
        session=session,
        channel_id=channel_id,
        date_from=date_from,
        date_to=date_to,
        max_videos=200,
        timeout=timeout,
    )
    latest_log = find_latest_month_log(month_label)
    existing_video_numbers = load_logged_video_numbers(latest_log)
    current_video_numbers = normalize_video_numbers(videos)
    unseen_video_numbers = current_video_numbers - existing_video_numbers
    metadata = {
        "monthLabel": month_label,
        "dateFrom": date_from,
        "dateTo": date_to,
        "channelId": channel_id,
        "timeout": timeout,
        "latestLog": latest_log,
        "force": force,
    }
    return metadata, videos, existing_video_numbers, unseen_video_numbers


def build_current_month_log(metadata: dict, videos: list[dict]) -> Path:
    channel_id = metadata["channelId"]
    timeout = int(metadata["timeout"])
    session = build_session(os.getenv("USER_AGENT", DEFAULT_USER_AGENT))
    _, stopwords, _ = resolve_python_session()
    saved_preferences = load_web_ui_preferences()
    custom_word_groups = saved_preferences.get("customWordGroups") or ""
    channel_name = resolve_channel_name(
        channel_id,
        session=session,
        timeout=timeout,
        sources=videos,
    )
    summary = analyze_video_set(
        session=session,
        videos=videos,
        timeout=timeout,
        top_n=20,
        stopwords=stopwords,
        include_non_chat=False,
        selected_categories=None,
        custom_excluded_words=None,
        custom_word_groups=custom_word_groups,
    )
    summary["analysisPeriod"] = build_calendar_analysis_period(
        metadata["dateFrom"],
        metadata["dateTo"],
        kind="monthly_archive",
    )
    summary = apply_monthly_video_comparisons(summary)
    summary = apply_previous_period_comparisons(
        summary,
        load_all_mergeable_log_payloads(str(ANALYZER_ROOT)),
    )
    return save_mergeable_log(
        summary,
        str(ANALYZER_ROOT),
        channel_id=channel_id,
        channel_name=channel_name,
        label=metadata["monthLabel"],
        date_from=metadata["dateFrom"],
        date_to=metadata["dateTo"],
        saved_result_anonymized_top_chatters=False,
    )


def build_pages_site() -> None:
    run_command([sys.executable, "build_site_data.py"], cwd=BASE_DIR, capture_output=True)


def docs_have_changes() -> bool:
    result = run_command(["git", "status", "--short", "--", "docs"], cwd=BASE_DIR)
    return bool(result.stdout.strip())


def stage_commit_push_docs(month_label: str, *, dry_run: bool = False) -> bool:
    if not docs_have_changes():
        return False
    if dry_run:
        return True
    run_command(["git", "add", "docs"], cwd=BASE_DIR)
    staged_diff = subprocess.run(
        ["git", "diff", "--cached", "--quiet"],
        cwd=str(BASE_DIR),
    )
    if staged_diff.returncode == 0:
        return False
    run_command(
        ["git", "commit", "-m", f"Auto-update monthly report for {month_label}"],
        cwd=BASE_DIR,
    )
    run_command(["git", "push", "origin", "main"], cwd=BASE_DIR)
    return True


def refresh_monthly_pipeline(*, force: bool = False, dry_run: bool = False, allow_dirty: bool = False) -> RefreshResult:
    if not allow_dirty:
        ensure_pages_repo_clean()
    metadata, videos, existing_video_numbers, unseen_video_numbers = detect_new_current_month_videos(force=force)
    month_label = metadata["monthLabel"]
    if not videos:
        return RefreshResult(False, False, False, f"{month_label}에는 아직 분석 가능한 다시보기가 없습니다.")
    if existing_video_numbers and not unseen_video_numbers and not force:
        return RefreshResult(False, False, False, f"{month_label} 로그에 새 다시보기가 없어 건너뜁니다.")

    log_path = build_current_month_log(metadata, videos)
    build_pages_site()
    live_changed = stage_commit_push_docs(month_label, dry_run=dry_run)
    if dry_run and live_changed:
        return RefreshResult(
            True,
            True,
            False,
            f"{month_label} 로그를 갱신했고, 라이브 페이지에도 반영될 변경이 있습니다. (--dry-run)",
            log_path=log_path,
        )
    if live_changed:
        return RefreshResult(
            True,
            True,
            True,
            f"{month_label} 로그와 라이브 페이지를 새 다시보기 기준으로 갱신했습니다.",
            log_path=log_path,
        )
    return RefreshResult(
        True,
        True,
        False,
        f"{month_label} 로그는 갱신했지만, 라이브 페이지에는 변경이 없어 푸시는 생략했습니다.",
        log_path=log_path,
    )


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="임재천 월간 로그와 GitHub Pages 라이브 사이트를 자동 갱신합니다.")
    parser.add_argument("--force", action="store_true", help="새 다시보기가 없어도 현재 달 로그를 강제로 다시 만듭니다.")
    parser.add_argument("--dry-run", action="store_true", help="로그/사이트를 갱신하되 커밋과 푸시는 하지 않습니다.")
    parser.add_argument("--allow-dirty", action="store_true", help="테스트용으로 pages 저장소 변경 감지를 무시합니다.")
    return parser


def main() -> int:
    parser = build_arg_parser()
    args = parser.parse_args()
    try:
        result = refresh_monthly_pipeline(
            force=bool(args.force),
            dry_run=bool(args.dry_run),
            allow_dirty=bool(args.allow_dirty),
        )
    except Exception as exc:
        print(f"[auto-refresh] 실패: {exc}", file=sys.stderr)
        return 1
    print(f"[auto-refresh] {result.message}")
    if result.log_path:
        print(f"[auto-refresh] 로그 파일: {result.log_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
