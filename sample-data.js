/*
 * ?demo=1 용 예시 데이터 생성기.
 * 기상청 API 응답 형식(response.header.resultCode / response.body.items.item[])을 그대로 흉내내며,
 * 날짜·시각은 현재 시각 기준으로 생성한다.
 * 브라우저: window.SampleData, node: module.exports
 */
(function (root) {
  'use strict';

  var lib = (typeof module !== 'undefined' && module.exports)
    ? require('./lib.js')
    : root.WeatherLib;

  var HOUR = 3600 * 1000;
  var NX = 60, NY = 127; // 서울

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function baseToMs(base) {
    var d = base.base_date, t = base.base_time;
    return Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), +t.slice(0, 2), +t.slice(2, 4)) - 9 * HOUR;
  }

  // 하루 기온 곡선: 새벽 3시 최저 8°C, 오후 3시 최고 19°C
  function tempAt(hour) {
    return Math.round((13.5 + 5.5 * Math.cos((hour - 15) / 24 * 2 * Math.PI)) * 10) / 10;
  }
  // 오후 16~20시 비
  function rainy(hour) { return hour >= 16 && hour <= 20; }
  function skyAt(hour) { return rainy(hour) ? 4 : (hour >= 12 ? 3 : 1); }
  function popAt(hour) { return rainy(hour) ? 70 : (hour >= 12 ? 30 : 10); }
  function humAt(hour) { return rainy(hour) ? 85 : 60; }
  function windAt(hour) { return Math.round((2 + 1.5 * Math.sin(hour / 24 * 2 * Math.PI)) * 10) / 10 + 1; }

  function wrap(items) {
    return JSON.stringify({
      response: {
        header: { resultCode: '00', resultMsg: 'NORMAL_SERVICE' },
        body: {
          dataType: 'JSON',
          items: { item: items },
          pageNo: 1,
          numOfRows: items.length,
          totalCount: items.length
        }
      }
    });
  }

  function makeNcst(now) {
    var base = lib.getNcstBase(now);
    var h = Number(base.base_time.slice(0, 2));
    var vals = {
      T1H: tempAt(h), RN1: rainy(h) ? 0.5 : 0, UUU: -1.2, VVV: 2.1,
      REH: humAt(h), PTY: rainy(h) ? 1 : 0, VEC: 210, WSD: windAt(h)
    };
    return Object.keys(vals).map(function (cat) {
      return { baseDate: base.base_date, baseTime: base.base_time, category: cat, nx: NX, ny: NY, obsrValue: String(vals[cat]) };
    });
  }

  function makeUltra(now) {
    var base = lib.getUltraFcstBase(now);
    var start = baseToMs(base) + 0.5 * HOUR; // HH30 -> 다음 정시
    var items = [];
    for (var i = 0; i < 6; i++) {
      var t = new Date(start + i * HOUR);
      var p = lib.kstParts(t);
      var h = p.hour;
      var vals = {
        LGT: 0, PTY: rainy(h) ? 1 : 0, RN1: rainy(h) ? '1mm 미만' : '강수없음',
        SKY: skyAt(h), T1H: tempAt(h), REH: humAt(h), UUU: -1.2, VVV: 2.1, VEC: 210, WSD: windAt(h)
      };
      Object.keys(vals).forEach(function (cat) {
        items.push({
          baseDate: base.base_date, baseTime: base.base_time, category: cat,
          fcstDate: lib.kstDateStr(t), fcstTime: pad2(h) + '00',
          fcstValue: String(vals[cat]), nx: NX, ny: NY
        });
      });
    }
    return items;
  }

  function makeVilage(base) {
    var start = baseToMs(base) + HOUR;
    var items = [];
    // 발표 시각 다음 시각부터 모레 자정 전까지 (약 50~70시간)
    for (var i = 0; i < 72; i++) {
      var t = new Date(start + i * HOUR);
      var p = lib.kstParts(t);
      var h = p.hour;
      var date = lib.kstDateStr(t);
      var vals = {
        TMP: Math.round(tempAt(h)), UUU: -1.2, VVV: 2.1, VEC: 210, WSD: windAt(h),
        SKY: skyAt(h), PTY: rainy(h) ? 1 : 0, POP: popAt(h),
        WAV: 0, PCP: rainy(h) ? '1mm 미만' : '강수없음', REH: humAt(h), SNO: '적설없음'
      };
      // 실제 API 처럼: 발표일 당일의 TMN/TMX 는 02시 발표분에만 포함
      var hasDaily = date > base.base_date || base.base_time === '0200';
      if (hasDaily && h === 6) vals.TMN = '8.0';
      if (hasDaily && h === 15) vals.TMX = '19.0';
      Object.keys(vals).forEach(function (cat) {
        items.push({
          baseDate: base.base_date, baseTime: base.base_time, category: cat,
          fcstDate: date, fcstTime: pad2(h) + '00',
          fcstValue: String(vals[cat]), nx: NX, ny: NY
        });
      });
    }
    return items.slice(0, 1000); // numOfRows=1000 과 동일하게
  }

  // 각 값은 실제 API 처럼 응답 본문 문자열(JSON)
  function makeSampleResponses(now) {
    now = now || new Date();
    var early = lib.getTodayEarlyBase(now);
    return {
      ncst: wrap(makeNcst(now)),
      ultra: wrap(makeUltra(now)),
      vilage: wrap(makeVilage(lib.getVilageBase(now))),
      early: early ? wrap(makeVilage(early)) : null,
      grid: { nx: NX, ny: NY },
      place: '서울 (예시)'
    };
  }

  var api = { makeSampleResponses: makeSampleResponses };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.SampleData = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
