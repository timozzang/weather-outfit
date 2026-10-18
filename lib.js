/*
 * 오늘 뭐 입지? — 순수 로직 모듈
 * 브라우저(window.WeatherLib)와 node(module.exports) 양쪽에서 사용 가능.
 * DOM / fetch 전역에 의존하지 않는다.
 */
(function (root) {
  'use strict';

  var API_BASE = 'https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0';
  var HOUR = 3600 * 1000;
  var MIN = 60 * 1000;
  var KST_OFFSET = 9 * HOUR;

  // ---------------------------------------------------------------------------
  // 도시 목록 (GPS 실패 시 선택 / GPS 사용 시 가장 가까운 도시 표시)
  // ---------------------------------------------------------------------------
  var CITIES = [
    { name: '서울', lat: 37.5665, lon: 126.9780 },
    { name: '부산', lat: 35.1796, lon: 129.0756 },
    { name: '대구', lat: 35.8714, lon: 128.6014 },
    { name: '인천', lat: 37.4563, lon: 126.7052 },
    { name: '광주', lat: 35.1595, lon: 126.8526 },
    { name: '대전', lat: 36.3504, lon: 127.3845 },
    { name: '울산', lat: 35.5384, lon: 129.3114 },
    { name: '세종', lat: 36.4800, lon: 127.2890 },
    { name: '수원', lat: 37.2636, lon: 127.0286 },
    { name: '춘천', lat: 37.8813, lon: 127.7298 },
    { name: '강릉', lat: 37.7519, lon: 128.8761 },
    { name: '청주', lat: 36.6424, lon: 127.4890 },
    { name: '전주', lat: 35.8242, lon: 127.1480 },
    { name: '포항', lat: 36.0190, lon: 129.3435 },
    { name: '제주', lat: 33.4996, lon: 126.5312 }
  ];

  function nearestCity(lat, lon) {
    var best = null;
    var bestD = Infinity;
    for (var i = 0; i < CITIES.length; i++) {
      var d = distanceKm(lat, lon, CITIES[i].lat, CITIES[i].lon);
      if (d < bestD) { bestD = d; best = CITIES[i]; }
    }
    return { city: best, distanceKm: bestD };
  }

  function distanceKm(lat1, lon1, lat2, lon2) {
    var R = 6371;
    var toRad = Math.PI / 180;
    var dLat = (lat2 - lat1) * toRad;
    var dLon = (lon2 - lon1) * toRad;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // ---------------------------------------------------------------------------
  // 전국 시·군·구 검색 (regions.js: [이름, 시도, 시도약칭, 위도, 경도])
  // ---------------------------------------------------------------------------
  var CHOSEONG = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';

  function normalizeQuery(s) { return String(s || '').replace(/\s+/g, ''); }

  function isChoseong(ch) { return CHOSEONG.indexOf(ch) >= 0; }

  function choseongOf(ch) {
    var c = ch.charCodeAt(0) - 0xAC00;
    return c >= 0 && c < 11172 ? CHOSEONG[Math.floor(c / 588)] : ch;
  }

  // '광양시' -> '광양', '수원시 팔달구' -> '수원팔달'. 한 글자만 남으면('중구') 그대로 둔다.
  function stripSuffix(name) {
    return name.split(' ').map(function (t) {
      return t.length > 2 && /[시군구]$/.test(t) ? t.slice(0, -1) : t;
    }).join('');
  }

  // 원본 배열 -> 지역 객체. 구로 나뉜 시(수원시 등)는 구 좌표 평균으로 상위 시를 합성한다.
  function buildRegions(raw) {
    var list = raw.map(function (r) {
      return { name: r[0], sido: r[1], sidoShort: r[2], lat: r[3], lon: r[4] };
    });
    var parents = {};
    list.forEach(function (r) {
      var sp = r.name.indexOf(' ');
      if (sp < 0) return;
      var pname = r.name.slice(0, sp);
      var id = r.sidoShort + ' ' + pname;
      var p = parents[id] || (parents[id] = { name: pname, sido: r.sido, sidoShort: r.sidoShort, lat: 0, lon: 0, n: 0 });
      p.lat += r.lat; p.lon += r.lon; p.n++;
    });
    Object.keys(parents).forEach(function (id) {
      var p = parents[id];
      list.push({ name: p.name, sido: p.sido, sidoShort: p.sidoShort,
        lat: round4(p.lat / p.n), lon: round4(p.lon / p.n), synthetic: true });
    });
    var count = {};
    list.forEach(function (r) { count[r.name] = (count[r.name] || 0) + 1; });
    list.forEach(function (r) {
      r.id = r.sidoShort + ' ' + r.name;
      r.dup = count[r.name] > 1;
      var n = normalizeQuery(r.name), st = stripSuffix(r.name);
      // [검색 키, 키 종류(0: 이름, 1: 시도약칭+이름, 2: 시도+이름)]
      r.keys = [[n, 0], [st, 0],
        [r.sidoShort + n, 1], [r.sidoShort + st, 1], [r.sido + n, 2], [r.sido + st, 2]];
    });
    return list;
  }

  function round4(x) { return Math.round(x * 10000) / 10000; }

  // 원본 배열이 들어오면 한 번만 변환해 캐시
  var regionCache = [];
  function toRegions(regions) {
    if (!regions || !regions.length || !Array.isArray(regions[0])) return regions || [];
    for (var i = 0; i < regionCache.length; i++) if (regionCache[i][0] === regions) return regionCache[i][1];
    var built = buildRegions(regions);
    regionCache.push([regions, built]);
    return built;
  }

  // 초성이 섞인 질의('ㄱㅇ', '광ㅇ')를 위한 글자 단위 비교
  function jamoIndexOf(target, q) {
    for (var i = 0; i + q.length <= target.length; i++) {
      var j = 0;
      while (j < q.length && (target[i + j] === q[j] ||
        (isChoseong(q[j]) && choseongOf(target[i + j]) === q[j]))) j++;
      if (j === q.length) return i;
    }
    return -1;
  }

  // 순위: 0 이름 일치 > 1 앞부분 일치 > 2 포함 > 3 초성. 같은 단계면 이름 키가 시도 키보다 앞선다.
  // 시도 전체 이름 키는 앞부분 일치만 본다('광역'이 모든 광역시 구에 걸리지 않도록).
  function matchScore(r, q, jamo) {
    var best = Infinity;
    for (var i = 0; i < r.keys.length; i++) {
      var k = r.keys[i][0], kind = r.keys[i][1], tier;
      if (kind === 2 && (jamo || k.indexOf(q) !== 0)) continue;
      if (jamo) {
        var at = jamoIndexOf(k, q);
        if (at < 0) continue;
        tier = 3 + (at === 0 ? 0 : 0.5);
      } else if (k === q) tier = 0;
      else if (k.indexOf(q) === 0) tier = 1;
      else if (k.indexOf(q) > 0) tier = 2;
      else continue;
      best = Math.min(best, tier * 10 + kind);
    }
    return best;
  }

  function searchRegions(query, regions, limit) {
    var q = normalizeQuery(query);
    if (!q) return [];
    if (limit === undefined) limit = 8;
    var jamo = /[ㄱ-ㅎ]/.test(q);
    var hits = [];
    toRegions(regions).forEach(function (r) {
      var s = matchScore(r, q, jamo);
      if (s < Infinity) hits.push({ r: r, s: s });
    });
    hits.sort(function (a, b) {
      return a.s - b.s || a.r.name.length - b.r.name.length ||
        (a.r.name < b.r.name ? -1 : a.r.name > b.r.name ? 1 : 0) ||
        (a.r.sidoShort < b.r.sidoShort ? -1 : a.r.sidoShort > b.r.sidoShort ? 1 : 0);
    });
    return hits.slice(0, limit).map(function (h) { return h.r; });
  }

  // 여러 시도에 같은 이름이 있으면('중구') 시도 약칭을 붙인다. 나머지는 이름만(시도는 부제목).
  function displayName(region) {
    return region.dup ? region.sidoShort + ' ' + region.name : region.name;
  }

  function findRegion(id, regions) {
    var list = toRegions(regions);
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  // 합성된 상위 시보다 실제 구 중심이 더 정확하므로 제외
  function nearestRegion(lat, lon, regions) {
    var best = null, bestD = Infinity;
    toRegions(regions).forEach(function (r) {
      if (r.synthetic) return;
      var d = distanceKm(lat, lon, r.lat, r.lon);
      if (d < bestD) { bestD = d; best = r; }
    });
    return best;
  }

  // ---------------------------------------------------------------------------
  // 위경도 -> 기상청 격자 (LCC, 기상청 공식 변환식)
  // ---------------------------------------------------------------------------
  function latLonToGrid(lat, lon) {
    var RE = 6371.00877; // 지구 반경(km)
    var GRID = 5.0;      // 격자 간격(km)
    var SLAT1 = 30.0;    // 투영 위도1
    var SLAT2 = 60.0;    // 투영 위도2
    var OLON = 126.0;    // 기준점 경도
    var OLAT = 38.0;     // 기준점 위도
    var XO = 43;         // 기준점 X좌표(격자)
    var YO = 136;        // 기준점 Y좌표(격자)

    var DEGRAD = Math.PI / 180.0;
    var re = RE / GRID;
    var slat1 = SLAT1 * DEGRAD;
    var slat2 = SLAT2 * DEGRAD;
    var olon = OLON * DEGRAD;
    var olat = OLAT * DEGRAD;

    var sn = Math.tan(Math.PI * 0.25 + slat2 * 0.5) / Math.tan(Math.PI * 0.25 + slat1 * 0.5);
    sn = Math.log(Math.cos(slat1) / Math.cos(slat2)) / Math.log(sn);
    var sf = Math.tan(Math.PI * 0.25 + slat1 * 0.5);
    sf = Math.pow(sf, sn) * Math.cos(slat1) / sn;
    var ro = Math.tan(Math.PI * 0.25 + olat * 0.5);
    ro = re * sf / Math.pow(ro, sn);

    var ra = Math.tan(Math.PI * 0.25 + lat * DEGRAD * 0.5);
    ra = re * sf / Math.pow(ra, sn);
    var theta = lon * DEGRAD - olon;
    if (theta > Math.PI) theta -= 2.0 * Math.PI;
    if (theta < -Math.PI) theta += 2.0 * Math.PI;
    theta *= sn;

    return {
      nx: Math.floor(ra * Math.sin(theta) + XO + 0.5),
      ny: Math.floor(ro - ra * Math.cos(theta) + YO + 0.5)
    };
  }

  // ---------------------------------------------------------------------------
  // KST 시간 유틸 (기기 시간대와 무관)
  // "KST 벽시계" 값을 UTC 필드에 담은 Date 를 사용한다.
  // ---------------------------------------------------------------------------
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function toKst(date) {
    var ms = (date instanceof Date) ? date.getTime() : Number(date);
    return new Date(ms + KST_OFFSET);
  }

  function kstParts(date) {
    var k = toKst(date);
    return {
      year: k.getUTCFullYear(),
      month: k.getUTCMonth() + 1,
      day: k.getUTCDate(),
      hour: k.getUTCHours(),
      minute: k.getUTCMinutes()
    };
  }

  function kstDateStr(date) {
    var p = kstParts(date);
    return p.year + pad2(p.month) + pad2(p.day);
  }

  function kstHourStr(date) {
    return pad2(kstParts(date).hour) + '00';
  }

  // 초단기실황: 매시 정각 기준, 매시 40분 이후 제공
  function getNcstBase(now) {
    var t = new Date(now.getTime() - 40 * MIN);
    return { base_date: kstDateStr(t), base_time: pad2(kstParts(t).hour) + '00' };
  }

  // 초단기예보: 매시 30분 기준, 매시 45분 이후 제공
  function getUltraFcstBase(now) {
    var t = new Date(now.getTime() - 45 * MIN);
    return { base_date: kstDateStr(t), base_time: pad2(kstParts(t).hour) + '30' };
  }

  // 단기예보: 02,05,08,11,14,17,20,23시 기준, +10분 이후 제공
  var VILAGE_HOURS = [2, 5, 8, 11, 14, 17, 20, 23];
  function getVilageBase(now) {
    var t = new Date(now.getTime() - 10 * MIN);
    var h = kstParts(t).hour;
    var baseHour = -1;
    for (var i = 0; i < VILAGE_HOURS.length; i++) {
      if (VILAGE_HOURS[i] <= h) baseHour = VILAGE_HOURS[i];
    }
    if (baseHour < 0) {
      // 00:00~02:09 -> 전날 23시
      var prev = new Date(t.getTime() - 24 * HOUR);
      return { base_date: kstDateStr(prev), base_time: '2300' };
    }
    return { base_date: kstDateStr(t), base_time: pad2(baseHour) + '00' };
  }

  // 오늘 TMN/TMX 를 확실히 얻기 위한 오늘 02시 발표분 (02:10 이후에만)
  function getTodayEarlyBase(now) {
    var p = kstParts(now);
    if (p.hour > 2 || (p.hour === 2 && p.minute >= 10)) {
      return { base_date: kstDateStr(now), base_time: '0200' };
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // URL
  // ---------------------------------------------------------------------------
  // Decoding 키를 저장하도록 안내하지만, Encoding 키(%xx 포함)를 붙여넣어도 동작하게 한다.
  function normalizeKey(key) {
    var k = String(key || '').trim();
    if (/%[0-9A-Fa-f]{2}/.test(k)) {
      try { k = decodeURIComponent(k); } catch (e) { /* 그대로 사용 */ }
    }
    return k;
  }

  // config.js 의 기본 키: 빈 값이거나 아직 자리표시자(__KMA_KEY__ 등)면 없는 것으로 본다.
  function usableEmbeddedKey(k) {
    k = String(k || '').trim();
    if (!k || /^__[A-Z0-9_]+__$/.test(k)) return '';
    return k;
  }

  // 사용할 키: localStorage 키 > config.js 기본 키. 둘 다 없으면 '' (설정 화면 필요)
  function resolveKey(storedKey, embeddedKey) {
    return String(storedKey || '').trim() || usableEmbeddedKey(embeddedKey);
  }

  function buildUrl(operation, key, base, nx, ny, numOfRows) {
    return API_BASE + '/' + operation +
      '?serviceKey=' + encodeURIComponent(normalizeKey(key)) +
      '&pageNo=1' +
      '&numOfRows=' + (numOfRows || 100) +
      '&dataType=JSON' +
      '&base_date=' + base.base_date +
      '&base_time=' + base.base_time +
      '&nx=' + nx +
      '&ny=' + ny;
  }

  // ---------------------------------------------------------------------------
  // 응답 파싱 / 에러
  // ---------------------------------------------------------------------------
  var ERROR_MESSAGES = {
    NETWORK: '네트워크에 연결할 수 없어요. 인터넷 연결을 확인해 주세요.',
    TIMEOUT: '기상청 서버 응답이 너무 늦어요. 잠시 후 다시 시도해 주세요.',
    PARSE: '기상청 응답을 해석할 수 없어요. 잠시 후 다시 시도해 주세요.',
    HTTP: '기상청 서버에 문제가 있어요. 잠시 후 다시 시도해 주세요.',
    NO_KEY: '인증키가 설정되지 않았어요. 설정에서 공공데이터포털 인증키를 입력해 주세요.',
    '01': '기상청 서버 내부 오류예요. 잠시 후 다시 시도해 주세요.',
    '02': '기상청 데이터베이스 오류예요. 잠시 후 다시 시도해 주세요.',
    '03': '아직 발표된 예보 데이터가 없어요. 잠시 후 다시 시도해 주세요.',
    '04': '기상청 서버 통신 오류예요. 잠시 후 다시 시도해 주세요.',
    '05': '기상청 서버 응답 시간이 초과됐어요. 잠시 후 다시 시도해 주세요.',
    '10': '요청 값이 올바르지 않아요.',
    '11': '필수 요청 값이 빠졌어요.',
    '12': '해당 오픈API 서비스가 없거나 폐기됐어요.',
    '20': '서비스 접근이 거부됐어요. 공공데이터포털에서 활용신청 상태를 확인해 주세요.',
    '21': '일시적으로 사용할 수 없는 인증키예요.',
    '22': '오늘 요청 한도를 초과했어요. 내일 다시 시도해 주세요.',
    '30': '등록되지 않은 인증키예요. 설정에서 공공데이터포털 인증키(Decoding)를 확인해 주세요. 신청 직후라면 승인 반영까지 최대 1~2시간 걸릴 수 있어요.',
    '31': '인증키 활용기간이 만료됐어요. 공공데이터포털에서 연장 신청해 주세요.',
    '32': '등록되지 않은 IP에서 요청했어요.',
    '33': '서명되지 않은 호출이에요.',
    '99': '알 수 없는 오류가 발생했어요. 잠시 후 다시 시도해 주세요.'
  };

  var AUTH_MSG_TO_CODE = {
    APPLICATION_ERROR: '01',
    DB_ERROR: '02',
    NODATA_ERROR: '03',
    NO_DATA: '03',
    HTTP_ERROR: '04',
    SERVICETIMEOUT_ERROR: '05',
    SERVICE_TIMEOUT_ERROR: '05',
    INVALID_REQUEST_PARAMETER_ERROR: '10',
    NO_MANDATORY_REQUEST_PARAMETERS_ERROR: '11',
    NO_OPENAPI_SERVICE_ERROR: '12',
    SERVICE_ACCESS_DENIED_ERROR: '20',
    TEMPORARILY_DISABLE_THE_SERVICEKEY_ERROR: '21',
    LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR: '22',
    SERVICE_KEY_IS_NOT_REGISTERED_ERROR: '30',
    DEADLINE_HAS_EXPIRED_ERROR: '31',
    UNREGISTERED_IP_ERROR: '32',
    UNSIGNED_CALL_ERROR: '33',
    UNKNOWN_ERROR: '99'
  };

  function KmaError(code, detail) {
    var msg = ERROR_MESSAGES[code] || ERROR_MESSAGES['99'];
    var err = new Error(msg);
    err.name = 'KmaError';
    err.code = code;
    err.detail = detail || '';
    return err;
  }

  function friendlyMessage(err) {
    if (err && err.name === 'KmaError') return err.message;
    return ERROR_MESSAGES['99'];
  }

  function xmlTag(text, tag) {
    var m = new RegExp('<' + tag + '>\\s*([^<]*?)\\s*</' + tag + '>').exec(text);
    return m ? m[1] : null;
  }

  function codeFromXml(text) {
    var authMsg = xmlTag(text, 'returnAuthMsg');
    var reason = xmlTag(text, 'returnReasonCode');
    var resultCode = xmlTag(text, 'resultCode');
    var errMsg = xmlTag(text, 'errMsg');
    var resultMsg = xmlTag(text, 'resultMsg');
    var detail = authMsg || resultMsg || errMsg || 'XML 오류 응답';
    if (authMsg && AUTH_MSG_TO_CODE[authMsg]) return { code: AUTH_MSG_TO_CODE[authMsg], detail: detail };
    if (reason && ERROR_MESSAGES[pad2(Number(reason))]) return { code: pad2(Number(reason)), detail: detail };
    if (resultCode && resultCode !== '00' && ERROR_MESSAGES[resultCode]) return { code: resultCode, detail: detail };
    if (resultMsg && AUTH_MSG_TO_CODE[resultMsg]) return { code: AUTH_MSG_TO_CODE[resultMsg], detail: detail };
    return { code: '99', detail: detail };
  }

  // 응답 문자열 -> item 배열. 오류면 KmaError throw.
  function parseResponse(text) {
    var body = String(text == null ? '' : text).replace(/^﻿/, '').trim();
    if (!body) throw KmaError('PARSE', 'empty body');
    if (body.charAt(0) === '<') {
      var x = codeFromXml(body);
      throw KmaError(x.code, x.detail);
    }
    var json;
    try {
      json = JSON.parse(body);
    } catch (e) {
      throw KmaError('PARSE', body.slice(0, 80));
    }
    var res = json && json.response;
    var header = res && res.header;
    if (!header) throw KmaError('PARSE', 'no header');
    var code = String(header.resultCode);
    if (code !== '00') {
      throw KmaError(ERROR_MESSAGES[code] ? code : '99', header.resultMsg || code);
    }
    var items = res.body && res.body.items && res.body.items.item;
    if (!items) return [];
    return Array.isArray(items) ? items : [items];
  }

  // fetchFn: window.fetch 호환 함수. 네트워크/HTTP 오류도 KmaError 로 변환.
  function fetchKma(fetchFn, url) {
    var p;
    try {
      p = Promise.resolve(fetchFn(url));
    } catch (e) {
      p = Promise.reject(e);
    }
    return p.then(function (resp) {
      return resp.text().then(function (text) {
        if (!resp.ok) {
          // 오류 본문(XML 등)이 있으면 그 내용을 우선 해석
          var t = String(text || '').trim();
          if (t.charAt(0) === '<' || t.charAt(0) === '{') return parseResponse(t);
          throw KmaError('HTTP', 'status ' + resp.status);
        }
        return parseResponse(text);
      });
    }, function (e) {
      if (e && e.name === 'AbortError') throw KmaError('TIMEOUT', e.message);
      throw KmaError('NETWORK', e && e.message);
    });
  }

  // ---------------------------------------------------------------------------
  // 값 해석
  // ---------------------------------------------------------------------------
  function num(v) {
    if (v === undefined || v === null || v === '') return null;
    var n = Number(v);
    if (!isFinite(n)) return null;
    if (Math.abs(n) >= 900) return null; // 기상청 결측값(+900/-999 등)
    return n;
  }

  // 강수량(RN1/PCP) 문자열 -> mm 숫자
  // "강수없음" -> 0, "1mm 미만"/"1.0mm 미만" -> 0.5, "1.5mm" -> 1.5,
  // "30.0~50.0mm" -> 30, "50.0mm 이상" -> 50, 숫자 문자열 -> 숫자
  function parsePrecip(v) {
    if (v === undefined || v === null) return 0;
    var s = String(v).trim();
    if (!s || s === '-' || s.indexOf('없음') >= 0) return 0;
    if (s.indexOf('미만') >= 0) return 0.5;
    var m = /(-?\d+(?:\.\d+)?)/.exec(s);
    if (!m) return 0;
    var n = Number(m[1]);
    if (!isFinite(n) || n < 0 || n >= 900) return 0;
    return n;
  }

  function parseNcst(items) {
    var out = { T1H: null, REH: null, RN1: 0, WSD: null, PTY: 0, baseDate: null, baseTime: null };
    (items || []).forEach(function (it) {
      if (!out.baseDate) { out.baseDate = it.baseDate; out.baseTime = it.baseTime; }
      if (it.category === 'RN1') out.RN1 = parsePrecip(it.obsrValue);
      else if (it.category === 'PTY') out.PTY = num(it.obsrValue) || 0;
      else if (['T1H', 'REH', 'WSD', 'UUU', 'VVV', 'VEC'].indexOf(it.category) >= 0) out[it.category] = num(it.obsrValue);
    });
    return out;
  }

  // 예보 item 배열 -> 시각별 슬롯 { date, time, key, values:{CAT:raw} } (시간순)
  function groupFcst(items) {
    var map = {};
    (items || []).forEach(function (it) {
      if (!it || !it.fcstDate || !it.fcstTime) return;
      var key = it.fcstDate + it.fcstTime;
      if (!map[key]) map[key] = { date: it.fcstDate, time: it.fcstTime, key: key, values: {} };
      map[key].values[it.category] = it.fcstValue;
    });
    return Object.keys(map).sort().map(function (k) { return map[k]; });
  }

  // ---------------------------------------------------------------------------
  // 체감온도
  // ---------------------------------------------------------------------------
  function windChill(t, windMs) {
    var v = Math.pow(windMs * 3.6, 0.16);
    return 13.12 + 0.6215 * t - 11.37 * v + 0.3965 * t * v;
  }

  // 기상청 여름철 체감온도 (습구온도 Stull 추정식 기반)
  function summerFeelsLike(t, rh) {
    var tw = t * Math.atan(0.151977 * Math.sqrt(rh + 8.313659)) +
      Math.atan(t + rh) - Math.atan(rh - 1.67633) +
      0.00391838 * Math.pow(rh, 1.5) * Math.atan(0.023101 * rh) - 4.686035;
    return -0.2442 + 0.55399 * tw + 0.45535 * t - 0.0022 * tw * tw + 0.00278 * tw * t + 3.0;
  }

  function round1(x) { return Math.round(x * 10) / 10; }

  function feelsLike(t, windMs, rh) {
    if (t === null || t === undefined) return null;
    if (t <= 10 && windMs !== null && windMs > 1.3) return round1(windChill(t, windMs));
    if (t >= 25 && rh !== null && rh !== undefined) return round1(summerFeelsLike(t, rh));
    return t;
  }

  // ---------------------------------------------------------------------------
  // 하늘 상태
  // ---------------------------------------------------------------------------
  // PTY: 0 없음, 1 비, 2 비/눈, 3 눈, 4 소나기, 5 빗방울, 6 빗방울눈날림, 7 눈날림
  // SKY: 1 맑음, 3 구름많음, 4 흐림
  function skyInfo(sky, pty, isNight) {
    sky = Number(sky); pty = Number(pty) || 0;
    switch (pty) {
      case 1: return { label: '비', emoji: '🌧️', theme: 'rain' };
      case 2: return { label: '비/눈', emoji: '🌨️', theme: 'snow' };
      case 3: return { label: '눈', emoji: '❄️', theme: 'snow' };
      case 4: return { label: '소나기', emoji: '🌦️', theme: 'rain' };
      case 5: return { label: '빗방울', emoji: '🌦️', theme: 'rain' };
      case 6: return { label: '빗방울/눈날림', emoji: '🌨️', theme: 'snow' };
      case 7: return { label: '눈날림', emoji: '🌨️', theme: 'snow' };
    }
    if (sky === 1) return isNight
      ? { label: '맑음', emoji: '🌙', theme: 'night' }
      : { label: '맑음', emoji: '☀️', theme: 'clear' };
    if (sky === 3) return isNight
      ? { label: '구름많음', emoji: '☁️', theme: 'night' }
      : { label: '구름많음', emoji: '⛅', theme: 'cloudy' };
    if (sky === 4) return { label: '흐림', emoji: '☁️', theme: isNight ? 'night' : 'overcast' };
    return { label: '-', emoji: '🌡️', theme: isNight ? 'night' : 'cloudy' };
  }

  function isNightHour(h) { return h < 6 || h >= 19; }

  // ---------------------------------------------------------------------------
  // 날씨 종합
  // ---------------------------------------------------------------------------
  // ncstItems, ultraItems, vilageItems, earlyItems: 각 API 의 item 배열 (ultra/early 는 null 가능)
  function buildWeather(ncstItems, ultraItems, vilageItems, earlyItems, now) {
    var ncst = parseNcst(ncstItems);
    var ultra = groupFcst(ultraItems || []);
    var vilage = groupFcst(vilageItems || []);
    var early = groupFcst(earlyItems || []);

    var today = kstDateStr(now);
    var p = kstParts(now);
    var nowKey = today + pad2(p.hour) + '00';

    // 현재 하늘: 초단기예보 가장 이른 슬롯 -> 없으면 단기예보 현재 시각 이후 첫 슬롯
    var skySlot = null;
    for (var i = 0; i < ultra.length; i++) {
      if (ultra[i].values.SKY !== undefined) { skySlot = ultra[i]; break; }
    }
    if (!skySlot) {
      for (var j = 0; j < vilage.length; j++) {
        if (vilage[j].key >= nowKey && vilage[j].values.SKY !== undefined) { skySlot = vilage[j]; break; }
      }
    }
    var sky = skySlot ? num(skySlot.values.SKY) : null;
    var temp = ncst.T1H;
    var wind = ncst.WSD;
    var humidity = ncst.REH;
    var night = isNightHour(p.hour);

    var current = {
      temp: temp,
      humidity: humidity,
      wind: wind,
      rn1: ncst.RN1,
      pty: ncst.PTY,
      sky: sky,
      feels: feelsLike(temp, wind, humidity),
      skyInfo: skyInfo(sky, ncst.PTY, night),
      raining: ncst.PTY > 0 || ncst.RN1 > 0,
      snowing: ncst.PTY === 3 || ncst.PTY === 7
    };

    // 오늘 최저/최고: TMN/TMX(오늘 02시 발표분 우선) + 오늘 TMP + 현재 기온
    var tmn = null, tmx = null;
    var temps = [];
    [early, vilage].forEach(function (slots) {
      slots.forEach(function (s) {
        if (s.date !== today) return;
        var v = s.values;
        if (v.TMN !== undefined && tmn === null) tmn = num(v.TMN);
        if (v.TMX !== undefined && tmx === null) tmx = num(v.TMX);
        var t = num(v.TMP);
        if (t !== null) temps.push(t);
      });
    });
    if (temp !== null) temps.push(temp);
    var candMin = temps.slice(); if (tmn !== null) candMin.push(tmn);
    var candMax = temps.slice(); if (tmx !== null) candMax.push(tmx);
    var min = candMin.length ? Math.min.apply(null, candMin) : null;
    var max = candMax.length ? Math.max.apply(null, candMax) : null;

    // 오늘 남은 시간 강수
    var popMax = null, pcpRemain = 0, rainLater = false, snowLater = false;
    vilage.forEach(function (s) {
      if (s.date !== today || s.key < nowKey) return;
      var v = s.values;
      var pop = num(v.POP);
      if (pop !== null) popMax = popMax === null ? pop : Math.max(popMax, pop);
      var pcp = parsePrecip(v.PCP);
      pcpRemain += pcp;
      var pty = num(v.PTY) || 0;
      if (pty > 0 || pcp > 0) rainLater = true;
      if (pty === 3) snowLater = true;
    });

    // 시간별 (다음 시각부터 12개): 단기예보 기반, 비어있으면 초단기예보로 보충
    var hourlyMap = {};
    ultra.forEach(function (s) {
      if (s.key <= nowKey) return;
      hourlyMap[s.key] = {
        key: s.key, date: s.date, time: s.time,
        temp: num(s.values.T1H), sky: num(s.values.SKY), pty: num(s.values.PTY) || 0, pop: null
      };
    });
    vilage.forEach(function (s) {
      if (s.key <= nowKey) return;
      var prev = hourlyMap[s.key] || {};
      var t = num(s.values.TMP);
      hourlyMap[s.key] = {
        key: s.key, date: s.date, time: s.time,
        temp: t !== null ? t : (prev.temp !== undefined ? prev.temp : null),
        sky: num(s.values.SKY) !== null ? num(s.values.SKY) : (prev.sky !== undefined ? prev.sky : null),
        pty: s.values.PTY !== undefined ? (num(s.values.PTY) || 0) : (prev.pty || 0),
        pop: num(s.values.POP)
      };
    });
    var hourly = Object.keys(hourlyMap).sort().slice(0, 12).map(function (k) {
      var h = hourlyMap[k];
      var hour = Number(h.time.slice(0, 2));
      h.hour = hour;
      h.skyInfo = skyInfo(h.sky, h.pty, isNightHour(hour));
      return h;
    });

    return {
      current: current,
      today: {
        min: min, max: max, tmn: tmn, tmx: tmx,
        range: (min !== null && max !== null) ? round1(max - min) : null,
        popMax: popMax, pcpRemain: round1(pcpRemain),
        rainLater: rainLater, snowLater: snowLater
      },
      hourly: hourly,
      theme: current.skyInfo.theme,
      baseInfo: { ncstDate: ncst.baseDate, ncstTime: ncst.baseTime }
    };
  }

  // ---------------------------------------------------------------------------
  // 옷차림 추천
  // ---------------------------------------------------------------------------
  var BANDS = [
    { min: 28, label: '28°C 이상', emoji: '🥵',
      top: { emoji: '🎽', text: '민소매 · 반팔' },
      bottom: { emoji: '🩳', text: '반바지 · 린넨 바지' },
      outer: null,
      base: '민소매나 반팔에 반바지' },
    { min: 23, label: '23~27°C', emoji: '😎',
      top: { emoji: '👕', text: '반팔 · 얇은 셔츠' },
      bottom: { emoji: '🩳', text: '반바지 · 면바지' },
      outer: null,
      base: '반팔에 가벼운 면바지' },
    { min: 20, label: '20~22°C', emoji: '🙂',
      top: { emoji: '👔', text: '얇은 긴팔 · 블라우스' },
      bottom: { emoji: '👖', text: '면바지 · 슬랙스' },
      outer: { emoji: '🧥', text: '얇은 가디건 (선택)' },
      base: '얇은 긴팔에 면바지' },
    { min: 17, label: '17~19°C', emoji: '😊',
      top: { emoji: '👚', text: '얇은 니트 · 맨투맨' },
      bottom: { emoji: '👖', text: '청바지 · 면바지' },
      outer: { emoji: '🧥', text: '가디건 · 얇은 바람막이' },
      base: '맨투맨이나 얇은 니트' },
    { min: 12, label: '12~16°C', emoji: '🍂',
      top: { emoji: '🧶', text: '얇은 니트 · 셔츠' },
      bottom: { emoji: '👖', text: '청바지 · 면바지' },
      outer: { emoji: '🧥', text: '가디건 · 자켓' },
      base: '얇은 니트에 가디건' },
    { min: 9, label: '9~11°C', emoji: '🍁',
      top: { emoji: '🧶', text: '니트 · 셔츠' },
      bottom: { emoji: '👖', text: '청바지 · 슬랙스' },
      outer: { emoji: '🧥', text: '트렌치코트 · 야상' },
      base: '니트에 트렌치코트' },
    { min: 5, label: '5~8°C', emoji: '🥶',
      top: { emoji: '🧶', text: '두꺼운 니트 · 기모 맨투맨' },
      bottom: { emoji: '👖', text: '기모 바지 · 레깅스' },
      outer: { emoji: '🧥', text: '코트 · 가죽자켓' },
      base: '두꺼운 니트에 코트' },
    { min: -Infinity, label: '4°C 이하', emoji: '⛄',
      top: { emoji: '🧣', text: '히트텍 · 두꺼운 니트 · 목도리' },
      bottom: { emoji: '👖', text: '기모 바지' },
      outer: { emoji: '🧥', text: '패딩 · 두꺼운 코트' },
      base: '패딩에 목도리' }
  ];

  function bandFor(feels) {
    var f = Math.round(feels);
    for (var i = 0; i < BANDS.length; i++) {
      if (f >= BANDS[i].min) return BANDS[i];
    }
    return BANDS[BANDS.length - 1];
  }

  // w: buildWeather() 결과
  function recommend(w) {
    var c = w.current, d = w.today;
    var feels = c.feels !== null ? c.feels
      : (d.min !== null && d.max !== null ? (d.min + d.max) / 2 : 15);
    var band = bandFor(feels);
    var tips = [];

    var umbrella = (d.popMax !== null && d.popMax >= 60) || c.raining || d.pcpRemain > 0;
    if (umbrella) tips.push({ key: 'umbrella', emoji: '☂️', text: '비 소식이 있어요. 우산을 챙기세요.', short: '우산 챙기세요' });

    if (c.snowing || d.snowLater) tips.push({ key: 'snow', emoji: '🥾', text: '눈이 와요. 미끄럽지 않은 부츠를 신으세요.', short: '부츠 신으세요' });

    if (d.range !== null && d.range >= 10) tips.push({ key: 'layer', emoji: '🧥', text: '일교차가 ' + Math.round(d.range) + '°C 나요. 겹쳐 입거나 겉옷을 챙기세요.', short: '겉옷 하나 챙기세요' });

    if (c.wind !== null && c.wind >= 7) tips.push({ key: 'wind', emoji: '🌬️', text: '바람이 강해요(' + c.wind + 'm/s). 바람막이를 걸치세요.', short: '바람막이 걸치세요' });

    var hot = feels >= 23;
    if (c.humidity !== null && c.humidity >= 70 && hot) tips.push({ key: 'linen', emoji: '🌿', text: '습하고 더워요. 린넨 같은 통기성 좋은 옷을 입으세요.', short: '통기성 좋은 린넨 추천' });

    var summary = band.base;
    if (tips.length) {
      summary += ', ' + tips.map(function (t) { return t.short; }).join(', ') + ' ' + tips[0].emoji;
    } else {
      summary += ' 추천해요 ' + band.emoji;
    }

    return {
      feels: feels,
      band: band.label,
      bandEmoji: band.emoji,
      top: band.top,
      bottom: band.bottom,
      outer: band.outer,
      tips: tips,
      summary: summary
    };
  }

  var api = {
    API_BASE: API_BASE,
    CITIES: CITIES,
    nearestCity: nearestCity,
    distanceKm: distanceKm,
    buildRegions: buildRegions,
    searchRegions: searchRegions,
    displayName: displayName,
    findRegion: findRegion,
    nearestRegion: nearestRegion,
    latLonToGrid: latLonToGrid,
    kstParts: kstParts,
    kstDateStr: kstDateStr,
    kstHourStr: kstHourStr,
    getNcstBase: getNcstBase,
    getUltraFcstBase: getUltraFcstBase,
    getVilageBase: getVilageBase,
    getTodayEarlyBase: getTodayEarlyBase,
    normalizeKey: normalizeKey,
    usableEmbeddedKey: usableEmbeddedKey,
    resolveKey: resolveKey,
    buildUrl: buildUrl,
    KmaError: KmaError,
    ERROR_MESSAGES: ERROR_MESSAGES,
    friendlyMessage: friendlyMessage,
    parseResponse: parseResponse,
    fetchKma: fetchKma,
    parsePrecip: parsePrecip,
    parseNcst: parseNcst,
    groupFcst: groupFcst,
    windChill: windChill,
    summerFeelsLike: summerFeelsLike,
    feelsLike: feelsLike,
    skyInfo: skyInfo,
    buildWeather: buildWeather,
    bandFor: bandFor,
    recommend: recommend
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.WeatherLib = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
