const state = {
  reports: [],
  currentReportId: '',
  currentReport: null,
  currentAudio: null,
  searchCache: new Map(),
  hasLoadedReport: false,
};

const siteHeaderEl = document.getElementById('site-header');
const openReportPickerEl = document.getElementById('open-report-picker');
const heroIssueEl = document.getElementById('hero-issue');
const reportPickerEl = document.getElementById('report-picker');
const archiveListEl = document.getElementById('archive-list');
const loadingPanelEl = document.getElementById('loading-panel');
const errorPanelEl = document.getElementById('error-panel');
const reportRootEl = document.getElementById('report-root');

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

function setReportUpdating(isUpdating) {
  reportRootEl.classList.toggle('is-updating', !!isUpdating);
}

function updateHeaderState() {
  siteHeaderEl.classList.toggle('is-scrolled', window.scrollY > 36);
}

function openReportPicker() {
  reportPickerEl.classList.remove('hidden');
  requestAnimationFrame(() => {
    reportPickerEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

function updateHeroIssue(report) {
  if (!heroIssueEl) {
    return;
  }
  const sourceText = `${report?.label || ''} ${report?.subtitle || ''}`;
  const match = sourceText.match(/(\d{4})-(\d{2})/);
  if (!match) {
    heroIssueEl.textContent = '';
    heroIssueEl.classList.add('hidden');
    return;
  }
  heroIssueEl.textContent = `${Number(match[2])}월호`;
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

function renderRankedRows(rows, emptyText) {
  if (!rows || !rows.length) {
    return `<p class="item-meta">${escapeHtml(emptyText)}</p>`;
  }
  const splitIndex = Math.ceil(rows.length / 2);
  const columns = [rows.slice(0, splitIndex), rows.slice(splitIndex)];
  return `
    <div class="rank-list">
      ${columns.map((columnRows, columnIndex) => `
        <div class="rank-column">
          ${columnRows.map((row, rowIndex) => {
            const index = rowIndex + 1 + (columnIndex * splitIndex);
            const displayLabel = row.displayToken || row.token;
            const showGroupedTitle =
              row.tokenTitle && normalizeComparableText(row.tokenTitle) !== normalizeComparableText(displayLabel);
            const metaParts = [formatRatio(row.ratio)];
            if (showGroupedTitle) {
              metaParts.push(row.tokenTitle);
            }
            return `
              <article class="rank-row">
                <div class="rank-badge">TOP ${index}</div>
                <div class="rank-main">
                  <div class="token-title" title="${escapeHtml(row.tokenTitle || displayLabel)}">
                    ${row.imageUrl ? `<img src="${escapeHtml(row.imageUrl)}" alt="${escapeHtml(displayLabel)}">` : ''}
                    <span>${escapeHtml(displayLabel)}</span>
                  </div>
                  <div class="item-meta">${escapeHtml(metaParts.join(' · '))}</div>
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
  `;
}

function renderCompactTokens(rows, emptyText) {
  if (!rows || !rows.length) {
    return `<p class="item-meta">${escapeHtml(emptyText)}</p>`;
  }
  return `
    <div class="compact-token-row">
      ${rows.map((row) => `
        <span class="compact-token" title="${escapeHtml(row.tokenTitle || row.displayToken || row.token)}">
          ${row.imageUrl ? `<img src="${escapeHtml(row.imageUrl)}" alt="${escapeHtml(row.displayToken || row.token)}">` : ''}
          <span>${escapeHtml(row.displayToken || row.token)}</span>
        </span>
      `).join('')}
    </div>
  `;
}

function renderTopMomentClips(report) {
  const rows = report.topMomentClips || [];
  if (!rows.length) {
    return '<p class="item-meta">표시할 Top Moments 클립이 아직 없습니다.</p>';
  }
  return `
    <div class="clip-carousel">
      ${rows.map((row) => `
        <article class="clip-card">
          <div class="clip-card-head">
            <span class="clip-kicker">${escapeHtml(row.label || `T${row.rank || ''}`)}</span>
            <h4>${escapeHtml(row.title || `Top ${row.rank || ''}`)}</h4>
          </div>
          <div class="clip-player-wrap">
            <video class="clip-player" src="${escapeHtml(row.videoUrl)}" controls preload="metadata"></video>
            <div class="clip-player-controls">
              <button class="clip-skip-button" type="button" data-clip-skip="-10">-10초</button>
              <button class="clip-skip-button" type="button" data-clip-skip="10">+10초</button>
            </div>
          </div>
          <div class="clip-card-body">
            <div class="clip-meta-row">
              <span>${escapeHtml(row.date || '-')}</span>
              <span>${escapeHtml(row.timeLabel || '-')}</span>
              <span>채팅 평균 대비 ${escapeHtml(formatLift(row.liftVsAverage))}</span>
            </div>
            <div class="clip-token-block">
              <span class="clip-token-label">단어</span>
              ${renderCompactTokens(row.topWords, '단어가 없습니다.')}
            </div>
            <div class="clip-token-block">
              <span class="clip-token-label">이모티콘</span>
              ${renderCompactTokens(row.topEmotes, '이모티콘이 없습니다.')}
            </div>
          </div>
        </article>
      `).join('')}
    </div>
  `;
}

function bindClipPlayers() {
  const skipButtons = Array.from(document.querySelectorAll('[data-clip-skip]'));
  skipButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const clipCard = button.closest('.clip-card');
      const videoEl = clipCard?.querySelector('.clip-player');
      if (!(videoEl instanceof HTMLVideoElement)) {
        return;
      }
      const delta = Number(button.getAttribute('data-clip-skip') || 0);
      const currentTime = Number.isFinite(videoEl.currentTime) ? videoEl.currentTime : 0;
      const duration = Number.isFinite(videoEl.duration) ? videoEl.duration : null;
      const rawNextTime = currentTime + delta;
      const nextTime = duration == null
        ? Math.max(0, rawNextTime)
        : Math.min(Math.max(0, rawNextTime), duration);
      videoEl.currentTime = nextTime;
      videoEl.focus();
    });
  });
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
        <p class="eyebrow">Monthly Report</p>
        <div class="report-intro-head">
          <h2>${escapeHtml(report.label)}</h2>
          <p class="report-subtitle">${escapeHtml(report.subtitle)} · 방송 ${escapeHtml(formatNumber(overview.videoCount))}개</p>
        </div>
      </section>

      <section class="panel-grid">
        <article class="panel-card">
          <div class="section-head">
            <p class="section-kicker">Top 20 Words</p>
            <h3>TOP20 단어</h3>
          </div>
          ${renderRankedRows(report.topWords, '상위 단어 데이터가 아직 없습니다.')}
        </article>

        <article class="panel-card">
          <div class="section-head">
            <p class="section-kicker">Top 20 Emotes</p>
            <h3>TOP20 이모티콘</h3>
          </div>
          ${renderRankedRows(report.topEmotes, '상위 이모티콘 데이터가 아직 없습니다.')}
        </article>
      </section>

      <article class="panel-card">
        <div class="section-head">
          <p class="section-kicker">Top 5 Moments</p>
          <h3>Top5 Moments</h3>
        </div>
        ${renderTopMomentClips(report)}
      </article>

      <article class="panel-card">
        <div class="section-head">
          <p class="section-kicker">Word Search</p>
          <h3>단어 검색기</h3>
        </div>
        ${renderWordSearch(report)}
      </article>
    </div>
  `;
}

function playAudio(url) {
  if (!url) {
    return;
  }
  if (state.currentAudio) {
    state.currentAudio.pause();
    state.currentAudio.currentTime = 0;
  }
  const audio = new Audio(url);
  state.currentAudio = audio;
  void audio.play().catch(() => {});
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

function updateLocationHash(reportId) {
  const nextHash = reportId ? `#${encodeURIComponent(reportId)}` : '';
  if (window.location.hash !== nextHash) {
    history.replaceState(null, '', nextHash || window.location.pathname);
  }
}

function getInitialReportId() {
  const hash = window.location.hash.replace(/^#/, '').trim();
  if (!hash) {
    return '';
  }
  try {
    return decodeURIComponent(hash);
  } catch {
    return hash;
  }
}

async function loadReport(reportId) {
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
    setReportVisible(true);
    setReportUpdating(true);
  }

  try {
    const report = await fetchJson(reportMeta.reportFile);
    if (!report || typeof report !== 'object') {
      throw new Error('리포트 데이터가 비어 있습니다.');
    }
    state.currentReport = report;
    renderReport(report);
    updateHeroIssue(report);
    bindClipPlayers();
    bindWordSearch(report);
    updateLocationHash(reportId);
    void getSearchItems(report);
    state.hasLoadedReport = true;
    setReportUpdating(false);
    setLoading(false);
    setReportVisible(true);
  } catch (error) {
    setReportUpdating(false);
    setLoading(false);
    setReportVisible(Boolean(state.currentReport));
    setError(error instanceof Error ? error.message : '리포트를 불러오지 못했습니다.');
  }
}

async function bootstrap() {
  updateHeaderState();
  window.addEventListener('scroll', updateHeaderState, { passive: true });
  openReportPickerEl?.addEventListener('click', openReportPicker);

  try {
    const data = await fetchJson('./data/reports.json');
    state.reports = Array.isArray(data.reports) ? data.reports : [];
    renderArchiveList();
    if (!state.reports.length) {
      setLoading(false);
      setError('표시할 월간 로그가 없습니다.');
      return;
    }

    archiveListEl.addEventListener('click', (event) => {
      const button = event.target.closest('[data-report-id]');
      if (!button) {
        return;
      }
      const reportId = button.getAttribute('data-report-id') || '';
      if (!reportId || reportId === state.currentReportId) {
        return;
      }
      void loadReport(reportId);
    });

    window.addEventListener('hashchange', () => {
      const reportId = getInitialReportId();
      if (!reportId || reportId === state.currentReportId) {
        return;
      }
      void loadReport(reportId);
    });

    const initialReportId = getInitialReportId();
    const initialReport =
      state.reports.find((report) => report.id === initialReportId) || state.reports[0];
    await loadReport(initialReport.id);
  } catch (error) {
    setLoading(false);
    setError(error instanceof Error ? error.message : '리포트 목록을 불러오지 못했습니다.');
  }
}

bootstrap();
