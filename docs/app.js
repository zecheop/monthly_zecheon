const state = {
  reports: [],
  currentReportId: '',
  currentReport: null,
  currentView: 'stats',
  reportPickerOpen: false,
  searchCache: new Map(),
  hasLoadedReport: false,
  gameFile: '',
  gameData: null,
  gameError: '',
  gameSession: null,
  gameBestScore: 0,
  gameAudio: {},
  pendingRoundAudioToken: '',
};

const openReportPickerEl = document.getElementById('open-report-picker');
const heroIssueEl = document.getElementById('hero-issue');
const reportPickerEl = document.getElementById('report-picker');
const archiveListEl = document.getElementById('archive-list');
const loadingPanelEl = document.getElementById('loading-panel');
const errorPanelEl = document.getElementById('error-panel');
const reportRootEl = document.getElementById('report-root');
const gameRootEl = document.getElementById('game-root');
const navTabEls = Array.from(document.querySelectorAll('[data-view-tab]'));
const heroVideoEl = document.getElementById('hero-video');

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

function setHeroVideo(videos) {
  if (!(heroVideoEl instanceof HTMLVideoElement)) {
    return;
  }
  const selected = pickRandomItem(videos);
  if (!selected) {
    heroVideoEl.removeAttribute('src');
    return;
  }
  if (heroVideoEl.getAttribute('src') === selected) {
    return;
  }
  heroVideoEl.setAttribute('src', selected);
  heroVideoEl.load();
  void heroVideoEl.play().catch(() => {});
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

function setGameVisible(visible) {
  gameRootEl.classList.toggle('hidden', !visible);
}

function setReportUpdating(isUpdating) {
  reportRootEl.classList.toggle('is-updating', !!isUpdating);
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
    return { view: 'stats', reportId: '' };
  }
  try {
    const decoded = decodeURIComponent(rawHash);
    if (decoded === 'game') {
      return { view: 'game', reportId: '' };
    }
    return { view: 'stats', reportId: decoded };
  } catch {
    if (rawHash === 'game') {
      return { view: 'game', reportId: '' };
    }
    return { view: 'stats', reportId: rawHash };
  }
}

function syncLocationHash() {
  const nextHash = state.currentView === 'game'
    ? '#game'
    : (state.currentReportId ? `#${encodeURIComponent(state.currentReportId)}` : '');
  if (window.location.hash !== nextHash) {
    history.replaceState(null, '', nextHash || window.location.pathname);
  }
}

function updateHeroIssue() {
  const nextText = state.currentView === 'game'
    ? ''
    : formatIssueTag(`${state.currentReport?.label || ''} ${state.currentReport?.subtitle || ''}`);
  if (!nextText) {
    heroIssueEl.textContent = '';
    heroIssueEl.classList.add('hidden');
    return;
  }
  heroIssueEl.textContent = nextText;
  heroIssueEl.classList.remove('hidden');
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
  reportPickerEl.classList.toggle('hidden', !(state.currentView === 'stats' && state.reportPickerOpen));
}

function updateNavState() {
  navTabEls.forEach((element) => {
    const targetView = element.getAttribute('data-view-tab') || 'stats';
    element.classList.toggle('active', targetView === state.currentView);
  });
}

