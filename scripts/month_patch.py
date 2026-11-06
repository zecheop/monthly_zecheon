"""월간 로그에 방송 1개를 더하거나 빼는 도구 (sign=+1 더하기, -1 빼기).

월이 바뀐 뒤에 올라온 지난달 방송을 지난달 로그에 넣을 때 쓴다.
analysis_logs 의 mergeAggregates / advancedInsights 는 전부 '더할 수 있는 카운터'라서 방송 하나의
분석 결과를 부호만 바꿔 더하면 빼기도 된다. sections, legendMoments, userPropensities,
streamerHighlights, 비교 라벨 같은 파생값은 분석기의 원래 함수로 다시 계산한다.
삭제된 다시보기는 다시 수집할 수 없어서 월 로그 전체를 새로 만드는 대신 이 방식으로 고친다.
"""
import copy
from collections import Counter
from contextlib import contextmanager

import analyze_chzzk_vod_chat as A  # noqa: E402

TOP_N = 20


def add_counter(a, b, sign):
    out = Counter()
    for k, v in (a or {}).items():
        out[k] += v
    for k, v in (b or {}).items():
        out[k] += sign * v
    return {k: v for k, v in out.items() if v > 0}


def add_nested(a, b, sign):
    out = {}
    for k in set(a or {}) | set(b or {}):
        m = add_counter((a or {}).get(k), (b or {}).get(k), sign)
        if m:
            out[k] = m
    return out


def patch_aggregate(agg, vagg, sign):
    out = dict(agg)
    out['messageCount'] = int(agg.get('messageCount') or 0) + sign * int(vagg.get('messageCount') or 0)
    for key in ('messageKinds', 'wordCounts', 'emoteCounts', 'chatterCounts', 'dateCounts'):
        out[key] = add_counter(agg.get(key), vagg.get(key), sign)
    for key in ('wordDayCounts', 'emoteDayCounts'):
        out[key] = add_nested(agg.get(key), vagg.get(key), sign)
    urls = dict(agg.get('emoteUrls') or {})
    for k, v in (vagg.get('emoteUrls') or {}).items():
        urls.setdefault(k, v)
    out['emoteUrls'] = urls
    return out


def patch_token_stats(ts, vts, sign):
    out = copy.deepcopy(ts)
    for key, vs in vts.items():
        cur = out.get(key)
        if cur is None:
            if sign < 0:
                continue
            cur = {'token': vs.get('token'), 'type': vs.get('type'), 'count': 0, 'dayCounts': {}, 'bucketCounts': {}}
            out[key] = cur
        cur['count'] = int(cur.get('count') or 0) + sign * int(vs.get('count') or 0)
        cur['dayCounts'] = add_counter(cur.get('dayCounts'), vs.get('dayCounts'), sign)
        cur['bucketCounts'] = add_counter(cur.get('bucketCounts'), vs.get('bucketCounts'), sign)
        if vs.get('imageUrl') and not cur.get('imageUrl'):
            cur['imageUrl'] = vs['imageUrl']
        if cur['count'] <= 0:
            del out[key]
    return out


