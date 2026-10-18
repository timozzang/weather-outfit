/* node tests/test.js */
'use strict';

var assert = require('assert');
var path = require('path');
var childProcess = require('child_process');
var L = require('../lib.js');
var Sample = require('../sample-data.js');

var passed = 0;
var failed = 0;
var pending = [];

function test(name, fn) {
  try {
    var r = fn();
    if (r && typeof r.then === 'function') {
      pending.push(r.then(function () { passed++; }, function (e) { fail(name, e); }));
      return;
    }
    passed++;
  } catch (e) {
    fail(name, e);
  }
}
function fail(name, e) {
  failed++;
  console.error('✗ ' + name + '\n   ' + (e && e.stack || e));
}

// KST 벽시계 시각 -> Date
function kst(y, mo, d, h, mi) { return new Date(Date.UTC(y, mo - 1, d, h - 9, mi || 0)); }

function ok(items) {
  return JSON.stringify({ response: { header: { resultCode: '00', resultMsg: 'NORMAL_SERVICE' }, body: { items: { item: items } } } });
}

function rejectsWith(promise, code) {
  return promise.then(function () {
    throw new Error('expected rejection ' + code);
  }, function (e) {
    assert.strictEqual(e.name, 'KmaError');
    assert.strictEqual(e.code, code);
    assert.ok(e.message.length > 0);
  });
}

function mockFetch(status, body) {
  return function () {
    return Promise.resolve({ ok: status >= 200 && status < 300, status: status, text: function () { return Promise.resolve(body); } });
  };
}

// ---------------------------------------------------------------------------
// 격자 변환
// ---------------------------------------------------------------------------
test('grid: 서울 -> 60,127', function () {
  assert.deepStrictEqual(L.latLonToGrid(37.5665, 126.9780), { nx: 60, ny: 127 });
});
test('grid: 부산 -> 98,76 근처', function () {
  var g = L.latLonToGrid(35.1796, 129.0756);
  assert.ok(Math.abs(g.nx - 98) <= 1 && Math.abs(g.ny - 76) <= 1, JSON.stringify(g));
});
test('grid: 제주 -> 52,38 근처', function () {
  var g = L.latLonToGrid(33.4996, 126.5312);
  assert.ok(Math.abs(g.nx - 52) <= 1 && Math.abs(g.ny - 38) <= 1, JSON.stringify(g));
});
test('nearestCity', function () {
  assert.strictEqual(L.nearestCity(37.55, 126.99).city.name, '서울');
  assert.strictEqual(L.nearestCity(35.10, 129.03).city.name, '부산');
  assert.strictEqual(L.nearestCity(37.27, 127.01).city.name, '수원');
  assert.strictEqual(L.CITIES.length, 15);
});

// ---------------------------------------------------------------------------
// 전국 시·군·구 검색
// ---------------------------------------------------------------------------
var RAW_REGIONS = require('../regions.js');
var REGIONS = L.buildRegions(RAW_REGIONS);
function names(q) { return L.searchRegions(q, REGIONS).map(L.displayName); }

test('regions: 원본 데이터 약 250개 + 상위 시 합성', function () {
  assert.ok(RAW_REGIONS.length >= 240, String(RAW_REGIONS.length));
  var suwon = L.findRegion('경기 수원시', REGIONS);
  assert.ok(suwon && suwon.synthetic);
  var gu = REGIONS.filter(function (r) { return r.name.indexOf('수원시 ') === 0; });
  assert.strictEqual(gu.length, 4);
  var avg = gu.reduce(function (s, r) { return s + r.lat; }, 0) / gu.length;
  assert.ok(Math.abs(suwon.lat - avg) < 1e-3);
  ['창원시', '청주시', '포항시', '고양시'].forEach(function (n) {
    assert.ok(REGIONS.some(function (r) { return r.name === n && r.synthetic; }), n);
  });
});

test('search: 광양 / 광양시 / 전남 광양', function () {
  ['광양', '광양시', '전남 광양', '전라남도 광양', ' 광 양 '].forEach(function (q) {
    assert.strictEqual(names(q)[0], '광양시', q);
  });
});