function setCurrentView(view, options = {}) {
  const { syncHash = true, scrollToContent = false } = options;
  state.currentView = view === 'game' ? 'game' : 'stats';
  syncBodyViewState();
  updateNavState();
  renderReportPickerVisibility();
  setReportVisible(state.currentView === 'stats' && !!state.currentReport);
  setGameVisible(state.currentView === 'game');
  updateHeroIssue();
  if (state.currentView === 'game') {
    renderGame();
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
                      ${displayLabel ? `<span>${escapeHtml(displayLabel)}</span>` : ''}
                    </div>
                    <div class="item-meta">${escapeHtml(formatRatio(row.ratio))}${isGrouped ? ` · ${escapeHtml(row.tokenTitle)}` : ''}</div>
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
  const badgeMarkup = showMeta
    ? `<div class="guess-card-meta-row"><span class="guess-rank">전체 ${escapeHtml(formatNumber(item.rank || 0))}위</span></div>`
    : '';
  const mediaKind = String(item.mediaKind || 'image').trim();
  const mediaUrl = String(item.mediaUrl || '').trim();
  const backdropMarkup = mediaUrl && mediaKind === 'video'
    ? `
      <div class="guess-backdrop is-video">
        <video class="guess-backdrop-video" src="${escapeHtml(mediaUrl)}" autoplay muted loop playsinline preload="metadata"></video>
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
        ${badgeMarkup}
        <div class="guess-word-wrap">
          <h3>${escapeHtml(item.displayToken)}</h3>
          ${showMeta && showGrouped ? `<p class="guess-token-title">${escapeHtml(item.tokenTitle)}</p>` : ''}
        </div>
        <div class="guess-count ${showCount ? 'is-visible' : 'is-hidden'}">
          <strong>${showCount ? escapeHtml(formatNumber(item.count)) : '???'}</strong>
          <span>회</span>
        </div>
        ${showMeta ? `<div class="guess-ratio">${escapeHtml(formatRatio(item.ratio))}</div>` : ''}
        ${showMeta ? renderGameBreakdown(item) : ''}
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
  state.pendingRoundAudioToken = rightItem.id;
}

function advanceGameSession() {
  if (!state.gameSession?.rightItem) {
    startGameSession();
    renderGame();
    return;
  }
  const carriedLeft = state.gameSession.rightItem;
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
    renderGame();
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
  state.pendingRoundAudioToken = nextRight.id;
  renderGame();
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
  renderGame();
}

function renderGameStatus(session) {
  if (!session.revealed) {
    return '';
  }
  return `
    <div class="game-result-burst is-${session.correct ? 'correct' : 'wrong'}">
      <span>${session.correct ? '정답' : '아쉽!'}</span>
    </div>
  `;
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

function renderGameControls(session) {
  if (session.revealed) {
    return `
      <div class="game-button-stack is-frozen">
        <button class="game-guess-button" type="button" disabled>${session.correct ? '정답' : '오답'}</button>
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

function renderGame() {
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
  gameRootEl.innerHTML = `
    <div class="game-wrap">
      <article class="game-stage ${session.revealed ? (session.correct ? 'is-correct' : 'is-wrong') : ''}">
        ${renderGameScore(session)}
        ${renderGameStatus(session)}
        ${renderGameCard(session.leftItem, {
          showCount: true,
          showMeta: session.revealed,
          accent: 'anchor',
          isRevealed: true,
        })}
        <div class="game-versus">VS</div>
        ${renderGameCard(session.rightItem, {
          showCount: session.revealed,
          showMeta: session.revealed,
          accent: 'challenger',
          isRevealed: session.revealed,
        })}
        <div class="game-floating-controls">
          ${renderGameControls(session)}
        </div>
      </article>
    </div>
  `;
  maybePlayCurrentRoundAudio();
}

function bindGameControls() {
  gameRootEl.addEventListener('click', (event) => {
    const guessButton = event.target.closest('[data-game-guess]');
    if (guessButton) {
      const clickUrl = resolveGameAudioUrl('click');
      if (clickUrl) {
        playAudio(clickUrl, { volume: 0.7 });
      }
      handleGameGuess(guessButton.getAttribute('data-game-guess') || '');
      return;
    }
    const nextButton = event.target.closest('[data-game-next]');
    if (nextButton) {
      const clickUrl = resolveGameAudioUrl('click');
      if (clickUrl) {
        playAudio(clickUrl, { volume: 0.7 });
      }
      if (state.gameSession?.correct) {
        advanceGameSession();
      } else {
        startGameSession();
        renderGame();
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
  renderArchiveList();
  setError('');
  const isInitialLoad = !state.hasLoadedReport || !state.currentReport;
  if (isInitialLoad) {
    setReportVisible(false);
    setLoading(true, '월간 리포트를 불러오는 중입니다...');
  } else {
    setLoading(false);
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
    setReportVisible(state.currentView === 'stats');
    updateHeroIssue();
    if (syncHash && state.currentView === 'stats') {
      syncLocationHash();
    }
  } catch (error) {
    setReportUpdating(false);
    setLoading(false);
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
        renderGame();
      }
    });
  });
  bindGameControls();

  try {
    const data = await fetchJson(`./data/reports.json?v=${Date.now()}`);
    state.reports = Array.isArray(data.reports) ? data.reports : [];
    state.gameAudio = data.gameAudio && typeof data.gameAudio === 'object' ? data.gameAudio : {};
    setHeroVideo(Array.isArray(data.heroVideos) ? data.heroVideos : []);
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
        renderGame();
        return;
      }
      setCurrentView('stats', { syncHash: false });
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
