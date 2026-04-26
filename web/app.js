const state = {
  reports: [],
  currentReportId: '',
  currentReport: null,
  currentView: 'summary',
  reportPickerOpen: false,
  searchCache: new Map(),
  hasLoadedReport: false,
  gameFile: '',
  gameData: null,
  gameError: '',
  gameSession: null,
  gameBestScore: 0,
  heroVideos: [],
  currentHeroVideo: '',
  brandAssets: {},
  summaryOverview: null,
  gameAudio: {},
  pendingRoundAudioToken: '',
  gameMediaMuted: true,
  gamePausedTokenIds: new Set(),
  gameTransitionTimer: null,
};

const openReportPickerEl = document.getElementById('open-report-picker');
const heroIssueEl = document.getElementById('hero-issue');
const reportPickerEl = document.getElementById('report-picker');
const archiveListEl = document.getElementById('archive-list');
const loadingPanelEl = document.getElementById('loading-panel');
const errorPanelEl = document.getElementById('error-panel');
const summaryRootEl = document.getElementById('summary-root');
const reportRootEl = document.getElementById('report-root');
const gameRootEl = document.getElementById('game-root');
const navTabEls = Array.from(document.querySelectorAll('[data-view-tab]'));
const heroVideoEl = document.getElementById('hero-video');
const HERO_VIDEO_STORAGE_KEY = 'monthly-zecheon-last-hero-video';
const REPORT_STORAGE_KEY = 'monthly-zecheon-last-report-id';
const SUMMARY_SCROLL_LOCK_MS = 620;
const GAME_VIDEO_AUDIBLE_VOLUME = 0.58;
const GAME_VIDEO_FADE_IN_MS = 360;
const GAME_VIDEO_FADE_OUT_MS = 220;
const GAME_VIDEO_FEEDBACK_MS = 880;
const gameVideoFadeFrames = new WeakMap();
const gameVideoFeedbackTimers = new WeakMap();
const gameVideoAudibleRetryTimers = new WeakMap();

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || '요청을 처리하지 못했습니다.');
  }
  return data;
}

function formatNumber(value) {
  const num = Number(value || 0);
  return Number.isFinite(num) ? num.toLocaleString('ko-KR') : '0';
}

function formatRatio(value, digits = 2) {
  const num = Number(value || 0);
  return Number.isFinite(num) ? `${num.toFixed(digits)}%` : '0.00%';
}

function formatLift(value) {
  const num = Number(value || 0);
  return Number.isFinite(num) ? `${num.toFixed(2)}배` : '0.00배';
}

function normalizeComparableText(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, '');
}

function getEmoteVisibleLabel(row, mode = 'default') {
  const label = String(row?.displayToken || row?.token || '').trim();
  if (mode === 'clip') {
    return '';
  }
  return label;
}

function getVisibleRowLabel(row, kind, mode = 'default') {
  if (kind === 'emote') {
    return getEmoteVisibleLabel(row, mode);
  }
  return String(row?.displayToken || row?.token || '').trim();
}

function pickRandomItem(items) {
  if (!Array.isArray(items) || !items.length) {
    return '';
  }
  return items[Math.floor(Math.random() * items.length)] || '';
}

function readStoredHeroVideo() {
  try {
    return String(window.sessionStorage.getItem(HERO_VIDEO_STORAGE_KEY) || '').trim();
  } catch {
    return '';
  }
}

function writeStoredHeroVideo(value) {
  try {
    window.sessionStorage.setItem(HERO_VIDEO_STORAGE_KEY, String(value || '').trim());
  } catch {}
}

function readStoredReportId() {
  try {
    return String(window.sessionStorage.getItem(REPORT_STORAGE_KEY) || '').trim();
  } catch {
    return '';
  }
}

function writeStoredReportId(value) {
  try {
    window.sessionStorage.setItem(REPORT_STORAGE_KEY, String(value || '').trim());
  } catch {}
}

function pickNextHeroVideo(videos, excluded = []) {
  const list = Array.isArray(videos)
    ? videos.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  if (!list.length) {
    return '';
  }
  const excludedSet = new Set(excluded.map((item) => String(item || '').trim()).filter(Boolean));
  const candidates = list.filter((item) => !excludedSet.has(item));
  return pickRandomItem(candidates.length ? candidates : list);
}

function playHeroVideo(src) {
  if (!(heroVideoEl instanceof HTMLVideoElement)) {
    return;
  }
  const nextSrc = String(src || '').trim();
  if (!nextSrc) {
    heroVideoEl.removeAttribute('src');
    state.currentHeroVideo = '';
    return;
  }
  state.currentHeroVideo = nextSrc;
  writeStoredHeroVideo(nextSrc);
  heroVideoEl.setAttribute('src', nextSrc);
  heroVideoEl.currentTime = 0;
  heroVideoEl.load();
  void heroVideoEl.play().catch(() => {});
}

function playNextHeroVideo() {
  const nextSrc = pickNextHeroVideo(state.heroVideos, [state.currentHeroVideo]);
  if (!nextSrc) {
    return;
  }
  playHeroVideo(nextSrc);
}

function ensureHeroVideoBindings() {
  if (!(heroVideoEl instanceof HTMLVideoElement) || heroVideoEl.dataset.heroBound === 'true') {
    return;
  }
  heroVideoEl.dataset.heroBound = 'true';
  heroVideoEl.addEventListener('ended', () => {
    playNextHeroVideo();
  });
  heroVideoEl.addEventListener('error', () => {
    playNextHeroVideo();
  });
}

function setHeroVideo(videos) {
  state.heroVideos = Array.isArray(videos)
    ? videos.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  if (!(heroVideoEl instanceof HTMLVideoElement)) {
    return;
  }
  ensureHeroVideoBindings();
  if (!state.heroVideos.length) {
    playHeroVideo('');
    return;
  }
  const storedSrc = readStoredHeroVideo();
  const selected = pickNextHeroVideo(state.heroVideos, [storedSrc]);
  playHeroVideo(selected || state.heroVideos[0]);
}

function setLoading(isLoading, message = '리포트를 준비하는 중입니다...') {
  loadingPanelEl.textContent = message;
  loadingPanelEl.classList.toggle('hidden', !isLoading);
}

function setError(message = '') {
  const text = String(message || '').trim();
  errorPanelEl.innerHTML = text ? escapeHtml(text) : '';
  errorPanelEl.classList.toggle('hidden', !text);
}

function setReportVisible(visible) {
  reportRootEl.classList.toggle('hidden', !visible);
}

function setSummaryVisible(visible) {
  summaryRootEl.classList.toggle('hidden', !visible);
}

function setGameVisible(visible) {
  gameRootEl.classList.toggle('hidden', !visible);
}

function setReportUpdating(isUpdating) {
  reportRootEl.classList.toggle('is-updating', !!isUpdating);
  summaryRootEl.classList.toggle('is-updating', !!isUpdating);
}

function updateScrollState() {
  document.body.classList.toggle('is-scrolled', window.scrollY > 20);
}

function syncBodyViewState() {
  document.body.classList.toggle('game-mode', state.currentView === 'game');
}

function formatIssueTag(sourceText) {
  const match = String(sourceText || '').match(/(\d{4})-(\d{2})/);
  if (!match) {
    return '';
  }
  return `${match[1]}.${match[2]}`;
}