test('search: 부산 중구', function () {
  var r = L.searchRegions('부산 중구', REGIONS);
  assert.strictEqual(r[0].name, '중구');
  assert.strictEqual(r[0].sidoShort, '부산');
  assert.strictEqual(L.displayName(r[0]), '부산 중구');
});

test('search: 초성 ㄱㅇ -> 광양시 포함', function () {
  assert.ok(names('ㄱㅇ').indexOf('광양시') >= 0, names('ㄱㅇ').join(','));
  assert.strictEqual(names('광ㅇ')[0], '광양시');
});

test('search: 수원 -> 수원시 + 모든 수원시 구', function () {
  var n = names('수원');
  assert.strictEqual(n[0], '수원시');
  ['수원시 권선구', '수원시 영통구', '수원시 장안구', '수원시 팔달구'].forEach(function (g) {
    assert.ok(n.indexOf(g) >= 0, g);
  });
});

test('search: 순위 (정확 > 앞부분 > 포함) / limit / 빈 질의', function () {
  var n = names('중구');
  assert.ok(n.length >= 6 && n.every(function (x) { return /중구$/.test(x); }), n.join(','));
  assert.strictEqual(names('팔달')[0], '수원시 팔달구'); // 포함
  assert.strictEqual(L.searchRegions('광', REGIONS, 3).length, 3);
  assert.deepStrictEqual(L.searchRegions('   ', REGIONS), []);
  assert.deepStrictEqual(names('없는지역이름'), []);
  // 원본 배열을 그대로 넘겨도 동작
  assert.strictEqual(L.displayName(L.searchRegions('광양', RAW_REGIONS)[0]), '광양시');
});

test('displayName: 중복 이름은 시도 약칭을 붙인다', function () {
  var dups = {};
  RAW_REGIONS.forEach(function (r) { dups[r[0]] = (dups[r[0]] || 0) + 1; });
  ['중구', '동구', '서구', '남구', '북구', '강서구', '고성군'].forEach(function (n) {
    assert.ok(dups[n] > 1, n);
  });
  assert.strictEqual(L.displayName(L.findRegion('서울 강서구', REGIONS)), '서울 강서구');
  assert.strictEqual(L.displayName(L.findRegion('부산 강서구', REGIONS)), '부산 강서구');
  assert.strictEqual(L.displayName(L.findRegion('강원 고성군', REGIONS)), '강원 고성군');
  assert.strictEqual(L.displayName(L.findRegion('경남 고성군', REGIONS)), '경남 고성군');
  assert.strictEqual(L.displayName(L.findRegion('대구 동구', REGIONS)), '대구 동구');
  assert.strictEqual(L.displayName(L.findRegion('전남 광양시', REGIONS)), '광양시');
  assert.strictEqual(L.displayName(L.findRegion('경북 포항시 남구', REGIONS)), '포항시 남구');
  assert.strictEqual(L.displayName(L.findRegion('경기 수원시', REGIONS)), '수원시');
});

test('nearestRegion', function () {
  assert.strictEqual(L.nearestRegion(34.94, 127.70, REGIONS).name, '광양시');
  assert.strictEqual(L.nearestRegion(37.52, 127.05, REGIONS).name, '강남구');
  assert.strictEqual(L.nearestRegion(34.95, 127.49, REGIONS).name, '순천시');
  assert.strictEqual(L.nearestRegion(37.27, 127.01, RAW_REGIONS).synthetic, undefined);
});