def patch_profiles(up, vup, sign, video_no):
    out = copy.deepcopy(up)
    for nick, vp in vup.items():
        cur = out.get(nick)
        if cur is None:
            if sign < 0:
                continue
            cur = {'messageCount': 0, 'categoryCounts': {k: 0 for k in A.ANALYZABLE_CATEGORIES},
                   'wordCounts': {}, 'emoteCounts': {}, 'messagesWithEmotes': 0,
                   'donationAmount': 0, 'dates': {}, 'videoNos': [], 'userIds': {}}
            out[nick] = cur
        cur['messageCount'] = int(cur.get('messageCount') or 0) + sign * int(vp.get('messageCount') or 0)
        cur['messagesWithEmotes'] = int(cur.get('messagesWithEmotes') or 0) + sign * int(vp.get('messagesWithEmotes') or 0)
        if 'donationAmount' in cur or vp.get('donationAmount'):
            cur['donationAmount'] = int(cur.get('donationAmount') or 0) + sign * int(vp.get('donationAmount') or 0)
        cc = dict(cur.get('categoryCounts') or {})
        for k in set(cc) | set(vp.get('categoryCounts') or {}):
            cc[k] = int(cc.get(k) or 0) + sign * int((vp.get('categoryCounts') or {}).get(k) or 0)
        cur['categoryCounts'] = cc
        cur['wordCounts'] = add_counter(cur.get('wordCounts'), vp.get('wordCounts'), sign)
        cur['emoteCounts'] = add_counter(cur.get('emoteCounts'), vp.get('emoteCounts'), sign)
        cur['dates'] = add_counter(cur.get('dates'), vp.get('dates'), sign)
        if vp.get('userIds') or 'userIds' in cur:
            cur['userIds'] = add_counter(cur.get('userIds'), vp.get('userIds'), sign)
        nos = set(cur.get('videoNos') or [])
        if sign > 0:
            nos.add(video_no)
        else:
            nos.discard(video_no)
        cur['videoNos'] = sorted(nos)
        if cur['messageCount'] <= 0:
            del out[nick]
    return out


def patch_token_relations(tr, vtr, sign):
    out = {k: dict(v) for k, v in (tr or {}).items()}
    for key, rel in (vtr or {}).items():
        cur = add_counter(out.get(key), rel, sign)
        if cur:
            out[key] = cur
        else:
            out.pop(key, None)
    return out


def derive_collection_stats(videos):
    stats = {'completeVideoCount': 0, 'partialVideoCount': 0, 'failedVideoCount': 0,
             'resumedVideoCount': 0, 'cachedVideoCount': 0}
    for v in videos:
        status = v.get('collectionStatus')
        if status == 'complete':
            stats['completeVideoCount'] += 1
        elif status == 'partial':
            stats['partialVideoCount'] += 1
        elif status == 'failed':
            stats['failedVideoCount'] += 1
        if v.get('resumedFromCheckpoint'):
            stats['resumedVideoCount'] += 1
        if v.get('usedCachedMessages'):
            stats['cachedVideoCount'] += 1
    return stats


