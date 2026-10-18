/* 오늘 뭐 입지? — 화면/네트워크 */
(function () {
  'use strict';

  var L = window.WeatherLib;
  var LS_KEY = 'wo.kmaKey';
  var LS_REGION = 'wo.region';
  var FETCH_TIMEOUT = 12000;

  var params = new URLSearchParams(location.search);
  var isDemo = params.get('demo') === '1';
  var loadSeq = 0;

  function $(id) { return document.getElementById(id); }

  // ---------------------------------------------------------------------------
  // 인증키: localStorage > config.js 의 기본 키 (자리표시자/빈 값이면 무시)
  // ---------------------------------------------------------------------------
  function embeddedKey() { return L.usableEmbeddedKey(window.KMA_EMBEDDED_KEY); }
  function storedKey() {
    try { return (localStorage.getItem(LS_KEY) || '').trim(); } catch (e) { return ''; }
  }
  function getKey() { return L.resolveKey(storedKey(), window.KMA_EMBEDDED_KEY); }

  // ---------------------------------------------------------------------------
  // 상태 표시
  // ---------------------------------------------------------------------------
  function showLoading(msg) {
    var s = $('status');
    s.className = 'card status';
    s.textContent = '';
    var sp = document.createElement('span');
    sp.className = 'spinner';
    s.appendChild(sp);
    s.appendChild(document.createTextNode(msg || '날씨를 불러오는 중…'));
    s.hidden = false;
  }

  function showError(msg) {
    var s = $('status');
    s.className = 'card status error';
    s.textContent = '';
    var p = document.createElement('div');
    p.textContent = '😢 ' + msg;
    s.appendChild(p);
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'primary-btn retry';
    btn.textContent = '다시 시도';
    btn.addEventListener('click', load);
    s.appendChild(btn);
    s.hidden = false;
    $('main').hidden = true;
  }

  function hideStatus() { $('status').hidden = true; }

  // ---------------------------------------------------------------------------
  // 설정 화면
  // ---------------------------------------------------------------------------
  function openSettings(required, message) {
    $('keyInput').value = storedKey();
    setSettingsMsg(message || '', !!message);
    $('cancelSettingsBtn').hidden = !!required;
    $('resetKeyBtn').hidden = !embeddedKey() && !storedKey();
    $('settings').hidden = false;
    $('main').hidden = true;
    hideStatus();
    if (!required) $('keyInput').focus();
  }

  function closeSettings() {
    $('settings').hidden = true;
  }

  function setSettingsMsg(msg, isError) {
    var el = $('settingsMsg');
    el.textContent = msg;
    el.className = 'settings-msg' + (isError ? ' error' : '');
  }

  function bindSettings() {
    $('settingsBtn').addEventListener('click', function () {
      if ($('settings').hidden) openSettings(!getKey() && !isDemo);
      else if (getKey() || isDemo) { closeSettings(); load(); }
    });

    $('settingsForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var k = $('keyInput').value.trim();
      if (!k) { setSettingsMsg('인증키를 입력해 주세요.', true); return; }
      try { localStorage.setItem(LS_KEY, k); } catch (err) { /* 저장 불가 환경 */ }
      closeSettings();
      if (isDemo) { location.href = location.pathname; return; }
      load();
    });

    $('resetKeyBtn').addEventListener('click', function () {
      try { localStorage.removeItem(LS_KEY); } catch (err) { /* noop */ }
      $('keyInput').value = '';
      if (!embeddedKey()) {
        $('resetKeyBtn').hidden = true;
        $('cancelSettingsBtn').hidden = true;
        setSettingsMsg('기본 키가 설정되어 있지 않아요. 인증키를 직접 입력해 주세요.', true);
        return;
      }
      setSettingsMsg('기본 키를 사용합니다.', false);
      closeSettings();
      load();
    });

    $('cancelSettingsBtn').addEventListener('click', function () {
      closeSettings();
      load();
    });
  }

  // ---------------------------------------------------------------------------
  // 위치
  // ---------------------------------------------------------------------------
  var REGIONS = L.buildRegions(window.KR_REGIONS || []);
  var DEFAULT_REGION_ID = '서울 중구';
  var demoRegion = null;

  function savedRegion() {
    try { return L.findRegion(localStorage.getItem(LS_REGION), REGIONS); } catch (e) { return null; }
  }

  function chooseRegion(r) {
    closeSearch();
    if (isDemo) { demoRegion = r; load(); return; }
    try { localStorage.setItem(LS_REGION, r.id); } catch (e) { /* noop */ }
    load();
  }

  function useGps() {
    try { localStorage.removeItem(LS_REGION); } catch (e) { /* noop */ }
    closeSearch();
    load();
  }

  // mode: 'gps' | 'manual' | 'fallback'(위치 권한 없음)
  function setLocationMode(mode) {
    $('gpsBtn').hidden = isDemo || mode === 'gps';
    $('searchOpenBtn').textContent = mode === 'fallback' ? '지역 검색' : '다른 지역 보기';
  }

  function getGps() {
    return new Promise(function (resolve, reject) {
      if (!('geolocation' in navigator)) { reject(new Error('unavailable')); return; }
      navigator.geolocation.getCurrentPosition(
        function (p) { resolve(p.coords); },
        reject,
        { enableHighAccuracy: false, timeout: 10000, maximumAge: 10 * 60 * 1000 }
      );
    });
  }

  function regionLocation(r, note) {
    var g = L.latLonToGrid(r.lat, r.lon);
    return { nx: g.nx, ny: g.ny, label: L.displayName(r) + (note ? ' · ' + note : '') };
  }

  function resolveLocation() {
    var saved = savedRegion();
    if (saved) { setLocationMode('manual'); return Promise.resolve(regionLocation(saved)); }

    showLoading('현재 위치를 확인하는 중…');
    return getGps().then(function (c) {
      var g = L.latLonToGrid(c.latitude, c.longitude);
      var near = L.nearestRegion(c.latitude, c.longitude, REGIONS);
      setLocationMode('gps');
      return { nx: g.nx, ny: g.ny, label: (near ? L.displayName(near) : '현재 위치') + ' 근처' };
    }, function () {
      setLocationMode('fallback');
      if ($('searchPanel').hidden) openSearch('', '위치 권한이 없어 서울 날씨를 보여드려요. 지역을 검색해 주세요.', true);
      return regionLocation(L.findRegion(DEFAULT_REGION_ID, REGIONS), '기본 지역');
    });
  }

  // ---------------------------------------------------------------------------
  // 지역 검색
  // ---------------------------------------------------------------------------
  var results = [];
  var active = -1;

  function openSearch(query, note, keepFocus) {
    var input = $('regionInput');
    input.value = query || '';
    $('searchNote').textContent = note || '';
    $('searchNote').hidden = !note;
    $('searchPanel').hidden = false;
    renderSuggestions();
    if (!keepFocus) input.focus();
  }

  function closeSearch() {
    $('searchPanel').hidden = true;
    $('regionInput').setAttribute('aria-expanded', 'false');
  }

  function hintItem(text) {
    var li = document.createElement('li');
    li.className = 'suggestion-hint';
    li.textContent = text;
    return li;
  }

  function renderSuggestions() {
    var input = $('regionInput');
    var list = $('suggestions');
    var q = input.value;
    results = L.searchRegions(q, REGIONS, 8);
    active = results.length ? 0 : -1;
    list.textContent = '';

    if (!q.trim()) list.appendChild(hintItem('예: 광양 · 부산 중구 · 수원 · ㄱㅇ'));
    else if (!results.length) list.appendChild(hintItem('검색 결과가 없어요'));

    results.forEach(function (r, i) {
      var li = document.createElement('li');
      li.className = 'suggestion';
      li.id = 'sug-' + i;
      li.setAttribute('role', 'option');
      var name = document.createElement('b');
      name.textContent = L.displayName(r);
      var sub = document.createElement('small');
      sub.textContent = r.sido + (r.synthetic ? ' · 전체' : '');
      li.appendChild(name);
      li.appendChild(sub);
      // 입력창 포커스(모바일 키보드)를 유지한 채 선택
      li.addEventListener('mousedown', function (e) { e.preventDefault(); });
      li.addEventListener('click', function () { chooseRegion(r); });
      list.appendChild(li);
    });
    input.setAttribute('aria-expanded', results.length ? 'true' : 'false');
    highlight();
  }

  function highlight() {
    var items = $('suggestions').querySelectorAll('.suggestion');
    for (var i = 0; i < items.length; i++) {
      var on = i === active;
      items[i].classList.toggle('active', on);
      items[i].setAttribute('aria-selected', on ? 'true' : 'false');
      if (on && items[i].scrollIntoView) items[i].scrollIntoView({ block: 'nearest' });
    }
    var input = $('regionInput');
    if (active >= 0) input.setAttribute('aria-activedescendant', 'sug-' + active);
    else input.removeAttribute('aria-activedescendant');
  }

  function bindSearch() {
    var input = $('regionInput');
    input.addEventListener('input', renderSuggestions);
    input.addEventListener('keydown', function (e) {
      if (e.isComposing || e.keyCode === 229) return; // 한글 조합 중
      if (e.key === 'ArrowDown' && results.length) {
        e.preventDefault(); active = (active + 1) % results.length; highlight();
      } else if (e.key === 'ArrowUp' && results.length) {
        e.preventDefault(); active = (active - 1 + results.length) % results.length; highlight();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (results[active]) chooseRegion(results[active]);
      } else if (e.key === 'Escape') {
        closeSearch();
      }
    });
    $('searchOpenBtn').addEventListener('click', function () {
      if ($('searchPanel').hidden) openSearch('');
      else closeSearch();
    });
    $('searchCloseBtn').addEventListener('click', closeSearch);
    $('gpsBtn').addEventListener('click', useGps);
  }

  // ---------------------------------------------------------------------------
  // 데이터 불러오기
  // ---------------------------------------------------------------------------
  function timedFetch(url) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, FETCH_TIMEOUT) : null;
    return fetch(url, ctrl ? { signal: ctrl.signal, cache: 'no-store' } : { cache: 'no-store' })
      .then(function (r) { clearTimeout(timer); return r; },
        function (e) { clearTimeout(timer); throw e; });
  }

  function fetchLive(key, loc, now) {
    var get = function (op, base, rows) {
      return L.fetchKma(timedFetch, L.buildUrl(op, key, base, loc.nx, loc.ny, rows));
    };
    var early = L.getTodayEarlyBase(now);
    var optional = function (p) { return p.catch(function () { return null; }); };
    return Promise.all([
      get('getUltraSrtNcst', L.getNcstBase(now), 100),
      optional(get('getUltraSrtFcst', L.getUltraFcstBase(now), 100)),
      get('getVilageFcst', L.getVilageBase(now), 1000),
      early ? optional(get('getVilageFcst', early, 1000)) : Promise.resolve(null)
    ]);
  }

  function load() {
    var seq = ++loadSeq;
    var now = new Date();

    if (isDemo) {
      var s = window.SampleData.makeSampleResponses(now);
      var place = s.place, grid = s.grid;
      if (demoRegion) {
        place = L.displayName(demoRegion) + ' (예시)';
        grid = L.latLonToGrid(demoRegion.lat, demoRegion.lon);
      }
      $('placeLabel').textContent = place + ' · 격자 ' + grid.nx + ',' + grid.ny;
      try {
        render(L.buildWeather(
          L.parseResponse(s.ncst), L.parseResponse(s.ultra),
          L.parseResponse(s.vilage), s.early ? L.parseResponse(s.early) : null, now
        ), grid, now);
      } catch (e) {
        showError(L.friendlyMessage(e));
      }
      return;
    }

    var key = getKey();
    if (!key) { openSettings(true); return; }

    var loc;
    resolveLocation().then(function (l) {
      if (seq !== loadSeq) return null;
      loc = l;
      $('placeLabel').textContent = loc.label + ' · 격자 ' + loc.nx + ',' + loc.ny;
      showLoading();
      return fetchLive(key, loc, now);
    }).then(function (r) {
      if (!r || seq !== loadSeq) return;
      render(L.buildWeather(r[0], r[1], r[2], r[3], now), loc, now);
    }).catch(function (e) {
      if (seq !== loadSeq) return;
      if (window.console) console.warn('[오늘 뭐 입지]', e && (e.detail || e.message));
      showError(L.friendlyMessage(e));
    });
  }

  // ---------------------------------------------------------------------------
  // 렌더링
  // ---------------------------------------------------------------------------
  function deg(v) {
    if (v === null || v === undefined) return '--°';
    return (Math.round(v * 10) / 10) + '°';
  }

  function ptyLabel(pty) {
    return ({ 1: '비', 2: '비/눈', 3: '눈', 4: '소나기', 5: '빗방울', 6: '빗방울/눈날림', 7: '눈날림' })[pty] || '';
  }

  function render(w, loc, now) {
    var rec = L.recommend(w);
    var c = w.current, d = w.today;

    document.body.className = 'theme-' + w.theme;

    $('skyEmoji').textContent = c.skyInfo.emoji;
    $('curTemp').textContent = deg(c.temp);
    $('skyLabel').textContent = c.skyInfo.label;
    $('feels').textContent = deg(c.feels);
    $('tMin').textContent = d.min !== null ? Math.round(d.min) + '°' : '--°';
    $('tMax').textContent = d.max !== null ? Math.round(d.max) + '°' : '--°';

    $('band').textContent = '체감 ' + rec.band;
    $('summary').textContent = rec.summary;
    $('topEmoji').textContent = rec.top.emoji;
    $('topText').textContent = rec.top.text;
    $('bottomEmoji').textContent = rec.bottom.emoji;
    $('bottomText').textContent = rec.bottom.text;
    $('outerEmoji').textContent = rec.outer ? rec.outer.emoji : '🚫';
    $('outerText').textContent = rec.outer ? rec.outer.text : '필요 없어요';

    var tips = $('tips');
    tips.textContent = '';
    rec.tips.forEach(function (t) {
      var li = document.createElement('li');
      li.textContent = t.emoji + ' ' + t.text;
      tips.appendChild(li);
    });

    $('humidity').textContent = c.humidity !== null ? c.humidity + '%' : '--';
    $('wind').textContent = c.wind !== null ? c.wind + 'm/s' : '--';
    $('precipNow').textContent = c.rn1 > 0 ? c.rn1 + 'mm' : (c.pty > 0 ? ptyLabel(c.pty) : '없음');
    $('pop').textContent = d.popMax !== null ? d.popMax + '%' : '--';

    var hourly = $('hourly');
    hourly.textContent = '';
    w.hourly.forEach(function (h) {
      var el = document.createElement('div');
      el.className = 'hour';
      var parts = [
        ['h-time', (h.hour === 0 ? '내일 ' : '') + h.hour + '시'],
        ['h-emoji', h.skyInfo.emoji],
        ['h-temp', h.temp !== null ? Math.round(h.temp) + '°' : '-'],
        ['h-pop', h.pop !== null ? '💧' + h.pop + '%' : '']
      ];
      parts.forEach(function (p) {
        var div = document.createElement('div');
        div.className = p[0];
        div.textContent = p[1];
        el.appendChild(div);
      });
      hourly.appendChild(el);
    });

    var kp = L.kstParts(now);
    var obs = w.baseInfo.ncstTime ? w.baseInfo.ncstTime.slice(0, 2) + ':00 관측' : '';
    $('updated').textContent = (isDemo ? '예시 데이터 · ' : '') + '기상청 ' + obs +
      ' · ' + String(kp.hour).padStart(2, '0') + ':' + String(kp.minute).padStart(2, '0') + ' 업데이트';

    hideStatus();
    closeSettings();
    $('main').hidden = false;
  }

  // ---------------------------------------------------------------------------
  // 시작
  // ---------------------------------------------------------------------------
  function init() {
    bindSettings();
    bindSearch();
    $('refreshBtn').addEventListener('click', load);
    try { localStorage.removeItem('wo.city'); } catch (e) { /* 예전 15개 도시 선택값 정리 */ }

    if (isDemo) {
      $('demoBanner').hidden = false;
      setLocationMode('manual');
    }

    load();

    // 스크린샷용: ?demo=1&q=광 -> 검색창을 열고 추천 목록 표시
    if (isDemo && params.has('q')) openSearch(params.get('q'), '', true);

    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      navigator.serviceWorker.register('./sw.js').catch(function () { /* 오프라인 캐시 없이 동작 */ });
    }
  }

  init();
})();