// ---------------------------------------------------------------------------
// 발표 시각 (KST)
// ---------------------------------------------------------------------------
test('ncst: 40분 전에는 이전 시각', function () {
  assert.deepStrictEqual(L.getNcstBase(kst(2026, 10, 18, 10, 39)), { base_date: '20261018', base_time: '0900' });
  assert.deepStrictEqual(L.getNcstBase(kst(2026, 10, 18, 10, 40)), { base_date: '20261018', base_time: '1000' });
});
test('ncst: 자정 넘김 (연말)', function () {
  assert.deepStrictEqual(L.getNcstBase(kst(2026, 1, 1, 0, 39)), { base_date: '20251231', base_time: '2300' });
  assert.deepStrictEqual(L.getNcstBase(kst(2026, 1, 1, 0, 40)), { base_date: '20260101', base_time: '0000' });
});
test('ultra fcst: HH30, 45분 전에는 이전 시각', function () {
  assert.deepStrictEqual(L.getUltraFcstBase(kst(2026, 10, 18, 10, 44)), { base_date: '20261018', base_time: '0930' });
  assert.deepStrictEqual(L.getUltraFcstBase(kst(2026, 10, 18, 10, 45)), { base_date: '20261018', base_time: '1030' });
});
test('ultra fcst: 자정 넘김 (윤년 3/1)', function () {
  assert.deepStrictEqual(L.getUltraFcstBase(kst(2024, 3, 1, 0, 44)), { base_date: '20240229', base_time: '2330' });
  assert.deepStrictEqual(L.getUltraFcstBase(kst(2024, 3, 1, 0, 45)), { base_date: '20240301', base_time: '0030' });
});
test('vilage: 발표 +10분', function () {
  assert.deepStrictEqual(L.getVilageBase(kst(2026, 10, 18, 2, 10)), { base_date: '20261018', base_time: '0200' });
  assert.deepStrictEqual(L.getVilageBase(kst(2026, 10, 18, 5, 9)), { base_date: '20261018', base_time: '0200' });
  assert.deepStrictEqual(L.getVilageBase(kst(2026, 10, 18, 5, 10)), { base_date: '20261018', base_time: '0500' });
  assert.deepStrictEqual(L.getVilageBase(kst(2026, 10, 18, 13, 59)), { base_date: '20261018', base_time: '1100' });
  assert.deepStrictEqual(L.getVilageBase(kst(2026, 10, 18, 23, 9)), { base_date: '20261018', base_time: '2000' });
  assert.deepStrictEqual(L.getVilageBase(kst(2026, 10, 18, 23, 59)), { base_date: '20261018', base_time: '2300' });
});
test('vilage: 02:10 이전은 전날 2300 (월·연 넘김)', function () {
  assert.deepStrictEqual(L.getVilageBase(kst(2026, 10, 18, 2, 9)), { base_date: '20261017', base_time: '2300' });
  assert.deepStrictEqual(L.getVilageBase(kst(2026, 10, 18, 0, 0)), { base_date: '20261017', base_time: '2300' });
  assert.deepStrictEqual(L.getVilageBase(kst(2026, 11, 1, 1, 30)), { base_date: '20261031', base_time: '2300' });
  assert.deepStrictEqual(L.getVilageBase(kst(2026, 1, 1, 0, 5)), { base_date: '20251231', base_time: '2300' });
});
test('today early base (0200) 는 02:10 이후에만', function () {
  assert.strictEqual(L.getTodayEarlyBase(kst(2026, 10, 18, 2, 9)), null);
  assert.deepStrictEqual(L.getTodayEarlyBase(kst(2026, 10, 18, 2, 10)), { base_date: '20261018', base_time: '0200' });
  assert.deepStrictEqual(L.getTodayEarlyBase(kst(2026, 10, 18, 23, 50)), { base_date: '20261018', base_time: '0200' });
});
test('KST 날짜는 UTC 날짜와 다를 수 있음 (UTC 15:00 = KST 다음날 00:00)', function () {
  var d = new Date(Date.UTC(2026, 9, 18, 15, 0));
  assert.strictEqual(L.kstDateStr(d), '20261019');
  assert.strictEqual(L.kstParts(d).hour, 0);
});

