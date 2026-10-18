/* 오늘 뭐 입지? — 화면/네트워크 */
(function () {
  'use strict';

  var L = window.WeatherLib;
  var LS_KEY = 'wo.kmaKey';
  var LS_CITY = 'wo.city';
  var FETCH_TIMEOUT = 12000;

  var isDemo = new URLSearchParams(location.search).get('demo') === '1';
  var loading = false;

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
  function fillCitySelect() {
    var sel = $('citySelect');
    var gps = document.createElement('option');
    gps.value = 'gps';
    gps.textContent = '현재 위치';
    sel.appendChild(gps);
    L.CITIES.forEach(function (c) {
      var o = document.createElement('option');
      o.value = c.name;
      o.textContent = c.name;
      sel.appendChild(o);
    });
    sel.addEventListener('change', function () {
      try {
        if (sel.value === 'gps') localStorage.removeItem(LS_CITY);
        else localStorage.setItem(LS_CITY, sel.value);
      } catch (e) { /* noop */ }
      load();
    });
  }

  function savedCity() {
    try { return localStorage.getItem(LS_CITY); } catch (e) { return null; }
  }

  function cityByName(name) {
    for (var i = 0; i < L.CITIES.length; i++) if (L.CITIES[i].name === name) return L.CITIES[i];
    return null;
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

  function cityLocation(city, note) {
    var g = L.latLonToGrid(city.lat, city.lon);
    $('citySelect').value = city.name;
    return { nx: g.nx, ny: g.ny, label: city.name + (note ? ' · ' + note : '') };
  }

  function resolveLocation() {
    var name = savedCity();
    var city = name && cityByName(name);
    if (city) return Promise.resolve(cityLocation(city));

    showLoading('현재 위치를 확인하는 중…');
    return getGps().then(function (c) {
      var g = L.latLonToGrid(c.latitude, c.longitude);
      var near = L.nearestCity(c.latitude, c.longitude).city;
      $('citySelect').value = 'gps';
      return { nx: g.nx, ny: g.ny, label: near.name + ' 근처' };
    }, function () {
      return cityLocation(cityByName('서울'), '위치 권한이 없어 도시를 선택해 주세요');
    });
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
    if (loading) return;
    var now = new Date();

    if (isDemo) {
      var s = window.SampleData.makeSampleResponses(now);
      $('placeLabel').textContent = s.place + ' · 격자 ' + s.grid.nx + ',' + s.grid.ny;
      try {
        render(L.buildWeather(
          L.parseResponse(s.ncst), L.parseResponse(s.ultra),
          L.parseResponse(s.vilage), s.early ? L.parseResponse(s.early) : null, now
        ), { nx: s.grid.nx, ny: s.grid.ny }, now);
      } catch (e) {
        showError(L.friendlyMessage(e));
      }
      return;
    }

    var key = getKey();
    if (!key) { openSettings(true); return; }

    loading = true;
    var loc;
    resolveLocation().then(function (l) {
      loc = l;
      $('placeLabel').textContent = loc.label + ' · 격자 ' + loc.nx + ',' + loc.ny;
      showLoading();
      return fetchLive(key, loc, now);
    }).then(function (r) {
      loading = false;
      render(L.buildWeather(r[0], r[1], r[2], r[3], now), loc, now);
    }).catch(function (e) {
      loading = false;
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
    fillCitySelect();
    bindSettings();
    $('refreshBtn').addEventListener('click', load);

    if (isDemo) {
      $('demoBanner').hidden = false;
      $('citySelect').hidden = true;
    }

    load();

    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      navigator.serviceWorker.register('./sw.js').catch(function () { /* 오프라인 캐시 없이 동작 */ });
    }
  }

  init();
})();
