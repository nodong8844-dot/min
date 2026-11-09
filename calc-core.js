/* =====================================================================
 *  calc-core.js — 3배 레버리지 ETF 원복 계산 핵심 로직 (UI 없음, 테스트 가능)
 *
 *  연속 재조정(continuous rebalancing) GBM 근사:
 *    ln(V_T/V_0) = L·ln(I) − L(L−1)/2·σ²T − [f + (L−1)c]·T
 *  괴리율 보정 (시장가 = NAV × (1+δ)):
 *    ln(I_req) = [ ln(A/P) + (f+(L−1)c)T − ln((1+δT)/(1+δ0)) ] / L + (L−1)/2·σ²T
 *  L=3 이면 (L−1)/2 = 1 → σ²T
 * ===================================================================== */
var LC = (function () {
  "use strict";
  var TD = 252; // 연간 거래일 수(가정)

  function num(v) { if (v === "" || v === null || v === undefined) return NaN; var n = Number(String(v).replace(/,/g, "")); return isFinite(n) ? n : NaN; }

  /* ---------- 입력 검증 ---------- */
  // raw: 퍼센트 단위 그대로(vol 30 = 30%), months 단위 기간
  function validate(raw) {
    var e = [], w = [];
    var A = num(raw.avg), P = num(raw.px), X = num(raw.idx), M = num(raw.months), V = num(raw.vol), F = num(raw.fee);
    if (!(A > 0)) e.push("평단가는 0보다 큰 달러 금액이어야 합니다.");
    if (!(P > 0)) e.push("현재가는 0보다 큰 달러 금액이어야 합니다.");
    if (!(X > 0)) e.push("현재 비교지수는 0보다 커야 합니다.");
    if (!(M > 0)) e.push("보유기간은 0개월보다 길어야 합니다.");
    else if (M > 120) e.push("보유기간은 120개월(10년) 이하로 입력하세요.");
    if (!(V >= 0)) e.push("변동성은 0% 이상이어야 합니다(음수 불가).");
    else if (V > 300) e.push("변동성은 300% 이하로 입력하세요.");
    if (!(F >= 0)) e.push("운용보수는 0% 이상이어야 합니다.");
    else if (F > 20) e.push("운용보수가 20%를 넘습니다. 단위(%)를 확인하세요.");
    var C = num(raw.fund); if (raw.fund !== "" && raw.fund != null && !(C >= 0 && C <= 50)) e.push("추가 조달비용은 0~50% 범위로 입력하세요.");
    var d0 = num(raw.d0), dT = num(raw.dT);
    if (raw.d0 !== "" && raw.d0 != null && !(d0 > -100)) e.push("현재 괴리율은 −100%보다 커야 합니다.");
    if (raw.dT !== "" && raw.dT != null && !(dT > -100)) e.push("미래 괴리율은 −100%보다 커야 합니다.");
    if (Math.abs(d0) > 20 || Math.abs(dT) > 20) w.push("괴리율이 ±20%를 넘습니다. 단위(%)를 확인하세요.");
    if (V > 0 && V < 1) w.push("변동성은 퍼센트 단위입니다. 30%면 30을 입력하세요(0.3 아님).");
    if (A > 0 && P > 0 && (A / P > 50 || P / A > 50)) w.push("평단과 현재가 차이가 50배 이상입니다. 주식분할·역분할이 반영된 같은 기준 가격인지 확인하세요.");
    if (raw.fxOn) {
      var fn = num(raw.fxNow), ff = num(raw.fxFut);
      if (!(fn > 0) || !(ff > 0)) e.push("환율 보정을 켜려면 현재 환율과 가정 환율을 모두 0보다 크게 입력하세요.");
    }
    return { errors: e, warns: w };
  }

  /* ---------- 핵심 계산 ---------- */
  // inp: {A,P,L,T(년),sig(소수),f(소수),c(소수),d0(소수),dT(소수), map:{mode,a,b}, fx:{on,now,fut}}
  function core(inp) {
    var L = inp.L || 3, T = inp.T, s = inp.sig, f = inp.f || 0, c = inp.c || 0;
    var d0 = inp.d0 || 0, dT = inp.dT || 0;
    var lnR = Math.log(inp.A / inp.P);
    var base = lnR / L;
    var vol = (L - 1) / 2 * s * s * T;
    var cost = (f + (L - 1) * c) * T / L;
    var prem = -Math.log((1 + dT) / (1 + d0)) / L;
    return {
      L: L, lnR: lnR,
      parts: { base: base, vol: vol, cost: cost, prem: prem },
      I0: Math.exp(base),
      Ivol: Math.exp(base + vol),
      Icost: Math.exp(base + vol + cost),
      Ireq: Math.exp(base + vol + cost + prem)
    };
  }

  // 실제 추종지수 배수 → 비교지수 배수
  function toCmp(I, inp) {
    var ln = Math.log(I), note = "1:1 단순 환산";
    var m = inp.map || {};
    if (m.mode === "regress" && m.b > 0) {
      var N = Math.round(TD * inp.T);
      ln = (ln - N * (m.a || 0)) / m.b;
      note = "회귀 보정 환산";
    } else if (inp.fx && inp.fx.on && inp.fx.now > 0 && inp.fx.fut > 0) {
      ln = ln + Math.log(inp.fx.fut / inp.fx.now); // I_KRW = I_USD × FX_미래/FX_현재
      note = "1:1 환산 + 환율 보정";
    }
    return { I: Math.exp(ln), note: note };
  }
  // 비교지수 배수 → 실제 추종지수 배수 (역함수)
  function fromCmp(Ic, inp) {
    var ln = Math.log(Ic), m = inp.map || {};
    if (m.mode === "regress" && m.b > 0) {
      var N = Math.round(TD * inp.T);
      ln = m.b * ln + N * (m.a || 0);
    } else if (inp.fx && inp.fx.on && inp.fx.now > 0 && inp.fx.fut > 0) {
      ln = ln - Math.log(inp.fx.fut / inp.fx.now);
    }
    return Math.exp(ln);
  }

  // 실제 지수 배수 I 에서의 ETF '시장가' 배수 (GBM 근사, 괴리율 포함)
  function etfMult(I, inp) {
    var L = inp.L || 3, T = inp.T, s = inp.sig, f = inp.f || 0, c = inp.c || 0;
    var navLn = L * Math.log(I) - L * (L - 1) / 2 * s * s * T - (f + (L - 1) * c) * T;
    return Math.exp(navLn) * (1 + (inp.dT || 0)) / (1 + (inp.d0 || 0));
  }

  function full(inp) {
    var r = core(inp);
    var cm = function (I) { return toCmp(I, inp).I; };
    r.mapNote = toCmp(r.Ireq, inp).note;
    r.cmp = { I0: cm(r.I0), Ivol: cm(r.Ivol), Icost: cm(r.Icost), Ireq: cm(r.Ireq) };
    if (inp.idx > 0) r.target = { I0: inp.idx * r.cmp.I0, Ivol: inp.idx * r.cmp.Ivol, Icost: inp.idx * r.cmp.Icost, Ireq: inp.idx * r.cmp.Ireq };
    if (inp.actIdx > 0) r.actTarget = inp.actIdx * r.Ireq;
    r.lossNow = inp.P / inp.A - 1;
    r.etfNeed = inp.A / inp.P - 1;
    return r;
  }

  /* ---------- 데이터 붙여넣기 파싱 ---------- */
  // 줄마다: 날짜, 실제지수[, 비교지수]   (쉼표·탭·공백 구분, 숫자 천단위 쉼표 허용 안 함 → 탭/세미콜론 권장)
  function parseSeries(text) {
    var rows = [], bad = 0;
    String(text || "").split(/\r?\n/).forEach(function (line) {
      line = line.trim(); if (!line) return;
      // 엑셀 복사(탭) 또는 세미콜론이면 그 구분자 사용 + 숫자 안 천단위 쉼표 허용, 아니면 쉼표·공백 구분
      var p = (/\t|;/.test(line) ? line.split(/\t|;/) : line.split(/,|\s+/)).map(function (x) { return x.trim(); }).filter(Boolean);
      if (p.length < 2) { bad++; return; }
      var nn = function (x) { return Number(String(x).replace(/,/g, "").replace(/"/g, "")); };
      var d = p[0].replace(/"/g, ""), a = nn(p[1]), b = p.length >= 3 ? nn(p[2]) : NaN;
      if (!(a > 0)) { bad++; return; }
      rows.push({ d: d, a: a, b: b });
    });
    rows.sort(function (x, y) { return x.d < y.d ? -1 : x.d > y.d ? 1 : 0; });
    // 같은 날짜 중복 제거
    var out = []; rows.forEach(function (r) { if (!out.length || out[out.length - 1].d !== r.d) out.push(r); });
    return { rows: out, bad: bad };
  }

  function sd(arr) { var n = arr.length; if (n < 2) return NaN; var m = 0; arr.forEach(function (x) { m += x; }); m /= n; var v = 0; arr.forEach(function (x) { v += (x - m) * (x - m); }); return Math.sqrt(v / (n - 1)); }

  // 실제지수 일별 로그수익률 = a + β × 비교지수 일별 로그수익률
  function regress(text) {
    var P = parseSeries(text), rows = P.rows;
    var res = { ok: false, rows: rows.length, bad: P.bad };
    if (rows.length < 2) { res.msg = "자료가 없습니다."; return res; }
    var ya = [], xs = [], ys = [];
    for (var i = 1; i < rows.length; i++) {
      var la = Math.log(rows[i].a / rows[i - 1].a); ya.push(la);
      if (rows[i].b > 0 && rows[i - 1].b > 0) { xs.push(Math.log(rows[i].b / rows[i - 1].b)); ys.push(la); }
    }
    res.start = rows[0].d; res.end = rows[rows.length - 1].d;
    res.volAct = sd(ya) * Math.sqrt(TD); res.nAct = ya.length;
    res.actualReturns = ya;
    var n = xs.length; res.n = n;
    if (n > 0) res.volCmp = sd(xs) * Math.sqrt(TD);
    if (n < 60) { res.msg = n === 0 ? "비교지수 열이 없어 회귀를 할 수 없습니다(실제지수 자료만 사용)." : "같은 날짜 자료가 " + n + "개뿐입니다. 회귀는 최소 60개 이상일 때만 사용합니다."; return res; }
    var mx = 0, my = 0; for (i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; } mx /= n; my /= n;
    var sxx = 0, sxy = 0, syy = 0; for (i = 0; i < n; i++) { sxx += (xs[i] - mx) * (xs[i] - mx); sxy += (xs[i] - mx) * (ys[i] - my); syy += (ys[i] - my) * (ys[i] - my); }
    if (!(sxx > 0)) { res.msg = "비교지수 변동이 없어 회귀를 할 수 없습니다."; return res; }
    var b = sxy / sxx, a = my - b * mx;
    var sse = 0; for (i = 0; i < n; i++) { var e = ys[i] - a - b * xs[i]; sse += e * e; }
    var r2 = syy > 0 ? 1 - sse / syy : NaN;
    var se = Math.sqrt(sse / (n - 2) / sxx);
    var seA = Math.sqrt(sse / (n - 2) * (1 / n + mx * mx / sxx));
    res.a = a; res.b = b; res.se = se; res.seA = seA; res.r2 = r2;
    if (!(b > 0)) { res.msg = "β가 0 이하입니다. 회귀 환산을 사용할 수 없습니다."; return res; }
    res.ok = true;
    res.msg = r2 < 0.5 ? "설명력(R²)이 낮아 환산값의 불확실성이 큽니다." : "";
    return res;
  }

  /* ---------- 일별 복리 시뮬레이션 ---------- */
  function rng(seed) { var a = seed >>> 0; return function () { a |= 0; a = a + 0x6D2B79F5 | 0; var t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function gauss(r) { var u = 0, v = 0; while (u === 0) u = r(); v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

  // 일별 로그수익률 배열 x → 이상적 L배 ETF NAV 배수 Π(1+L·r_t − 일비용)
  function dailyCompound(xs, L, dailyCost) {
    var v = 1, wiped = false, worst = 0;
    for (var i = 0; i < xs.length; i++) {
      var r = Math.exp(xs[i]) - 1; if (r < worst) worst = r;
      var g = 1 + L * r - dailyCost;
      if (g <= 0) { wiped = true; v = 0; break; }
      v *= g;
    }
    return { v: v, wiped: wiped, worst: worst };
  }

  function quant(sorted, q) { if (!sorted.length) return NaN; var p = (sorted.length - 1) * q, lo = Math.floor(p), hi = Math.ceil(p); return sorted[lo] + (sorted[hi] - sorted[lo]) * (p - lo); }

  // 가상 몬테카를로: 기간 말 실제지수가 정확히 I_req 가 되도록 고정(브리지)한 경로들
  function monteCarlo(inp, Ireq, paths, seed) {
    var L = inp.L || 3, N = Math.max(1, Math.round(TD * inp.T)), s = inp.sig / Math.sqrt(TD);
    var dc = ((inp.f || 0) + (L - 1) * (inp.c || 0)) / TD, r = rng(seed || 7), lnI = Math.log(Ireq);
    var out = [], wiped = 0, xs = new Array(N);
    for (var k = 0; k < paths; k++) {
      var sum = 0; for (var i = 0; i < N; i++) { xs[i] = s * gauss(r); sum += xs[i]; }
      var adj = (lnI - sum) / N; for (i = 0; i < N; i++) xs[i] += adj;
      var d = dailyCompound(xs, L, dc); if (d.wiped) wiped++; out.push(d.v);
    }
    out.sort(function (a, b) { return a - b; });
    var mean = 0; out.forEach(function (v) { mean += v; }); mean /= out.length;
    return { N: N, paths: paths, mean: mean, median: quant(out, 0.5), p05: quant(out, 0.05), p95: quant(out, 0.95), wiped: wiped, sorted: out };
  }

  // 결정적 시나리오 경로 (끝 지수 = I_req)
  function scenarios(inp, Ireq) {
    var L = inp.L || 3, N = Math.max(3, Math.round(TD * inp.T)), lnI = Math.log(Ireq);
    var z = inp.sig / Math.sqrt(TD);
    var dc = ((inp.f || 0) + (L - 1) * (inp.c || 0)) / TD;
    function zig(i) { return (i % 2 === 0 ? 1 : -1) * z; } // 짝수 개면 합 0
    function build(shape) {
      var xs = [], i;
      if (shape === "steady") { for (i = 0; i < N; i++) xs.push(lnI / N + zig(i)); }
      else if (shape === "crash") {
        var n1 = Math.max(1, Math.round(N / 3)), drop = Math.log(0.7);
        for (i = 0; i < N; i++) xs.push((i < n1 ? drop / n1 : (lnI - drop) / (N - n1)) + zig(i));
      } else if (shape === "flat") {
        var n2 = Math.max(1, Math.round(N * 0.8));
        for (i = 0; i < N; i++) xs.push((i < n2 ? 0 : lnI / (N - n2)) + zig(i));
      } else if (shape === "gap") {
        // 하루 −34% 급락 후 나머지 기간에 회복해 같은 지수에 도달
        var big = Math.log(0.66);
        for (i = 0; i < N; i++) xs.push((i === Math.floor(N / 4) ? big : (lnI - big) / (N - 1)) + (i === Math.floor(N / 4) ? 0 : zig(i)));
      }
      // 끝값을 정확히 lnI 로 맞춤(zig 합이 홀수 개로 남는 경우 보정)
      var sum = xs.reduce(function (a, b) { return a + b; }, 0), adj = (lnI - sum);
      xs[xs.length - 1] += adj;
      return xs;
    }
    var gbm = etfMultNav(Ireq, inp);
    return [
      { key: "steady", name: "꾸준한 상승 + 일별 등락", xs: build("steady") },
      { key: "crash", name: "급락(−30%) 후 반등", xs: build("crash") },
      { key: "flat", name: "장기 횡보 후 막판 급등", xs: build("flat") },
      { key: "gap", name: "하루 −34% 급락 포함", xs: build("gap") }
    ].map(function (sc) {
      var d = dailyCompound(sc.xs, L, dc);
      var qv = 0; sc.xs.forEach(function (x) { qv += x * x; });
      return { key: sc.key, name: sc.name, daily: d.v, wiped: d.wiped, worst: d.worst, gbm: gbm, realizedVol: Math.sqrt(qv / (sc.xs.length / TD)) };
    });
  }

  // NAV 배수(괴리율 제외)
  function etfMultNav(I, inp) {
    var L = inp.L || 3, T = inp.T, s = inp.sig;
    return Math.exp(L * Math.log(I) - L * (L - 1) / 2 * s * s * T - ((inp.f || 0) + (L - 1) * (inp.c || 0)) * T);
  }

  // 붙여넣은 과거 실제지수 일별 수익률로 이상적 3배 일별 복리 vs GBM 근사
  function historical(returns, inp) {
    if (!returns || returns.length < 20) return null;
    var L = inp.L || 3, dc = ((inp.f || 0) + (L - 1) * (inp.c || 0)) / TD;
    var d = dailyCompound(returns, L, dc);
    var lnI = returns.reduce(function (a, b) { return a + b; }, 0), T = returns.length / TD;
    var vol = sd(returns) * Math.sqrt(TD);
    var gbm = Math.exp(L * lnI - L * (L - 1) / 2 * vol * vol * T - ((inp.f || 0) + (L - 1) * (inp.c || 0)) * T);
    return { n: returns.length, T: T, I: Math.exp(lnI), vol: vol, daily: d.v, wiped: d.wiped, worst: d.worst, gbm: gbm };
  }

  // 원화 투자자 손익
  function krw(A, P, buyFx, nowFx) {
    return { pnl: (P * nowFx) / (A * buyFx) - 1 };
  }

  return {
    TD: TD, num: num, validate: validate, core: core, full: full, toCmp: toCmp, fromCmp: fromCmp,
    etfMult: etfMult, etfMultNav: etfMultNav, parseSeries: parseSeries, regress: regress,
    monteCarlo: monteCarlo, scenarios: scenarios, historical: historical, dailyCompound: dailyCompound, krw: krw, sd: sd
  };
})();
if (typeof module !== "undefined" && module.exports) module.exports = LC;