// ---------------------------------------------------------------------------
// URL
// ---------------------------------------------------------------------------
test('buildUrl: 키 인코딩 및 파라미터', function () {
  var key = 'abc+def/ghi==';
  var url = L.buildUrl('getVilageFcst', key, { base_date: '20261018', base_time: '1100' }, 60, 127, 1000);
  assert.ok(url.indexOf(L.API_BASE + '/getVilageFcst?') === 0);
  assert.ok(url.indexOf('serviceKey=abc%2Bdef%2Fghi%3D%3D') > 0);
  ['pageNo=1', 'numOfRows=1000', 'dataType=JSON', 'base_date=20261018', 'base_time=1100', 'nx=60', 'ny=127']
    .forEach(function (p) { assert.ok(url.indexOf(p) > 0, p); });
});
test('buildUrl: Encoding 키를 넣어도 이중 인코딩하지 않음', function () {
  var url = L.buildUrl('getUltraSrtNcst', 'abc%2Bdef%3D%3D', { base_date: '20261018', base_time: '1000' }, 1, 2);
  assert.ok(url.indexOf('serviceKey=abc%2Bdef%3D%3D&') > 0, url);
});

test('resolveKey: localStorage > config.js 기본 키, 자리표시자/빈 값은 무시', function () {
  assert.strictEqual(L.resolveKey('', '__KMA_KEY__'), '');
  assert.strictEqual(L.resolveKey(null, ''), '');
  assert.strictEqual(L.resolveKey(null, undefined), '');
  assert.strictEqual(L.resolveKey('', ' real+key== '), 'real+key==');
  assert.strictEqual(L.resolveKey(' mine ', 'real'), 'mine');
  assert.strictEqual(L.resolveKey('mine', '__KMA_KEY__'), 'mine');
});
test('config.js: 형식 확인', function () {
  var src = require('fs').readFileSync(path.join(__dirname, '..', 'config.js'), 'utf8').trim();
  assert.ok(/^window\.KMA_EMBEDDED_KEY = "[^"\n]*";$/.test(src));
});

// ---------------------------------------------------------------------------
// 파싱
// ---------------------------------------------------------------------------
test('parseResponse: item 배열', function () {
  var items = L.parseResponse(ok([{ category: 'T1H', obsrValue: '12.3' }, { category: 'REH', obsrValue: '55' }]));
  assert.strictEqual(items.length, 2);
});
test('parseResponse: item 단일 객체 / BOM / 빈 items', function () {
  assert.strictEqual(L.parseResponse('﻿' + ok({ category: 'T1H', obsrValue: '1' })).length, 1);
  var empty = JSON.stringify({ response: { header: { resultCode: '00' }, body: { items: '' } } });
  assert.deepStrictEqual(L.parseResponse(empty), []);
});
test('parseNcst', function () {
  var n = L.parseNcst([
    { baseDate: '20261018', baseTime: '1000', category: 'T1H', obsrValue: '12.3' },
    { category: 'REH', obsrValue: '55' },
    { category: 'RN1', obsrValue: '1.5' },
    { category: 'WSD', obsrValue: '3.2' },
    { category: 'PTY', obsrValue: '1' }
  ]);
  assert.strictEqual(n.T1H, 12.3);
  assert.strictEqual(n.REH, 55);
  assert.strictEqual(n.RN1, 1.5);
  assert.strictEqual(n.WSD, 3.2);
  assert.strictEqual(n.PTY, 1);
  assert.strictEqual(n.baseTime, '1000');
});
test('parseNcst: 결측값(-999 등)은 null', function () {
  var n = L.parseNcst([{ category: 'T1H', obsrValue: '-999' }, { category: 'WSD', obsrValue: '900' }]);
  assert.strictEqual(n.T1H, null);
  assert.strictEqual(n.WSD, null);
});
test('parsePrecip', function () {
  assert.strictEqual(L.parsePrecip('강수없음'), 0);
  assert.strictEqual(L.parsePrecip('1mm 미만'), 0.5);
  assert.strictEqual(L.parsePrecip('1.0mm 미만'), 0.5);
  assert.strictEqual(L.parsePrecip('3.5mm'), 3.5);
  assert.strictEqual(L.parsePrecip('30.0~50.0mm'), 30);
  assert.strictEqual(L.parsePrecip('50.0mm 이상'), 50);
  assert.strictEqual(L.parsePrecip('0'), 0);
  assert.strictEqual(L.parsePrecip('2'), 2);
  assert.strictEqual(L.parsePrecip(undefined), 0);
});
test('groupFcst: 시각별로 묶고 정렬', function () {
  var g = L.groupFcst([
    { category: 'TMP', fcstDate: '20261019', fcstTime: '0000', fcstValue: '9' },
    { category: 'TMP', fcstDate: '20261018', fcstTime: '2300', fcstValue: '10' },
    { category: 'POP', fcstDate: '20261018', fcstTime: '2300', fcstValue: '20' }
  ]);
  assert.strictEqual(g.length, 2);
  assert.strictEqual(g[0].key, '202610182300');
  assert.deepStrictEqual(g[0].values, { TMP: '10', POP: '20' });
});