function parseLocationState() {
  const rawHash = window.location.hash.replace(/^#/, '').trim();
  if (!rawHash) {
    return { view: 'summary', reportId: readStoredReportId() };
  }
  try {
    const decoded = decodeURIComponent(rawHash);
    if (decoded === 'game') {
      return { view: 'game', reportId: '' };
    }
    if (decoded === 'summary') {
      return { view: 'summary', reportId: readStoredReportId() };
    }
    if (decoded === 'stat' || decoded === 'stats') {
      return { view: 'stats', reportId: readStoredReportId() };
    }
    return { view: 'summary', reportId: readStoredReportId() };
  } catch {
    if (rawHash === 'game') {
      return { view: 'game', reportId: '' };
    }
    if (rawHash === 'summary') {
      return { view: 'summary', reportId: readStoredReportId() };
    }
    if (rawHash === 'stat' || rawHash === 'stats') {
      return { view: 'stats', reportId: readStoredReportId() };
    }
    return { view: 'summary', reportId: readStoredReportId() };
  }
}

function syncLocationHash() {
  const nextHash = state.currentView === 'game'
    ? '#game'
    : state.currentView === 'stats'
      ? '#stat'
      : '#summary';
  if (window.location.hash !== nextHash) {
    history.replaceState(null, '', nextHash || window.location.pathname);
  }
}

function updateHeroIssue() {
  const nextText = state.currentView === 'stats'
    ? formatIssueTag(`${state.currentReport?.label || ''} ${state.currentReport?.subtitle || ''}`)
    : '';
  if (!nextText) {
    heroIssueEl.textContent = '';
    heroIssueEl.classList.add('hidden');
    return;
  }
  heroIssueEl.textContent = nextText;
  heroIssueEl.classList.remove('hidden');
}

function updateHeroAction() {
  openReportPickerEl.classList.toggle('hidden', state.currentView !== 'stats');
}

function renderArchiveList() {
  if (!state.reports.length) {
    archiveListEl.innerHTML = '<div class="archive-empty">월간 로그가 아직 없습니다.</div>';
    return;
  }
  archiveListEl.innerHTML = state.reports.map((report) => `
    <button class="archive-chip ${report.id === state.currentReportId ? 'active' : ''}" type="button" data-report-id="${escapeHtml(report.id)}">
      <span class="archive-chip-label">${escapeHtml(report.label || report.title)}</span>
      <span class="archive-chip-meta">${escapeHtml(report.subtitle || '')}</span>
    </button>
  `).join('');
}

function renderReportPickerVisibility() {
  reportPickerEl.classList.toggle('hidden', !(state.currentView !== 'game' && state.reportPickerOpen));
}

function updateNavState() {
  navTabEls.forEach((element) => {
    const targetView = element.getAttribute('data-view-tab') || 'stats';
    element.classList.toggle('active', targetView === state.currentView);
  });
}

function setCurrentView(view, options = {}) {
  const { syncHash = true, scrollToContent = false } = options;
  state.currentView = view === 'game'
    ? 'game'
    : view === 'stats'
      ? 'stats'
      : 'summary';
  syncBodyViewState();
  updateNavState();
  renderReportPickerVisibility();
  setSummaryVisible(state.currentView === 'summary' && (!!state.summaryOverview || !!state.currentReport));
  setReportVisible(state.currentView === 'stats' && !!state.currentReport);
  setGameVisible(state.currentView === 'game');
  updateHeroIssue();
  updateHeroAction();
  if (state.currentView === 'game') {
    renderGame({ forceMediaPlayback: true });
  }
  if (syncHash) {
    syncLocationHash();
  }
  if (scrollToContent) {
    document.getElementById('content')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function openReportPicker() {
  state.reportPickerOpen = true;
  setCurrentView('stats', { syncHash: true });
  renderReportPickerVisibility();
  requestAnimationFrame(() => {
    reportPickerEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

function splitRows(rows) {
  const splitIndex = Math.ceil(rows.length / 2);
  return [rows.slice(0, splitIndex), rows.slice(splitIndex)];
}

function buildSignalWidth(rowRatio, maxRatio) {
  const ratio = Number(rowRatio || 0);
  const topRatio = Math.max(Number(maxRatio || 0), 0.0001);
  const normalized = Math.min(1, Math.max(0, ratio / topRatio));
  return Math.round(18 + (Math.pow(normalized, 0.6) * 82));
}

function renderSignalSection(title, rows, kind, emptyText) {
  if (!rows || !rows.length) {
    return `
      <article class="panel-card signal-stage signal-stage-${kind}">
        <div class="section-head">
          <h3>${escapeHtml(title)}</h3>
        </div>
        <p class="item-meta">${escapeHtml(emptyText)}</p>
      </article>
    `;
  }

  const maxRatio = rows.reduce((best, row) => Math.max(best, Number(row?.ratio || 0)), 0);
  const columns = splitRows(rows);

  return `
    <article class="panel-card signal-stage signal-stage-${kind}">
      <div class="section-head">
        <h3>${escapeHtml(title)}</h3>
      </div>
      <div class="signal-list">
        ${columns.map((columnRows) => `
          <div class="signal-column">
            ${columnRows.map((row, rowIndex) => {
              const index = rows.indexOf(row) + 1;
              const rawDisplayLabel = row.displayToken || row.token;
              const displayLabel = getVisibleRowLabel(row, kind, 'signal');
              const isGrouped = kind === 'word' && row.tokenTitle && normalizeComparableText(row.tokenTitle) !== normalizeComparableText(rawDisplayLabel);
              const fill = buildSignalWidth(row.ratio, maxRatio);
              const rankClass = index === 1 ? ' is-rank-gold' : index === 2 ? ' is-rank-silver' : index === 3 ? ' is-rank-bronze' : '';
              return `
                <article class="signal-row signal-row-${kind}${rankClass}" style="--fill:${fill}%;">
                  <div class="signal-row-fill"></div>
                  <div class="rank-badge ${index === 1 ? 'is-gold' : ''}${index === 2 ? ' is-silver' : ''}${index === 3 ? ' is-bronze' : ''}">${index}</div>
                  <div class="rank-main">
                    <div class="token-title" title="${escapeHtml(row.tokenTitle || rawDisplayLabel)}">
                      ${row.imageUrl ? `<img src="${escapeHtml(row.imageUrl)}" alt="${escapeHtml(rawDisplayLabel)}">` : ''}
                      <div class="token-title-text">
                        ${displayLabel ? `<span class="token-primary">${escapeHtml(displayLabel)}</span>` : ''}
                        ${isGrouped ? `<span class="token-aliases">${escapeHtml(row.tokenTitle)}</span>` : ''}
                      </div>
                    </div>
                    <div class="item-meta">${escapeHtml(formatRatio(row.ratio))}</div>
                  </div>
                  <div class="item-value">
                    <strong>${escapeHtml(formatNumber(row.count))}</strong>
                  </div>
                </article>
              `;
            }).join('')}
          </div>
        `).join('')}
      </div>
    </article>
  `;
}

function renderCompactTokens(rows, emptyText, options = {}) {
  const { kind = 'word', hideText = false } = options;
  if (!rows || !rows.length) {
    return `<p class="item-meta">${escapeHtml(emptyText)}</p>`;
  }
  return `
    <div class="compact-token-row">
      ${rows.map((row) => `
        <span class="compact-token ${hideText ? 'is-icon-only' : ''}" title="${escapeHtml(row.tokenTitle || row.displayToken || row.token)}">
          ${row.imageUrl ? `<img src="${escapeHtml(row.imageUrl)}" alt="${escapeHtml(row.displayToken || row.token)}">` : ''}
          ${hideText && row.imageUrl ? '' : `<span>${escapeHtml(getVisibleRowLabel(row, kind, kind === 'emote' ? 'clip' : 'signal') || row.displayToken || row.token || '')}</span>`}
        </span>
      `).join('')}
    </div>
  `;
}

function renderTopMomentClips(report) {
  const rows = report.topMomentClips || [];
  if (!rows.length) {
    return '<p class="item-meta">표시할 탑5 클립이 아직 없습니다.</p>';
  }
  return `
    <div class="clip-carousel">
      ${rows.map((row) => `
        <article class="clip-card">
          <div class="clip-card-head">
            <span class="clip-kicker ${Number(row.rank) === 1 ? 'is-gold' : Number(row.rank) === 2 ? 'is-silver' : Number(row.rank) === 3 ? 'is-bronze' : ''}">
              ${Number(row.rank) === 1 ? '🥇 ' : Number(row.rank) === 2 ? '🥈 ' : Number(row.rank) === 3 ? '🥉 ' : ''}${escapeHtml(row.label || String(row.rank || ''))}
            </span>
            <h4>${escapeHtml(row.title || `Top ${row.rank || ''}`)}</h4>
          </div>
          <div class="clip-player-wrap">
            <video class="clip-player" src="${escapeHtml(row.videoUrl)}" controls preload="metadata"></video>
          </div>
          <div class="clip-card-body">
            <div class="clip-meta-row">
              <span>${escapeHtml(row.date || '-')}</span>
              <span>${escapeHtml(row.timeLabel || '-')}</span>
              <span>채팅 평균 대비 ${escapeHtml(formatLift(row.liftVsAverage))}</span>
            </div>
            <div class="clip-token-block">
              <span class="clip-token-label">단어</span>
              ${renderCompactTokens(row.topWords, '단어가 없습니다.', { kind: 'word' })}
            </div>
            <div class="clip-token-block">
              <span class="clip-token-label">이모티콘</span>
              ${renderCompactTokens(row.topEmotes, '이모티콘이 없습니다.', { kind: 'emote', hideText: true })}
            </div>
          </div>
        </article>
      `).join('')}
    </div>
  `;
}

function buildPeakMomentText(item) {
  const dateText = item?.peakDate ? escapeHtml(item.peakDate) : '-';
  const bucketText = item?.peakBucketLabel ? escapeHtml(item.peakBucketLabel) : '-';
  const countText = `${formatNumber(item?.peakBucketCount || 0)}회`;
  return `가장 많이 쓰였던 순간 ${dateText} · ${bucketText} · ${countText}`;
}

function renderSearchResultEmpty(message) {
  return `<div class="search-result empty">${escapeHtml(message)}</div>`;
}

function renderSearchResult(item, query) {
  if (!item) {
    return renderSearchResultEmpty(`"${query}"는 이번 월간 로그에서 찾지 못했습니다.`);
  }
  const isGrouped = item.tokenTitle && normalizeComparableText(item.tokenTitle) !== normalizeComparableText(item.displayToken);
  return `
    <div class="search-result">
      <div class="search-result-header">
        <h4>${escapeHtml(item.displayToken)}</h4>
        <span>${escapeHtml(query)} 검색 결과</span>
      </div>
      <div class="search-result-grid">
        <div class="search-stat">
          <span class="search-stat-label">등장 횟수</span>
          <span class="search-stat-value">${escapeHtml(formatNumber(item.count))}회</span>
        </div>
        <div class="search-stat">
          <span class="search-stat-label">월간 순위</span>
          <span class="search-stat-value">${escapeHtml(formatNumber(item.rank))}위</span>
        </div>
        <div class="search-stat">
          <span class="search-stat-label">전체 비중</span>
          <span class="search-stat-value">${escapeHtml(formatRatio(item.ratio))}</span>
        </div>
        <div class="search-stat">
          <span class="search-stat-label">피크 구간 사용량</span>
          <span class="search-stat-value">${escapeHtml(formatNumber(item.peakBucketCount || 0))}회</span>
        </div>
      </div>
      <p class="search-result-note">${buildPeakMomentText(item)}</p>
      ${isGrouped ? `<p class="search-result-note subdued">묶인 표기 ${escapeHtml(item.tokenTitle)}${Array.isArray(item.aliases) && item.aliases.length > 1 ? ` · ${escapeHtml(item.aliases.join(', '))}` : ''}</p>` : ''}
    </div>
  `;
}

function renderWordSearch(report) {
  const suggestions = report.wordSearchExamples || [];
  return `
    <div class="search-panel">
      <form class="search-form" id="word-search-form">
        <input class="search-input" id="word-search-input" type="search" placeholder="궁금한 단어를 입력해 주세요" autocomplete="off">
        <button class="search-button" type="submit">검색</button>
      </form>
      ${suggestions.length ? `
        <div class="search-suggestions">
          ${suggestions.map((row) => `
            <button class="search-tag ${row.audioUrl ? 'sound-enabled' : ''}" type="button" data-word-suggestion="${escapeHtml(row.query || row.label)}" data-audio-url="${escapeHtml(row.audioUrl || '')}">
              ${escapeHtml(row.label || row.query)}
            </button>
          `).join('')}
        </div>
      ` : ''}
      <div id="word-search-result">${renderSearchResultEmpty('원하는 단어를 검색하면 등장 횟수와 월간 순위, 가장 많이 쓰였던 순간을 보여줍니다.')}</div>
    </div>
  `;
}

function getBrandAssetUrl(key) {
  return String(state.brandAssets?.[key] || '').trim();
}

function getSummaryCallTerm(story, label) {
  const rows = Array.isArray(story?.callTerms) ? story.callTerms : [];
  return rows.find((row) => normalizeComparableText(row?.label) === normalizeComparableText(label)) || null;
}

function getKstTodayDayLabel(startDateText) {
  const normalized = String(startDateText || '').trim();
  if (!normalized) {
    return 0;
  }
  const [year, month, day] = normalized.split('-').map((value) => Number(value));
  if (![year, month, day].every(Number.isFinite)) {
    return 0;
  }
  const startUtc = Date.UTC(year, month - 1, day);
  const now = new Date();
  const kstOffsetMs = 9 * 60 * 60 * 1000;
  const nowUtc = now.getTime() + (now.getTimezoneOffset() * 60 * 1000);
  const kstNow = new Date(nowUtc + kstOffsetMs);
  const endUtc = Date.UTC(kstNow.getUTCFullYear(), kstNow.getUTCMonth(), kstNow.getUTCDate());
  const diffDays = Math.floor((endUtc - startUtc) / 86400000);
  return Math.max(0, diffDays) + 1;
}

function animateSummaryCounter(counterEl, captionEl, targetValue) {
  if (!(counterEl instanceof HTMLElement)) {
    return;
  }
  const nextValue = Math.max(1, Number(targetValue || 0));
  const previousTarget = Number(counterEl.dataset.counterTarget || 0);
  if (previousTarget === nextValue && counterEl.dataset.counterDone === 'true') {
    return;
  }
  counterEl.dataset.counterTarget = String(nextValue);
  counterEl.dataset.counterDone = 'false';
  if (captionEl) {
    captionEl.classList.remove('is-visible');
  }
  const startedAt = performance.now();
  const duration = 1450;

  const tick = (now) => {
    const progress = Math.min(1, (now - startedAt) / duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    const currentValue = Math.max(1, Math.round(1 + ((nextValue - 1) * eased)));
    counterEl.textContent = formatNumber(currentValue);
    if (progress < 1) {
      window.requestAnimationFrame(tick);
      return;
    }
    counterEl.textContent = formatNumber(nextValue);
    counterEl.dataset.counterDone = 'true';
    if (captionEl) {
      captionEl.classList.add('is-visible');
    }
  };

  window.requestAnimationFrame(tick);
}

function buildSummaryChatColumns(messages, columnCount = 3) {
  const safeMessages = Array.isArray(messages) ? messages.filter(Boolean) : [];
  if (!safeMessages.length) {
    return [];
  }
  const columns = Array.from({ length: columnCount }, () => []);
  safeMessages.forEach((message, index) => {
    columns[index % columnCount].push(message);
  });
  return columns.map((column) => column.concat(column));
}

function renderSummaryChatBubbleContent(sample) {
  const segments = Array.isArray(sample?.segments) ? sample.segments : [];
  if (!segments.length) {
    return '';
  }
  return segments.map((segment) => {
    if (segment?.type === 'emote' && segment.url) {
      return `<img class="summary-chat-emote" src="${escapeHtml(segment.url)}" alt="${escapeHtml(segment.code || '이모티콘')}" loading="lazy">`;
    }
    return `<span>${escapeHtml(segment?.text || '')}</span>`;
  }).join('');
}

function renderSummary() {
  const story = state.summaryOverview || {};
  const logoUrl = getBrandAssetUrl('chzzkLogo');
  const callGondu = getSummaryCallTerm(story, '곤듀');
  const callJaecheon = getSummaryCallTerm(story, '재천');
  const combinedCalls = Number(callGondu?.count || 0) + Number(callJaecheon?.count || 0);
  const totalJourneyDays = getKstTodayDayLabel(story.referenceStartDate);
  const videoCount = Number(story.videoCount || 0);
  const messageCount = Number(story.messageCount || 0);
  const chatSamples = Array.isArray(story.chatSamples) && story.chatSamples.length
    ? story.chatSamples
    : [
        { segments: [{ type: 'text', text: '곤듀' }] },
        { segments: [{ type: 'text', text: '재하재하' }] },
        { segments: [{ type: 'text', text: 'ㅋㅋㅋㅋㅋㅋ' }] },
      ];
  const chatColumns = buildSummaryChatColumns(chatSamples, 3);
  const callVariants = Array.isArray(story.callVariants) && story.callVariants.length
    ? story.callVariants
    : ['곤듀', '곤듀님', '곤듀는', '재천', '임재천', '재천님', '재천아', '재천이'];
  const repeatedCallVariants = Array.from({ length: 7 }, () => callVariants).flat();

  summaryRootEl.innerHTML = `
    <div class="summary-wrap">
      <div class="summary-scroller" data-summary-scroller>
        <section class="summary-scene summary-scene-intro is-current" data-summary-scene>
          <div class="summary-scene-inner">
            <div class="summary-logo-story">
              <span class="summary-leading-text">지금까지</span>
              ${logoUrl ? `<span class="summary-logo-pill"><img src="${escapeHtml(logoUrl)}" alt="치지직 로고"></span>` : ''}
              <span class="summary-trailing-text">에서...</span>
            </div>
          </div>
          <div class="summary-scroll-hint">
            <span class="summary-scroll-mouse" aria-hidden="true"><span></span></span>
            <span class="summary-scroll-arrow" aria-hidden="true">⌄</span>
            <p>휠을 내려 요약을 살펴보세요</p>
          </div>
        </section>

        <section class="summary-scene summary-scene-stat" data-summary-scene>
          <div class="summary-scene-inner">
            <p class="summary-line">곤듀는</p>
            <p class="summary-quoted-line">
              <strong>${escapeHtml(formatNumber(totalJourneyDays))}</strong>
              <span>일 동안</span>
            </p>
            <p class="summary-line summary-line-tail">
              <span class="summary-inline-number summary-inline-number-large">${escapeHtml(formatNumber(videoCount))}</span>번의 방송을 진행했습니다
            </p>
          </div>
        </section>

        <section class="summary-scene summary-scene-stat summary-scene-chat" data-summary-scene>
          <div class="summary-chat-backdrop" aria-hidden="true">
            ${chatColumns.map((column, columnIndex) => `
              <div class="summary-chat-column is-column-${columnIndex + 1}">
                ${column.map((sample) => `
                  <p class="summary-chat-bubble">${renderSummaryChatBubbleContent(sample)}</p>
                `).join('')}
              </div>
            `).join('')}
          </div>
          <div class="summary-scene-inner summary-scene-inner-chat">
            <div class="summary-number-block is-wide is-chat-count">
              <strong data-summary-counter>${escapeHtml(formatNumber(1))}</strong>
              <span>개</span>
            </div>
            <p class="summary-line summary-line-tail summary-counter-caption" data-summary-counter-caption>그동안 ${escapeHtml(formatNumber(messageCount))}개의 채팅이 있었네요!</p>
          </div>
        </section>

        <section class="summary-scene summary-scene-question" data-summary-scene>
          <div class="summary-variant-cloud" aria-hidden="true">
            ${repeatedCallVariants.map((variant, index) => `
              <span class="summary-variant-item is-variant-${(index % 6) + 1}">${escapeHtml(variant)}</span>
            `).join('')}
          </div>
          <div class="summary-scene-inner summary-scene-inner-call">
            <div class="summary-term-card is-single is-call-focus">
              <div class="summary-call-count-row">
                <strong>${escapeHtml(formatNumber(combinedCalls))}</strong>
                <span class="summary-term-unit">회</span>
              </div>
              <p class="summary-term-note">재첩이가 곤듀를 부른 횟수</p>
              <p class="summary-term-note subdued">(곤듀+재천 등)</p>
            </div>
          </div>
        </section>

        <section class="summary-scene summary-scene-finale" data-summary-scene>
          <div class="summary-scene-inner">
            <div class="summary-top-chatter-card is-finale is-cta">
              <p class="summary-question summary-question-small">통계 탭과, 게임 탭도 확인해보세요!</p>
            </div>
          </div>
        </section>
      </div>
      <div class="summary-progress" data-summary-progress>
        ${Array.from({ length: 5 }, (_, index) => `
          <button class="summary-progress-dot ${index === 0 ? 'is-current' : ''}" type="button" data-summary-dot="${index}" aria-label="요약 ${index + 1}번째 장면으로 이동"></button>
        `).join('')}
      </div>
    </div>
  `;

  const scrollerEl = summaryRootEl.querySelector('[data-summary-scroller]');
  const sceneEls = Array.from(summaryRootEl.querySelectorAll('[data-summary-scene]'));
  const dotEls = Array.from(summaryRootEl.querySelectorAll('[data-summary-dot]'));
  if (!scrollerEl || !sceneEls.length) {
    return;
  }

  let wheelLocked = false;
  let wheelLockTimer = 0;
  let currentSummarySceneIndex = -1;
  let callSceneRevealed = false;

  const syncCallRevealState = () => {
    sceneEls[3]?.classList.toggle('is-revealed', callSceneRevealed);
  };

  const getCurrentSummaryStepIndex = () => {
    if (currentSummarySceneIndex <= 2) {
      return Math.max(0, currentSummarySceneIndex);
    }
    if (currentSummarySceneIndex === 3) {
      return callSceneRevealed ? 4 : 3;
    }
    if (currentSummarySceneIndex === 4) {
      return 5;
    }
    return 0;
  };

  const applySummaryStep = (stepIndex) => {
    const nextStep = Math.max(0, Math.min(5, stepIndex));
    if (nextStep <= 2) {
      callSceneRevealed = false;
      syncCallRevealState();
      scrollToSummaryScene(nextStep);
      return;
    }
    if (nextStep === 3) {
      callSceneRevealed = false;
      syncCallRevealState();
      scrollToSummaryScene(3);
      return;
    }
    if (nextStep === 4) {
      callSceneRevealed = true;
      syncCallRevealState();
      scrollToSummaryScene(3);
      return;
    }
    callSceneRevealed = false;
    syncCallRevealState();
    scrollToSummaryScene(4);
  };

  const syncSummarySceneState = () => {
    const viewportHeight = scrollerEl.clientHeight || 1;
    const rawIndex = Math.round(scrollerEl.scrollTop / viewportHeight);
    const activeIndex = Math.max(0, Math.min(sceneEls.length - 1, rawIndex));
    sceneEls.forEach((sceneEl, index) => {
      sceneEl.classList.toggle('is-current', index === activeIndex);
      sceneEl.classList.toggle('is-before', index < activeIndex);
      sceneEl.classList.toggle('is-after', index > activeIndex);
    });
    dotEls.forEach((dotEl, index) => {
      dotEl.classList.toggle('is-current', index === activeIndex);
    });
    if (activeIndex !== currentSummarySceneIndex) {
      const previousIndex = currentSummarySceneIndex;
      currentSummarySceneIndex = activeIndex;
      if (activeIndex === 2) {
        animateSummaryCounter(
          sceneEls[activeIndex].querySelector('[data-summary-counter]'),
          sceneEls[activeIndex].querySelector('[data-summary-counter-caption]'),
          messageCount,
        );
      }
      if (activeIndex === 3 && previousIndex !== 3 && previousIndex !== 4) {
        callSceneRevealed = false;
      }
      if (activeIndex !== 3) {
        callSceneRevealed = false;
      }
      syncCallRevealState();
    }
  };

  const scrollToSummaryScene = (index) => {
    const nextIndex = Math.max(0, Math.min(sceneEls.length - 1, index));
    const nextSceneEl = sceneEls[nextIndex];
    if (!nextSceneEl) {
      return;
    }
    nextSceneEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const lockSummaryWheel = () => {
    wheelLocked = true;
    window.clearTimeout(wheelLockTimer);
    wheelLockTimer = window.setTimeout(() => {
      wheelLocked = false;
    }, SUMMARY_SCROLL_LOCK_MS);
  };

  summaryRootEl.querySelectorAll('[data-summary-dot]').forEach((dotEl) => {
    dotEl.addEventListener('click', () => {
      const index = Number(dotEl.getAttribute('data-summary-dot') || 0);
      scrollToSummaryScene(index);
    });
  });

  scrollerEl.addEventListener('scroll', () => {
    window.requestAnimationFrame(syncSummarySceneState);
  }, { passive: true });

  scrollerEl.addEventListener('wheel', (event) => {
    if (window.innerWidth <= 900) {
      return;
    }
    if (Math.abs(event.deltaY) < 18) {
      return;
    }
    event.preventDefault();
    if (wheelLocked) {
      return;
    }
    const viewportHeight = scrollerEl.clientHeight || 1;
    const currentIndex = Math.round(scrollerEl.scrollTop / viewportHeight);
    const direction = event.deltaY > 0 ? 1 : -1;
    if (direction < 0 && currentIndex === 0 && scrollerEl.scrollTop <= 12) {
      event.preventDefault();
      document.getElementById('top')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    const currentStep = getCurrentSummaryStepIndex();
    const nextStep = Math.max(0, Math.min(5, currentStep + direction));
    if (nextStep === currentStep) {
      return;
    }
    lockSummaryWheel();
    applySummaryStep(nextStep);
  }, { passive: false });

  scrollerEl.scrollTo({ top: 0, behavior: 'auto' });
  syncSummarySceneState();
}

function renderReport(report) {
  const overview = report.overview || {};
  document.title = `${report.label} | 월간 재첩`;
  reportRootEl.innerHTML = `
    <div class="report-shell">
      <section class="report-intro">
        <div class="report-intro-head">
          <h2>${escapeHtml(report.label)}</h2>
          <p class="report-subtitle">${escapeHtml(report.subtitle)} · 방송 ${escapeHtml(formatNumber(overview.videoCount))}개</p>
        </div>
      </section>

      ${renderSignalSection('TOP20 단어', report.topWords, 'word', '상위 단어 데이터가 아직 없습니다.')}
      ${renderSignalSection('TOP20 이모티콘', report.topEmotes, 'emote', '상위 이모티콘 데이터가 아직 없습니다.')}

      <p class="public-filter-note">※ 일반어와 같은 표현을 일부 제외했습니다.</p>

      <article class="panel-card">
        <div class="section-head">
          <h3>탑5 클립</h3>
        </div>
        ${renderTopMomentClips(report)}
      </article>
    </div>
  `;
}

function playAudio(url, options = {}) {
  if (!url) {
    return;
  }
  const audio = new Audio(url);
  audio.volume = Number.isFinite(Number(options.volume)) ? Number(options.volume) : 1;
  void audio.play().catch(() => {});
}

function resolveGameAudioUrl(kind) {
  return String(state.gameAudio?.[kind] || '').trim();
}

function resolveGameTokenAudioUrl(item) {
  const tokenMap = state.gameAudio?.tokens || {};
  const aliases = String(item?.tokenTitle || '')
    .split('+')
    .map((value) => normalizeComparableText(value))
    .filter(Boolean);
  const candidates = [
    normalizeComparableText(item?.displayToken),
    normalizeComparableText(item?.id),
    ...aliases,
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (tokenMap[candidate]) {
      return tokenMap[candidate];
    }
  }
  return '';
}

function normalizeGameTokenId(value) {
  return String(value || '').trim();
}

function resetGamePausedTokens(preservedIds = []) {
  state.gamePausedTokenIds = new Set(
    (Array.isArray(preservedIds) ? preservedIds : [preservedIds])
      .map((value) => normalizeGameTokenId(value))
      .filter(Boolean)
  );
}

function isGameTokenPaused(tokenId) {
  return state.gamePausedTokenIds instanceof Set
    ? state.gamePausedTokenIds.has(normalizeGameTokenId(tokenId))
    : false;
}

function setGameTokenPaused(tokenId, paused) {
  const normalizedTokenId = normalizeGameTokenId(tokenId);
  if (!normalizedTokenId) {
    return;
  }
  const nextSet = state.gamePausedTokenIds instanceof Set
    ? new Set(state.gamePausedTokenIds)
    : new Set();
  if (paused) {
    nextSet.add(normalizedTokenId);
  } else {
    nextSet.delete(normalizedTokenId);
  }
  state.gamePausedTokenIds = nextSet;
}

function maybePlayCurrentRoundAudio() {
  const pendingToken = normalizeComparableText(state.pendingRoundAudioToken);
  const currentToken = normalizeComparableText(state.gameSession?.rightItem?.id || state.gameSession?.rightItem?.displayToken);
  if (!pendingToken || !currentToken || pendingToken !== currentToken) {
    return;
  }
  const audioUrl = resolveGameTokenAudioUrl(state.gameSession?.rightItem);
  state.pendingRoundAudioToken = '';
  if (audioUrl) {
    playAudio(audioUrl, { volume: 0.92 });
  }
}

function getActiveGameStageElement() {
  return gameRootEl.querySelector('.game-stage.is-active') || gameRootEl;
}

function getActiveGameVideoEntries() {
  const stageEl = getActiveGameStageElement();
  const videoEls = Array.from(stageEl.querySelectorAll('.guess-backdrop-video'))
    .filter((element) => element instanceof HTMLVideoElement);
  const primaryVideoEl = videoEls.find((element) => element.dataset.gameVideoRole === 'challenger')
    || videoEls.find((element) => element.dataset.gameVideoRole === 'anchor')
    || null;
  return videoEls.map((videoEl) => {
    const tokenId = normalizeGameTokenId(videoEl.dataset.gameTokenId);
    return {
      videoEl,
      tokenId,
      role: String(videoEl.dataset.gameVideoRole || '').trim(),
      isPrimary: videoEl === primaryVideoEl,
      isPaused: isGameTokenPaused(tokenId),
    };
  });
}

function buildGameVideoPlans(entries, forcePlay = false) {
  return entries.map((entry) => {
    let mode = 'silent';
    if (entry.isPaused) {
      mode = 'paused';
    } else if (entry.isPrimary && !state.gameMediaMuted) {
      mode = 'audible';
    }
    return {
      ...entry,
      mode,
      shouldForcePlay: forcePlay || entry.videoEl.paused,
    };
  });
}

function clampVolume(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return 0;
  }
  return Math.max(0, Math.min(1, num));
}

function stopGameVideoFade(videoEl) {
  const frameId = gameVideoFadeFrames.get(videoEl);
  if (frameId) {
    window.cancelAnimationFrame(frameId);
    gameVideoFadeFrames.delete(videoEl);
  }
}

function clearGameVideoAudibleRetries(videoEl) {
  const timerIds = gameVideoAudibleRetryTimers.get(videoEl);
  if (Array.isArray(timerIds)) {
    timerIds.forEach((timerId) => window.clearTimeout(timerId));
  }
  gameVideoAudibleRetryTimers.delete(videoEl);
}

function clearGameVideoAsyncWork(videoEl) {
  clearGameVideoAudibleRetries(videoEl);
  stopGameVideoFade(videoEl);
}

function primeGameVideoElement(videoEl) {
  videoEl.playsInline = true;
  videoEl.loop = true;
  videoEl.preload = 'auto';
}

function setGameVideoSilentState(videoEl) {
  videoEl.defaultMuted = true;
  videoEl.muted = true;
  videoEl.setAttribute('muted', '');
  videoEl.volume = 0;
}

function setGameVideoAudibleState(videoEl) {
  videoEl.defaultMuted = false;
  videoEl.muted = false;
  videoEl.removeAttribute('muted');
}

function requestGameVideoPlayback(videoEl) {
  try {
    const playResult = videoEl.play();
    if (playResult && typeof playResult.then === 'function') {
      return playResult.catch(() => {});
    }
  } catch {}
  return Promise.resolve();
}

function scheduleGameVideoAudibleRetries(videoEl, tokenId) {
  if (!(videoEl instanceof HTMLVideoElement)) {
    return;
  }
  clearGameVideoAudibleRetries(videoEl);
  const delays = [0, 180, 520];
  const timerIds = delays.map((delay, index) => window.setTimeout(() => {
    if (state.gameMediaMuted || isGameTokenPaused(tokenId)) {
      return;
    }
    if (!videoEl.isConnected) {
      return;
    }
    setGameVideoAudibleState(videoEl);
    if (videoEl.paused) {
      void requestGameVideoPlayback(videoEl);
    }
    if (index === 0) {
      animateGameVideoVolume(videoEl, GAME_VIDEO_AUDIBLE_VOLUME, GAME_VIDEO_FADE_IN_MS);
    } else {
      videoEl.volume = GAME_VIDEO_AUDIBLE_VOLUME;
    }
  }, delay));
  gameVideoAudibleRetryTimers.set(videoEl, timerIds);
}

function animateGameVideoVolume(videoEl, targetVolume, duration = GAME_VIDEO_FADE_IN_MS, options = {}) {
  if (!(videoEl instanceof HTMLVideoElement)) {
    options.onComplete?.();
    return;
  }
  stopGameVideoFade(videoEl);
  const startVolume = clampVolume(videoEl.volume);
  const nextVolume = clampVolume(targetVolume);
  if (duration <= 0 || Math.abs(startVolume - nextVolume) < 0.01) {
    videoEl.volume = nextVolume;
    options.onComplete?.();
    return;
  }

  const startedAt = performance.now();
  const tick = (now) => {
    const progress = Math.min(1, (now - startedAt) / duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    videoEl.volume = startVolume + ((nextVolume - startVolume) * eased);
    if (progress < 1) {
      const frameId = window.requestAnimationFrame(tick);
      gameVideoFadeFrames.set(videoEl, frameId);
      return;
    }
    gameVideoFadeFrames.delete(videoEl);
    options.onComplete?.();
  };

  const frameId = window.requestAnimationFrame(tick);
  gameVideoFadeFrames.set(videoEl, frameId);
}

function getGameVideoFeedbackMarkup(mode) {
  if (mode === 'paused') {
    return `
      <span class="guess-video-feedback-glyph" aria-hidden="true">
        <span></span><span></span>
      </span>
      <span class="guess-video-feedback-label">일시정지</span>
    `;
  }
  return `
    <span class="guess-video-feedback-glyph is-play" aria-hidden="true">
      <span></span>
    </span>
    <span class="guess-video-feedback-label">재생 중</span>
  `;
}

function setGameVideoPausedVisual(videoEl, paused) {
  const cardEl = videoEl.closest('.guess-card');
  cardEl?.classList.toggle('is-media-paused', !!paused);
}

function showGameVideoFeedback(videoEl, mode) {
  const feedbackEl = videoEl.closest('.guess-card')?.querySelector('[data-game-video-feedback]');
  if (!feedbackEl) {
    return;
  }
  const timerId = gameVideoFeedbackTimers.get(feedbackEl);
  if (timerId) {
    window.clearTimeout(timerId);
  }
  feedbackEl.innerHTML = getGameVideoFeedbackMarkup(mode);
  feedbackEl.classList.remove('is-paused', 'is-playing');
  feedbackEl.classList.add('is-visible', mode === 'paused' ? 'is-paused' : 'is-playing');
  const nextTimerId = window.setTimeout(() => {
    feedbackEl.classList.remove('is-visible', 'is-paused', 'is-playing');
  }, GAME_VIDEO_FEEDBACK_MS);
  gameVideoFeedbackTimers.set(feedbackEl, nextTimerId);
}

function pauseGameVideoPlayback(plan) {
  const { videoEl } = plan;
  clearGameVideoAsyncWork(videoEl);
  const finalizePause = () => {
    videoEl.pause();
    setGameVideoSilentState(videoEl);
    setGameVideoPausedVisual(videoEl, true);
  };
  if (!videoEl.paused && videoEl.volume > 0.01) {
    animateGameVideoVolume(videoEl, 0, GAME_VIDEO_FADE_OUT_MS, {
      onComplete: finalizePause,
    });
    return;
  }
  finalizePause();
}

function ensureSilentGameVideoPlayback(plan) {
  const { videoEl, shouldForcePlay } = plan;
  clearGameVideoAsyncWork(videoEl);
  setGameVideoPausedVisual(videoEl, false);
  primeGameVideoElement(videoEl);

  const finalizeSilent = () => {
    setGameVideoSilentState(videoEl);
    if (shouldForcePlay) {
      void requestGameVideoPlayback(videoEl);
    }
  };

  if (!videoEl.paused && videoEl.volume > 0.01) {
    animateGameVideoVolume(videoEl, 0, GAME_VIDEO_FADE_OUT_MS, {
      onComplete: finalizeSilent,
    });
    return;
  }
  finalizeSilent();
}

function ensureAudibleGameVideoPlayback(plan) {
  const { videoEl, tokenId, shouldForcePlay } = plan;
  clearGameVideoAsyncWork(videoEl);
  setGameVideoPausedVisual(videoEl, false);
  primeGameVideoElement(videoEl);

  const scheduleAudible = () => {
    if (state.gameMediaMuted || isGameTokenPaused(tokenId)) {
      return;
    }
    setGameVideoAudibleState(videoEl);
    scheduleGameVideoAudibleRetries(videoEl, tokenId);
  };

  if (shouldForcePlay) {
    videoEl.pause();
    setGameVideoSilentState(videoEl);
    setGameVideoAudibleState(videoEl);
    videoEl.volume = 0.001;
    void requestGameVideoPlayback(videoEl).then(() => {
      scheduleAudible();
    });
    return;
  }

  scheduleAudible();
}

function getGameMediaToggleIconMarkup() {
  if (state.gameMediaMuted) {
    return `
      <svg class="game-media-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 10.5h3.8L12.3 6v12l-4.5-4.5H4z"></path>
        <path d="M15.2 9.2l5.6 5.6"></path>
        <path d="M20.8 9.2l-5.6 5.6"></path>
      </svg>
    `;
  }
  return `
    <svg class="game-media-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 10.5h3.8L12.3 6v12l-4.5-4.5H4z"></path>
      <path d="M16 9.3a4.6 4.6 0 0 1 0 5.4"></path>
      <path d="M18.7 7.2a7.7 7.7 0 0 1 0 9.6"></path>
    </svg>
  `;
}

function syncGameMediaToggleButtonUi() {
  const buttonEls = Array.from(gameRootEl.querySelectorAll('[data-game-mute-toggle]'));
  if (!buttonEls.length) {
    return;
  }
  const label = state.gameMediaMuted ? '게임 영상 소리 켜기' : '게임 영상 음소거';
  const stateLabel = state.gameMediaMuted ? '소리 OFF' : '소리 ON';
  buttonEls.forEach((buttonEl) => {
    buttonEl.classList.toggle('is-muted', state.gameMediaMuted);
    buttonEl.classList.toggle('is-active', !state.gameMediaMuted);
    buttonEl.setAttribute('aria-label', label);
    buttonEl.setAttribute('title', label);
    buttonEl.setAttribute('aria-pressed', state.gameMediaMuted ? 'true' : 'false');
    const iconEl = buttonEl.querySelector('[data-game-media-icon]');
    const labelEl = buttonEl.querySelector('[data-game-media-label]');
    if (iconEl) {
      iconEl.innerHTML = getGameMediaToggleIconMarkup();
    }
    if (labelEl) {
      labelEl.textContent = stateLabel;
    }
  });
}

function syncGameBackdropMedia(forcePlay = false) {
  syncGameMediaToggleButtonUi();
  const plans = buildGameVideoPlans(getActiveGameVideoEntries(), forcePlay);
  if (!plans.length) {
    return;
  }
  plans.forEach((plan) => {
    if (plan.mode === 'paused') {
      pauseGameVideoPlayback(plan);
      return;
    }
    if (plan.mode === 'audible') {
      ensureAudibleGameVideoPlayback(plan);
      return;
    }
    ensureSilentGameVideoPlayback(plan);
  });
}

async function getSearchItems(report) {
  if (!report?.id || !report?.wordSearchFile) {
    return [];
  }
  if (state.searchCache.has(report.id)) {
    return state.searchCache.get(report.id) || [];
  }
  const data = await fetchJson(report.wordSearchFile);
  const items = Array.isArray(data.items) ? data.items : [];
  state.searchCache.set(report.id, items);
  return items;
}

function findSearchItem(items, rawQuery) {
  const normalizedQuery = normalizeComparableText(rawQuery);
  if (!normalizedQuery) {
    return null;
  }

  let partialMatch = null;
  for (const item of items) {
    const aliases = Array.isArray(item.aliases) ? item.aliases : [];
    const candidates = [
      item.displayToken,
      item.token,
      item.tokenTitle,
      ...aliases,
    ].map((value) => normalizeComparableText(value)).filter(Boolean);

    if (candidates.some((value) => value === normalizedQuery)) {
      return item;
    }

    if (!partialMatch && candidates.some((value) => value.includes(normalizedQuery))) {
      partialMatch = item;
    }
  }
  return partialMatch;
}

function bindWordSearch(report) {
  const formEl = document.getElementById('word-search-form');
  const inputEl = document.getElementById('word-search-input');
  const resultEl = document.getElementById('word-search-result');
  const suggestionEls = Array.from(document.querySelectorAll('[data-word-suggestion]'));
  if (!formEl || !inputEl || !resultEl) {
    return;
  }

  const runSearch = async (rawQuery) => {
    const query = String(rawQuery || '').trim();
    if (!query) {
      resultEl.innerHTML = renderSearchResultEmpty('원하는 단어를 검색하면 등장 횟수와 월간 순위, 가장 많이 쓰였던 순간을 보여줍니다.');
      return;
    }
    resultEl.innerHTML = renderSearchResultEmpty(`"${query}"를 찾는 중입니다...`);
    try {
      const items = await getSearchItems(report);
      const match = findSearchItem(items, query);
      resultEl.innerHTML = renderSearchResult(match, query);
    } catch (error) {
      resultEl.innerHTML = renderSearchResultEmpty(error instanceof Error ? error.message : '단어 검색을 처리하지 못했습니다.');
    }
  };

  formEl.addEventListener('submit', (event) => {
    event.preventDefault();
    void runSearch(inputEl.value);
  });

  suggestionEls.forEach((element) => {
    element.addEventListener('click', () => {
      const suggestedWord = element.getAttribute('data-word-suggestion') || '';
      const audioUrl = element.getAttribute('data-audio-url') || '';
      inputEl.value = suggestedWord;
      if (audioUrl) {
        playAudio(audioUrl);
      }
      void runSearch(suggestedWord);
      inputEl.focus();
    });
  });
}

function renderGameBreakdown(item) {
  const rows = Array.isArray(item?.monthBreakdown) ? item.monthBreakdown : [];
  if (!rows.length) {
    return '';
  }
  return `
    <div class="guess-breakdown">
      ${rows.map((row) => `
        <span class="guess-breakdown-chip">${escapeHtml(row.label)} · ${escapeHtml(formatNumber(row.count))}회</span>
      `).join('')}
    </div>
  `;
}

function buildGamePosterTiles(item) {
  const aliases = String(item?.tokenTitle || '')
    .split('+')
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  const labels = [item?.displayToken, ...aliases].filter(Boolean);
  const pool = labels.length ? labels : [item?.displayToken || '채팅'];
  return Array.from({ length: 6 }, (_, index) => `
    <div class="guess-mosaic-tile tile-${(index % 6) + 1}">
      <span>${escapeHtml(pool[index % pool.length])}</span>
    </div>
  `).join('');
}

function renderGameCard(item, options = {}) {
  const {
    showCount = true,
    showMeta = false,
    accent = 'anchor',
    isRevealed = false,
  } = options;
  if (!item) {
    return '';
  }
  const showGrouped = item.tokenTitle && normalizeComparableText(item.tokenTitle) !== normalizeComparableText(item.displayToken);
  const footerMetaMarkup = showMeta
    ? `
      <div class="guess-card-footer-meta">
        <span class="guess-rank">전체 ${escapeHtml(formatNumber(item.rank || 0))}위</span>
      </div>
    `
    : '';
  const mediaKind = String(item.mediaKind || 'image').trim();
  const mediaUrl = String(item.mediaUrl || '').trim();
  const tokenId = normalizeGameTokenId(item.id || item.displayToken);
  const backdropMarkup = mediaUrl && mediaKind === 'video'
    ? `
      <div class="guess-backdrop is-video">
        <video class="guess-backdrop-video" data-game-video-role="${escapeHtml(accent)}" data-game-token-id="${escapeHtml(tokenId)}" src="${escapeHtml(mediaUrl)}" autoplay loop playsinline preload="auto" muted></video>
        <button class="guess-video-toggle" type="button" data-game-video-toggle data-game-video-role="${escapeHtml(accent)}" data-game-token-id="${escapeHtml(tokenId)}" aria-label="영상 일시정지 또는 재생">
          <span class="guess-video-feedback" data-game-video-feedback aria-hidden="true"></span>
        </button>
      </div>
    `
    : mediaUrl
    ? `<div class="guess-backdrop is-photo" style="background-image:url('${escapeHtml(mediaUrl)}');"></div>`
    : `
      <div class="guess-backdrop is-generated">
        <div class="guess-backdrop-glow"></div>
        <div class="guess-backdrop-orb"></div>
        <div class="guess-backdrop-mosaic">${buildGamePosterTiles(item)}</div>
      </div>
    `;
  return `
    <article class="guess-card guess-card-${escapeHtml(accent)} ${isRevealed ? 'is-revealed' : 'is-hidden'}">
      ${backdropMarkup}
      <div class="guess-card-overlay"></div>
      <div class="guess-card-inner">
        <div class="guess-word-wrap">
          <div class="guess-word-head">
            <h3>${escapeHtml(item.displayToken)}</h3>
            ${showMeta && showGrouped ? `<p class="guess-token-inline">${escapeHtml(item.tokenTitle)}</p>` : ''}
          </div>
        </div>
        <div class="guess-count ${showCount ? 'is-visible' : 'is-hidden'}">
          <strong>${showCount ? escapeHtml(formatNumber(item.count)) : '???'}</strong>
          <span>회</span>
        </div>
        ${showMeta ? `<div class="guess-ratio">${escapeHtml(formatRatio(item.ratio))}</div>` : ''}
        ${showMeta ? renderGameBreakdown(item) : ''}
        ${footerMetaMarkup}
      </div>
    </article>
  `;
}

function pickRandomGameItem(excludedIds = new Set(), referenceItem = null) {
  if (!Array.isArray(state.gameData?.items) || !state.gameData.items.length) {
    return null;
  }
  const sameCount = Number(referenceItem?.count || -1);
  let pool = state.gameData.items.filter((item) => !excludedIds.has(item.id));
  if (referenceItem) {
    pool = pool.filter((item) => Number(item.count) !== sameCount);
  }
  if (!pool.length) {
    pool = state.gameData.items.filter((item) => item.id !== referenceItem?.id);
  }
  if (!pool.length) {
    return null;
  }
  return pool[Math.floor(Math.random() * Math.min(pool.length, 80))];
}

function startGameSession() {
  const items = Array.isArray(state.gameData?.items) ? state.gameData.items : [];
  if (items.length < 2) {
    state.gameSession = null;
    return;
  }
  const seedPool = items.slice(0, Math.min(items.length, 18));
  const leftItem = seedPool[Math.floor(Math.random() * seedPool.length)] || items[0];
  const usedIds = new Set([leftItem.id]);
  const rightItem = pickRandomGameItem(usedIds, leftItem);
  if (!rightItem) {
    state.gameSession = null;
    return;
  }
  usedIds.add(rightItem.id);
  state.gameSession = {
    score: 0,
    revealed: false,
    correct: null,
    leftItem,
    rightItem,
    usedIds,
  };
  resetGamePausedTokens();
  state.pendingRoundAudioToken = rightItem.id;
}

function advanceGameSession() {
  if (!state.gameSession?.rightItem) {
    startGameSession();
    return;
  }
  const carriedLeft = state.gameSession.rightItem;
  const preservedPausedIds = isGameTokenPaused(carriedLeft.id) ? [carriedLeft.id] : [];
  let usedIds = state.gameSession.usedIds instanceof Set
    ? new Set(state.gameSession.usedIds)
    : new Set();
  usedIds.add(carriedLeft.id);
  let nextRight = pickRandomGameItem(usedIds, carriedLeft);
  if (!nextRight) {
    usedIds = new Set([carriedLeft.id]);
    nextRight = pickRandomGameItem(usedIds, carriedLeft);
  }
  if (!nextRight) {
    startGameSession();
    return;
  }
  usedIds.add(nextRight.id);
  state.gameSession = {
    ...state.gameSession,
    revealed: false,
    correct: null,
    leftItem: carriedLeft,
    rightItem: nextRight,
    usedIds,
  };
  resetGamePausedTokens(preservedPausedIds);
  state.pendingRoundAudioToken = nextRight.id;
}

function handleGameGuess(guess) {
  if (!state.gameSession || state.gameSession.revealed) {
    return;
  }
  const leftCount = Number(state.gameSession.leftItem?.count || 0);
  const rightCount = Number(state.gameSession.rightItem?.count || 0);
  const relation = rightCount > leftCount ? 'higher' : 'lower';
  const correct = guess === relation;
  const feedbackUrl = resolveGameAudioUrl(correct ? 'success' : 'fail');
  const nextScore = correct ? Number(state.gameSession.score || 0) + 1 : Number(state.gameSession.score || 0);
  state.gameBestScore = Math.max(state.gameBestScore, nextScore);
  state.gameSession = {
    ...state.gameSession,
    score: nextScore,
    revealed: true,
    correct,
  };
  if (feedbackUrl) {
    playAudio(feedbackUrl, { volume: 0.95 });
  }
  renderGame({ animateReveal: true, forceMediaPlayback: true });
}

function renderGameStatus(session) {
  return '';
}

function renderGameStage(session, options = {}) {
  const {
    stageClass = '',
    isActive = false,
    animateReveal = false,
    showChrome = true,
  } = options;
  const resultStateClass = session.revealed ? (session.correct ? 'is-correct' : 'is-wrong') : '';
  const versusStateClass = session.revealed ? (session.correct ? 'is-correct' : 'is-wrong') : '';
  const revealedClass = session.revealed && !animateReveal ? 'is-revealed' : '';
  const versusFace = session.correct
    ? `
      <span class="game-versus-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24">
          <path d="M5 12.6 9.2 16.8 19 7"></path>
        </svg>
      </span>
    `
    : `
      <span class="game-versus-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24">
          <path d="M7 7 17 17"></path>
          <path d="M17 7 7 17"></path>
        </svg>
      </span>
    `;
  return `
    <article class="game-stage ${resultStateClass} ${stageClass} ${isActive ? 'is-active' : ''}">
      ${showChrome ? renderGameScore(session) : ''}
      ${showChrome ? renderGameMediaToggle() : ''}
      ${showChrome ? renderGameStatus(session) : ''}
      ${renderGameCard(session.leftItem, {
        showCount: true,
        showMeta: session.revealed,
        accent: 'anchor',
        isRevealed: true,
      })}
      <div class="game-versus ${revealedClass} ${versusStateClass}">
        <div class="game-versus-flip">
          <div class="game-versus-face game-versus-front">
            <span class="game-versus-label">VS</span>
          </div>
          <div class="game-versus-face game-versus-back">
            ${session.revealed ? versusFace : '<span class="game-versus-label">VS</span>'}
          </div>
        </div>
      </div>
      ${renderGameCard(session.rightItem, {
        showCount: session.revealed,
        showMeta: session.revealed,
        accent: 'challenger',
        isRevealed: session.revealed,
      })}
      ${showChrome ? `
        <div class="game-floating-controls">
          ${renderGameControls(session)}
        </div>
      ` : ''}
    </article>
  `;
}

function triggerGameRevealMotion() {
  const versusEl = gameRootEl.querySelector('.game-stage.is-active .game-versus');
  if (!versusEl) {
    return;
  }
  window.requestAnimationFrame(() => {
    versusEl.classList.add('is-revealed', 'is-pulsed');
    window.setTimeout(() => {
      versusEl.classList.remove('is-pulsed');
    }, 700);
  });
}

function transitionGameRound(prepareNextSession) {
  const previousSession = state.gameSession;
  prepareNextSession();
  if (!previousSession || !state.gameSession) {
    renderGame({ forceMediaPlayback: true });
    return;
  }
  renderGame({
    forceMediaPlayback: true,
    transitionFrom: previousSession,
  });
}

function renderGameScore(session) {
  return `
    <div class="game-score-corner game-score-left">
      <span>최고 점수</span>
      <strong>${escapeHtml(formatNumber(state.gameBestScore || 0))}</strong>
    </div>
    <div class="game-score-corner game-score-right">
      <span>현재 점수</span>
      <strong>${escapeHtml(formatNumber(session.score || 0))}</strong>
    </div>
  `;
}

function renderGameMediaToggle() {
  const label = state.gameMediaMuted ? '게임 영상 소리 켜기' : '게임 영상 음소거';
  const stateLabel = state.gameMediaMuted ? '소리 OFF' : '소리 ON';
  const stateClass = state.gameMediaMuted ? 'is-muted' : 'is-active';
  return `
    <div class="game-media-corner">
      <button class="game-media-toggle ${stateClass}" type="button" data-game-mute-toggle aria-label="${label}" title="${label}" aria-pressed="${state.gameMediaMuted ? 'true' : 'false'}">
        <span class="game-media-icon-wrap" data-game-media-icon>${getGameMediaToggleIconMarkup()}</span>
        <span class="game-media-label" data-game-media-label>${stateLabel}</span>
      </button>
    </div>
  `;
}

function renderGameControls(session) {
  if (session.revealed) {
    return `
      <div class="game-button-stack is-frozen">
        <button class="game-next-button" type="button" data-game-next>${session.correct ? '다음' : '다시 시작'}</button>
      </div>
    `;
  }
  return `
    <div class="game-button-stack">
      <button class="game-guess-button" type="button" data-game-guess="higher">
        <span class="game-button-label">더 많이</span>
        <span class="game-button-icon game-button-icon-up" aria-hidden="true"></span>
      </button>
      <button class="game-guess-button" type="button" data-game-guess="lower">
        <span class="game-button-label">더 적게</span>
        <span class="game-button-icon game-button-icon-down" aria-hidden="true"></span>
      </button>
    </div>
  `;
}

function renderGame(options = {}) {
  const {
    forceMediaPlayback = false,
    animateReveal = false,
    transitionFrom = null,
  } = options;
  if (state.currentView !== 'game' && gameRootEl.classList.contains('hidden')) {
    return;
  }

  if (state.gameError) {
    gameRootEl.innerHTML = `
      <div class="game-wrap">
        <article class="panel-card">
          <p class="item-meta">${escapeHtml(state.gameError)}</p>
        </article>
      </div>
    `;
    return;
  }

  if (!state.gameData) {
    gameRootEl.innerHTML = `
      <div class="game-wrap">
        <article class="panel-card">
          <p class="item-meta">게임 데이터를 준비하는 중입니다.</p>
        </article>
      </div>
    `;
    return;
  }

  if (!state.gameSession) {
    startGameSession();
  }

  if (!state.gameSession) {
    gameRootEl.innerHTML = `
      <div class="game-wrap">
        <article class="panel-card">
          <p class="item-meta">게임으로 보여줄 단어 데이터가 아직 부족합니다.</p>
        </article>
      </div>
    `;
    return;
  }

  const session = state.gameSession;
  if (!transitionFrom && state.gameTransitionTimer) {
    window.clearTimeout(state.gameTransitionTimer);
    state.gameTransitionTimer = null;
  }
  gameRootEl.innerHTML = `
    <div class="game-wrap">
      <div class="game-stage-stack ${transitionFrom ? 'is-layered' : ''}">
        ${transitionFrom
          ? `
            ${renderGameStage(transitionFrom, {
              stageClass: 'is-transition-old',
              showChrome: false,
            })}
            ${renderGameStage(session, {
              stageClass: 'is-transition-new',
              isActive: true,
            })}
          `
          : renderGameStage(session, {
            isActive: true,
            animateReveal,
          })}
      </div>
    </div>
  `;
  syncGameBackdropMedia(forceMediaPlayback);
  maybePlayCurrentRoundAudio();
  if (transitionFrom) {
    const stackEl = gameRootEl.querySelector('.game-stage-stack');
    window.requestAnimationFrame(() => {
      stackEl?.classList.add('is-transitioning');
    });
    state.gameTransitionTimer = window.setTimeout(() => {
      state.gameTransitionTimer = null;
      renderGame({ forceMediaPlayback: true });
    }, 560);
  } else if (animateReveal && session.revealed) {
    triggerGameRevealMotion();
  }
}

function playGameClickAudio(volume = 0.7) {
  const clickUrl = resolveGameAudioUrl('click');
  if (clickUrl) {
    playAudio(clickUrl, { volume });
  }
}

function handleGameVideoToggle(toggleEl) {
  const tokenId = normalizeGameTokenId(toggleEl.getAttribute('data-game-token-id'));
  const videoEl = toggleEl.closest('.guess-card')?.querySelector('.guess-backdrop-video');
  if (!(videoEl instanceof HTMLVideoElement)) {
    return;
  }
  const nextPaused = !isGameTokenPaused(tokenId);
  setGameTokenPaused(tokenId, nextPaused);
  showGameVideoFeedback(videoEl, nextPaused ? 'paused' : 'playing');
  syncGameBackdropMedia(true);
}

function handleGameMuteToggle() {
  playGameClickAudio(0.65);
  state.gameMediaMuted = !state.gameMediaMuted;
  syncGameBackdropMedia(true);
}

function bindGameControls() {
  gameRootEl.addEventListener('click', (event) => {
    const videoToggle = event.target.closest('[data-game-video-toggle]');
    if (videoToggle) {
      handleGameVideoToggle(videoToggle);
      return;
    }
    const muteButton = event.target.closest('[data-game-mute-toggle]');
    if (muteButton) {
      handleGameMuteToggle();
      return;
    }
    const guessButton = event.target.closest('[data-game-guess]');
    if (guessButton) {
      playGameClickAudio();
      handleGameGuess(guessButton.getAttribute('data-game-guess') || '');
      return;
    }
    const nextButton = event.target.closest('[data-game-next]');
    if (nextButton) {
      playGameClickAudio();
      if (state.gameSession?.correct) {
        transitionGameRound(() => {
          advanceGameSession();
        });
      } else {
        transitionGameRound(() => {
          startGameSession();
        });
      }
    }
  });
}

async function loadReport(reportId, options = {}) {
  const { syncHash = true } = options;
  const reportMeta = state.reports.find((report) => report.id === reportId);
  if (!reportMeta) {
    throw new Error('선택한 리포트를 찾지 못했습니다.');
  }

  state.currentReportId = reportId;
  writeStoredReportId(reportId);
  renderArchiveList();
  setError('');
  const isInitialLoad = !state.hasLoadedReport || !state.currentReport;
  if (isInitialLoad) {
    setSummaryVisible(false);
    setReportVisible(false);
    setLoading(true, '월간 리포트를 불러오는 중입니다...');
  } else {
    setLoading(false);
    setSummaryVisible(state.currentView === 'summary');
    setReportVisible(state.currentView === 'stats');
    setReportUpdating(true);
  }

  try {
    const report = await fetchJson(reportMeta.reportFile);
    if (!report || typeof report !== 'object') {
      throw new Error('리포트 데이터가 비어 있습니다.');
    }
    state.currentReport = report;
    renderReport(report);
    state.hasLoadedReport = true;
    setReportUpdating(false);
    setLoading(false);
    setSummaryVisible(state.currentView === 'summary');
    setReportVisible(state.currentView === 'stats');
    updateHeroIssue();
    if (syncHash && state.currentView !== 'game') {
      syncLocationHash();
    }
  } catch (error) {
    setReportUpdating(false);
    setLoading(false);
    setSummaryVisible(Boolean(state.currentReport) && state.currentView === 'summary');
    setReportVisible(Boolean(state.currentReport) && state.currentView === 'stats');
    setError(error instanceof Error ? error.message : '리포트를 불러오지 못했습니다.');
  }
}

async function loadGameData(gameFile) {
  if (!gameFile) {
    state.gameData = null;
    state.gameError = '게임 데이터를 찾지 못했습니다.';
    renderGame();
    return;
  }
  try {
    state.gameFile = gameFile;
    state.gameData = await fetchJson(`${gameFile}?v=${Date.now()}`);
    state.gameError = '';
    state.gameSession = null;
    resetGamePausedTokens();
    updateHeroIssue();
    renderGame();
  } catch (error) {
    state.gameData = null;
    state.gameError = error instanceof Error ? error.message : '게임 데이터를 불러오지 못했습니다.';
    renderGame();
  }
}

async function bootstrap() {
  updateScrollState();
  window.addEventListener('scroll', updateScrollState, { passive: true });

  openReportPickerEl?.addEventListener('click', openReportPicker);
  archiveListEl.addEventListener('click', (event) => {
    const button = event.target.closest('[data-report-id]');
    if (!button) {
      return;
    }
    const reportId = button.getAttribute('data-report-id') || '';
    if (!reportId || reportId === state.currentReportId) {
      return;
    }
    state.reportPickerOpen = false;
    renderReportPickerVisibility();
    void loadReport(reportId, { syncHash: state.currentView === 'stats' });
  });
  navTabEls.forEach((element) => {
    element.addEventListener('click', () => {
      const targetView = element.getAttribute('data-view-tab') || 'stats';
      setCurrentView(targetView, { syncHash: true, scrollToContent: true });
      if (targetView === 'game') {
        renderGame({ forceMediaPlayback: true });
      }
    });
  });
  bindGameControls();

  try {
    const data = await fetchJson(`./data/reports.json?v=${Date.now()}`);
    state.reports = Array.isArray(data.reports) ? data.reports : [];
    state.brandAssets = data.brandAssets && typeof data.brandAssets === 'object' ? data.brandAssets : {};
    state.summaryOverview = data.summaryOverview && typeof data.summaryOverview === 'object' ? data.summaryOverview : null;
    state.gameAudio = data.gameAudio && typeof data.gameAudio === 'object' ? data.gameAudio : {};
    setHeroVideo(Array.isArray(data.heroVideos) ? data.heroVideos : []);
    renderSummary();
    renderArchiveList();
    if (!state.reports.length) {
      setLoading(false);
      setError('표시할 월간 로그가 없습니다.');
      return;
    }

    await loadGameData(data.gameFile || '');

    const initialLocation = parseLocationState();
    const initialReport =
      state.reports.find((report) => report.id === initialLocation.reportId)
      || state.reports[0];
    await loadReport(initialReport.id, { syncHash: false });
    setCurrentView(initialLocation.view, { syncHash: false });

    window.addEventListener('hashchange', () => {
      const nextLocation = parseLocationState();
      if (nextLocation.view === 'game') {
        setCurrentView('game', { syncHash: false });
        renderGame({ forceMediaPlayback: true });
        return;
      }
      setCurrentView(nextLocation.view, { syncHash: false });
      if (nextLocation.reportId && nextLocation.reportId !== state.currentReportId) {
        void loadReport(nextLocation.reportId, { syncHash: false });
      } else {
        updateHeroIssue();
      }
    });
  } catch (error) {
    setLoading(false);
    setError(error instanceof Error ? error.message : '리포트 목록을 불러오지 못했습니다.');
  }
}

bootstrap();