def patch_summary(summary, vsum, sign, video_entry=None):
    """summary: 월 로그의 summary. vsum: 방송 1개짜리 analyze 결과. 새 summary 반환."""
    s = copy.deepcopy(summary)
    vno = int(vsum['videos'][0]['videoNo'])
    for k in ('messageCount', 'totalCollectedMessageCount', 'excludedSystemMessageCount'):
        s[k] = int(s.get(k) or 0) + sign * int(vsum.get(k) or 0)
    cc = dict(s.get('categoryCounts') or {})
    for k in set(cc) | set(vsum.get('categoryCounts') or {}):
        cc[k] = int(cc.get(k) or 0) + sign * int((vsum.get('categoryCounts') or {}).get(k) or 0)
    s['categoryCounts'] = cc

    # videos
    videos = [v for v in s['videos'] if int(v['videoNo']) != vno]
    if sign > 0:
        videos.append(copy.deepcopy(video_entry or vsum['videos'][0]))
    videos.sort(key=lambda v: v.get('publishDateAt') or 0, reverse=True)
    s['videos'] = videos
    s['videoCount'] = len(videos)
    s['collectionStats'] = derive_collection_stats(videos)

    # mergeAggregates + sections
    ma = {}
    for key in ('all', 'chat', 'donation'):
        ma[key] = patch_aggregate(s['mergeAggregates'][key], vsum['mergeAggregates'][key], sign)
    s['mergeAggregates'] = ma
    s['sections'] = {key: A.aggregate_to_section(agg, TOP_N) for key, agg in ma.items()}
    primary = s['sections'][s['primarySection']]
    s['messageKinds'] = primary['messageKinds']
    s['topWords'] = primary['topWords']
    s['topEmotes'] = primary['topEmotes']
    s['topChatters'] = primary['topChatters']

    # advancedInsights
    adv = dict(s['advancedInsights'])
    vadv = vsum['advancedInsights']
    adv['tokenStats'] = patch_token_stats(adv.get('tokenStats') or {}, vadv.get('tokenStats') or {}, sign)
    adv['tokenRelations'] = patch_token_relations(adv.get('tokenRelations'), vadv.get('tokenRelations'), sign)
    adv['dailyMessageBuckets'] = add_nested(adv.get('dailyMessageBuckets'), vadv.get('dailyMessageBuckets'), sign)
    adv['userProfiles'] = patch_profiles(adv.get('userProfiles') or {}, vadv.get('userProfiles') or {}, sign, vno)
    vbuckets = {b for d in (vadv.get('dailyMessageBuckets') or {}).values() for b in d}
    rows = [r for r in (adv.get('bucketHighlights') or []) if r.get('bucketKey') not in vbuckets]
    if sign > 0:
        rows.extend(copy.deepcopy(vadv.get('bucketHighlights') or []))
    rows.sort(key=lambda r: (float(r.get('highlightScore') or 0), int(r.get('count') or 0), r.get('bucketKey') or ''), reverse=True)
    if sign > 0:
        rows = sorted(rows, key=lambda r: int(r.get('count') or 0), reverse=True)[:A.STREAMER_BUCKET_HIGHLIGHT_LIMIT]
        rows.sort(key=lambda r: (float(r.get('highlightScore') or 0), int(r.get('count') or 0), r.get('bucketKey') or ''), reverse=True)
    adv['bucketHighlights'] = rows
    md = [m for m in (adv.get('missionDonations') or []) if int(m.get('videoNo') or 0) != vno]
    if sign > 0:
        md.extend(copy.deepcopy(vadv.get('missionDonations') or []))
        md.sort(key=lambda m: m.get('timestamp') or 0)
    adv['missionDonations'] = md
    for k in ('wordVariantMap',):
        if sign > 0:
            merged = dict(adv.get(k) or {})
            merged.update(vadv.get(k) or {})
            adv[k] = merged
    if sign > 0:
        lk = dict(adv.get('lookup') or {})
        for part in ('word', 'emote'):
            d = dict(lk.get(part) or {})
            d.update((vadv.get('lookup') or {}).get(part) or {})
            lk[part] = d
        adv['lookup'] = lk
    adv['legendMoments'] = A.build_daily_legend_rows(adv['dailyMessageBuckets'], bucket_minutes=adv.get('bucketMinutes') or A.TIME_BUCKET_MINUTES)
    emote_urls = {i.get('token'): i.get('imageUrl') for i in adv['tokenStats'].values() if i.get('type') == 'emote' and i.get('imageUrl')}
    adv['userPropensities'] = A.build_user_propensity_rows(adv['userProfiles'], emote_urls)
    s['advancedInsights'] = adv
    s = A.attach_streamer_highlights(s)
    s = A.apply_monthly_video_comparisons(s)
    return s


@contextmanager
def month_word_map(token_map):
    """분석기가 단어 정규화 지도를 월 전체 채팅으로 만들기 때문에, 방송 1개만 분석할 때는
    그 달 로그에 저장된 지도를 그대로 쓰게 해서 기존 단어 집계와 맞춘다."""
    original = A.build_word_normalization_profile
    mapping = dict(token_map or {})
    A.build_word_normalization_profile = lambda messages, stopwords: {
        "tokenMap": mapping,
        "variantMap": mapping,
        "normalizedVariantCount": len(mapping),
        "examples": [],
    }
    try:
        yield
    finally:
        A.build_word_normalization_profile = original


def analyze_video_for_month(session, video, month_summary, *, timeout, stopwords, custom_word_groups=""):
    token_map = (month_summary.get("advancedInsights") or {}).get("wordVariantMap") or {}
    with month_word_map(token_map):
        return A.analyze_video_set(
            session=session,
            videos=[video],
            timeout=timeout,
            top_n=TOP_N,
            stopwords=stopwords,
            include_non_chat=False,
            selected_categories=None,
            custom_excluded_words=None,
            custom_word_groups=custom_word_groups,
        )