// ---------------------------------------------------------------------------
// 오류 처리
// ---------------------------------------------------------------------------
var XML_KEY_ERR = '<OpenAPI_ServiceResponse>\n  <cmmMsgHeader>\n    <errMsg>SERVICE ERROR</errMsg>\n' +
  '    <returnAuthMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR</returnAuthMsg>\n    <returnReasonCode>30</returnReasonCode>\n' +
  '  </cmmMsgHeader>\n</OpenAPI_ServiceResponse>';

test('error: XML 인증키 미등록', function () {
  assert.throws(function () { L.parseResponse(XML_KEY_ERR); }, function (e) {
    return e.name === 'KmaError' && e.code === '30' && /인증키/.test(e.message) &&
      e.detail === 'SERVICE_KEY_IS_NOT_REGISTERED_ERROR';
  });
});
test('error: XML 요청 한도 초과 (reason code 만 있는 경우)', function () {
  var xml = '<OpenAPI_ServiceResponse><cmmMsgHeader><errMsg>SERVICE ERROR</errMsg><returnReasonCode>22</returnReasonCode></cmmMsgHeader></OpenAPI_ServiceResponse>';
  assert.throws(function () { L.parseResponse(xml); }, function (e) { return e.code === '22' && /한도/.test(e.message); });
});
test('error: XML response/header 형식', function () {
  var xml = '<?xml version="1.0" encoding="UTF-8"?><response><header><resultCode>03</resultCode><resultMsg>NO_DATA</resultMsg></header></response>';
  assert.throws(function () { L.parseResponse(xml); }, function (e) { return e.code === '03'; });
});
test('error: JSON resultCode != 00', function () {
  var body = JSON.stringify({ response: { header: { resultCode: '03', resultMsg: 'NO_DATA' } } });
  assert.throws(function () { L.parseResponse(body); }, function (e) { return e.code === '03' && /예보/.test(e.message); });
  var body2 = JSON.stringify({ response: { header: { resultCode: '10', resultMsg: 'INVALID_REQUEST_PARAMETER_ERROR' } } });
  assert.throws(function () { L.parseResponse(body2); }, function (e) { return e.code === '10'; });
  var body3 = JSON.stringify({ response: { header: { resultCode: '77', resultMsg: '?' } } });
  assert.throws(function () { L.parseResponse(body3); }, function (e) { return e.code === '99'; });
});
test('error: 해석 불가 응답', function () {
  ['', 'Unauthorized', '{"foo":1}', '{broken'].forEach(function (b) {
    assert.throws(function () { L.parseResponse(b); }, function (e) { return e.code === 'PARSE'; }, b);
  });
});
test('friendlyMessage: 일반 오류는 한국어 기본 메시지', function () {
  assert.ok(/알 수 없는/.test(L.friendlyMessage(new TypeError('x'))));
});

test('fetchKma: 정상 응답', function () {
  return L.fetchKma(mockFetch(200, ok([{ category: 'T1H', obsrValue: '5' }])), 'u').then(function (items) {
    assert.strictEqual(items[0].obsrValue, '5');
  });
});
test('fetchKma: 200 + XML 오류', function () {
  return rejectsWith(L.fetchKma(mockFetch(200, XML_KEY_ERR), 'u'), '30');
});
test('fetchKma: HTTP 401 + XML 오류 본문', function () {
  return rejectsWith(L.fetchKma(mockFetch(401, XML_KEY_ERR), 'u'), '30');
});
test('fetchKma: HTTP 500 일반 본문', function () {
  return rejectsWith(L.fetchKma(mockFetch(500, 'Internal Server Error'), 'u'), 'HTTP');
});
test('fetchKma: 네트워크 실패 (CORS 등)', function () {
  return rejectsWith(L.fetchKma(function () { return Promise.reject(new TypeError('Failed to fetch')); }, 'u'), 'NETWORK');
});
test('fetchKma: fetch 동기 예외', function () {
  return rejectsWith(L.fetchKma(function () { throw new TypeError('boom'); }, 'u'), 'NETWORK');
});
test('fetchKma: 타임아웃(AbortError)', function () {
  var e = new Error('aborted'); e.name = 'AbortError';
  return rejectsWith(L.fetchKma(function () { return Promise.reject(e); }, 'u'), 'TIMEOUT');
});

// ---------------------------------------------------------------------------
// 체감온도
// ---------------------------------------------------------------------------
test('feelsLike: 바람냉각 (T<=10, 풍속>1.3)', function () {
  var v = Math.pow(5 * 3.6, 0.16);
  var expected = Math.round((13.12 + 0.6215 * 0 - 11.37 * v + 0.3965 * 0 * v) * 10) / 10;
  assert.strictEqual(L.feelsLike(0, 5, 50), expected);
  assert.ok(expected < -3 && expected > -6, String(expected));
});
test('feelsLike: 바람 약하거나 10도 초과면 기온 그대로', function () {
  assert.strictEqual(L.feelsLike(5, 1.3, 50), 5);
  assert.strictEqual(L.feelsLike(15, 8, 50), 15);
  assert.strictEqual(L.feelsLike(24.9, 2, 90), 24.9);
});
test('feelsLike: 여름철 (T>=25) 습도 반영', function () {
  var humid = L.feelsLike(30, 1, 80);
  var dry = L.feelsLike(30, 1, 30);
  assert.ok(humid > dry, humid + ' > ' + dry);
  assert.ok(humid > 28 && humid < 36, String(humid));
});
test('feelsLike: 기온 없음 -> null', function () {
  assert.strictEqual(L.feelsLike(null, 3, 50), null);
});

// ---------------------------------------------------------------------------
// 하늘 상태
// ---------------------------------------------------------------------------
test('skyInfo', function () {
  assert.strictEqual(L.skyInfo(1, 0, false).emoji, '☀️');
  assert.strictEqual(L.skyInfo(1, 0, true).theme, 'night');
  assert.strictEqual(L.skyInfo(3, 0, false).label, '구름많음');
  assert.strictEqual(L.skyInfo(4, 0, false).label, '흐림');
  assert.strictEqual(L.skyInfo(1, 1, false).theme, 'rain');
  assert.strictEqual(L.skyInfo(4, 3, false).label, '눈');
  assert.strictEqual(L.skyInfo(4, 7, false).theme, 'snow');
});

// ---------------------------------------------------------------------------
// 추천
// ---------------------------------------------------------------------------
function weather(o) {
  o = o || {};
  return {
    current: {
      temp: o.temp !== undefined ? o.temp : 15, feels: o.feels !== undefined ? o.feels : 15,
      humidity: o.humidity !== undefined ? o.humidity : 50, wind: o.wind !== undefined ? o.wind : 2,
      raining: !!o.raining, snowing: !!o.snowing
    },
    today: {
      min: o.min !== undefined ? o.min : 12, max: o.max !== undefined ? o.max : 18,
      range: o.range !== undefined ? o.range : 6, popMax: o.popMax !== undefined ? o.popMax : 10,
      pcpRemain: o.pcpRemain || 0, snowLater: !!o.snowLater
    }
  };
}
function tipKeys(r) { return r.tips.map(function (t) { return t.key; }); }

test('bands: 경계값', function () {
  var cases = [
    [35, '28°C 이상'], [28, '28°C 이상'], [27.5, '28°C 이상'], [27.4, '23~27°C'], [23, '23~27°C'],
    [22, '20~22°C'], [20, '20~22°C'], [19, '17~19°C'], [17, '17~19°C'], [16, '12~16°C'],
    [12, '12~16°C'], [11, '9~11°C'], [9, '9~11°C'], [8, '5~8°C'], [5, '5~8°C'],
    [4, '4°C 이하'], [4.4, '4°C 이하'], [-10, '4°C 이하']
  ];
  cases.forEach(function (c) { assert.strictEqual(L.bandFor(c[0]).label, c[1], String(c[0])); });
});
test('recommend: 맑은 날 기본 문구', function () {
  var r = L.recommend(weather({ feels: 25 }));
  assert.deepStrictEqual(r.tips, []);
  assert.strictEqual(r.outer, null);
  assert.strictEqual(r.summary, '반팔에 가벼운 면바지 추천해요 😎');
});
test('recommend: 얇은 니트에 가디건, 우산 챙기세요 ☂️', function () {
  var r = L.recommend(weather({ feels: 14, popMax: 70 }));
  assert.strictEqual(r.summary, '얇은 니트에 가디건, 우산 챙기세요 ☂️');
  assert.strictEqual(r.top.emoji, '🧶');
  assert.ok(r.outer && /가디건/.test(r.outer.text));
});
test('recommend: 우산 조건 (POP>=60 / 현재 비 / 남은 PCP>0)', function () {
  assert.deepStrictEqual(tipKeys(L.recommend(weather({ popMax: 59 }))), []);
  assert.deepStrictEqual(tipKeys(L.recommend(weather({ popMax: 60 }))), ['umbrella']);
  assert.deepStrictEqual(tipKeys(L.recommend(weather({ raining: true }))), ['umbrella']);
  assert.deepStrictEqual(tipKeys(L.recommend(weather({ pcpRemain: 0.5 }))), ['umbrella']);
});
test('recommend: 일교차 10도 이상 -> 겉옷', function () {
  assert.deepStrictEqual(tipKeys(L.recommend(weather({ range: 9.9 }))), []);
  var r = L.recommend(weather({ range: 10 }));
  assert.deepStrictEqual(tipKeys(r), ['layer']);
  assert.ok(/일교차/.test(r.tips[0].text));
});
test('recommend: 강풍 7m/s 이상 -> 바람막이', function () {
  assert.deepStrictEqual(tipKeys(L.recommend(weather({ wind: 6.9 }))), []);
  assert.deepStrictEqual(tipKeys(L.recommend(weather({ wind: 7 }))), ['wind']);
});
test('recommend: 덥고 습하면 린넨', function () {
  assert.deepStrictEqual(tipKeys(L.recommend(weather({ feels: 29, humidity: 75 }))), ['linen']);
  assert.deepStrictEqual(tipKeys(L.recommend(weather({ feels: 29, humidity: 60 }))), []);
  assert.deepStrictEqual(tipKeys(L.recommend(weather({ feels: 15, humidity: 90 }))), []);
});
test('recommend: 눈 -> 부츠', function () {
  // buildWeather 에서 PTY 3/7 이면 raining 도 true
  var r = L.recommend(weather({ feels: -3, raining: true, snowing: true }));
  assert.deepStrictEqual(tipKeys(r), ['umbrella', 'snow']);
  assert.strictEqual(r.summary, '패딩에 목도리, 우산 챙기세요, 부츠 신으세요 ☂️');
  assert.deepStrictEqual(tipKeys(L.recommend(weather({ feels: 0, snowLater: true }))), ['snow']);
});

// ---------------------------------------------------------------------------
// 종합 (예시 데이터 사용)
// ---------------------------------------------------------------------------
function buildFromSample(now, withEarly) {
  var s = Sample.makeSampleResponses(now);
  return L.buildWeather(
    L.parseResponse(s.ncst), L.parseResponse(s.ultra), L.parseResponse(s.vilage),
    withEarly && s.early ? L.parseResponse(s.early) : null, now);
}

test('sample: 문서 형식 준수', function () {
  var s = Sample.makeSampleResponses(kst(2026, 10, 18, 13, 20));
  var j = JSON.parse(s.vilage);
  assert.strictEqual(j.response.header.resultCode, '00');
  var it = j.response.body.items.item[0];
  ['baseDate', 'baseTime', 'category', 'fcstDate', 'fcstTime', 'fcstValue', 'nx', 'ny'].forEach(function (k) {
    assert.ok(k in it, k);
  });
  assert.strictEqual(it.baseTime, '1100');
  assert.ok('obsrValue' in JSON.parse(s.ncst).response.body.items.item[0]);
  assert.ok(j.response.body.items.item.length <= 1000);
});
test('buildWeather: 오후 1시 20분', function () {
  var now = kst(2026, 10, 18, 13, 20);
  var w = buildFromSample(now, true);
  assert.strictEqual(w.current.temp, 17.4); // 13:20 은 40분 전이므로 ncst 12시 관측
  assert.strictEqual(w.today.tmn, 8);       // 02시 발표분의 TMN
  assert.strictEqual(w.today.tmx, 19);
  assert.strictEqual(w.today.min, 8);
  assert.strictEqual(w.today.max, 19);
  assert.strictEqual(w.today.range, 11);
  assert.strictEqual(w.today.popMax, 70);
  assert.ok(w.today.pcpRemain > 0);
  assert.strictEqual(w.hourly.length, 12);
  assert.strictEqual(w.hourly[0].time, '1400');
  assert.strictEqual(w.hourly[0].pop, 30);
  assert.strictEqual(w.hourly[10].date, '20261019'); // 자정 넘어 내일
  assert.strictEqual(w.hourly[10].time, '0000');
  assert.strictEqual(w.current.skyInfo.label, '구름많음');
  var r = L.recommend(w);
  assert.deepStrictEqual(tipKeys(r), ['umbrella', 'layer']);
  assert.strictEqual(r.band, '17~19°C');
});
test('buildWeather: TMN/TMX 없을 때 TMP 로 최저/최고 계산', function () {
  var now = kst(2026, 10, 18, 16, 30); // 단기예보 1400 발표 -> 오늘 TMN 없음
  var w = buildFromSample(now, false);
  assert.strictEqual(w.today.tmn, null);
  assert.strictEqual(w.today.tmx, null);
  assert.ok(w.today.min !== null && w.today.max !== null);
  assert.ok(w.today.min <= w.current.temp && w.today.max >= w.current.temp);
});
test('buildWeather: 자정 직후 (전날 2300 발표 사용)', function () {
  var now = kst(2026, 1, 1, 0, 20);
  var s = Sample.makeSampleResponses(now);
  assert.strictEqual(s.early, null);
  assert.strictEqual(JSON.parse(s.vilage).response.body.items.item[0].baseDate, '20251231');
  var w = buildFromSample(now, true);
  assert.strictEqual(w.today.tmn, 8);
  assert.strictEqual(w.today.tmx, 19);
  assert.strictEqual(w.hourly[0].date, '20260101');
  assert.strictEqual(w.hourly[0].time, '0100');
  assert.strictEqual(w.current.skyInfo.theme, 'night');
});
test('buildWeather: 초단기예보·02시 발표분이 없어도 동작', function () {
  var now = kst(2026, 10, 18, 9, 0);
  var s = Sample.makeSampleResponses(now);
  var w = L.buildWeather(L.parseResponse(s.ncst), null, L.parseResponse(s.vilage), null, now);
  assert.ok(w.current.sky !== null);
  assert.strictEqual(w.hourly.length, 12);
});

// ---------------------------------------------------------------------------
Promise.all(pending).then(function () {
  console.log((failed ? '✗ ' : '✓ ') + passed + ' passed, ' + failed + ' failed' +
    (process.env.TZ ? ' (TZ=' + process.env.TZ + ')' : ''));
  if (failed) process.exit(1);

  // 기기 시간대와 무관한지 확인: 다른 시간대에서 한 번 더 실행
  if (!process.env.WO_TZ_CHILD) {
    ['America/Los_Angeles', 'Pacific/Kiritimati'].forEach(function (tz) {
      var r = childProcess.spawnSync(process.execPath, [path.join(__dirname, 'test.js')], {
        env: Object.assign({}, process.env, { TZ: tz, WO_TZ_CHILD: '1' }), stdio: 'inherit'
      });
      if (r.status !== 0) process.exit(1);
    });
  }
});
