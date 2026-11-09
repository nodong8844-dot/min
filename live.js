// =====================================================================
//  live.js — 시세 공급 + 실시간 방(법당) 백엔드 (계산기·법당 공용)
//
//  모드
//   - firebase : config.firebase 가 있으면. 누구나 같은 방에서 만남.
//                시세는 DB의 prices/ 노드를 모두가 구독하고,
//                Finnhub 조회는 '대표 1명(lease)'만 해서 무료 한도를 지킴.
//                노트북 송신 스크립트(price_pusher.py)가 최근 값을 쓰고 있으면 그 값을 우선.
//   - local    : 설정이 없거나 연결 실패. 같은 브라우저의 탭끼리 BroadcastChannel 로만 연결.
//                시세는 finnhubKey 가 있으면 직접 조회, 없으면 수동 입력.
//
//  어떤 경우에도 가짜 시세·가짜 접속자를 만들지 않는다.
// =====================================================================

const FB_VER = "10.12.2";
const SYMS = ["KORU", "SOXL"];                       // ETF
const IDX = ["NASDAQ", "KOSPI", "SOX", "USDKRW"];      // 지수·환율
const ALL = SYMS.concat(IDX);
// Finnhub 무료 키로는 지수 시세가 안 나오므로 '대용 ETF'를 쓰고, 반드시 proxy 표시를 붙인다
const FINNHUB_MAP = { KORU: "KORU", SOXL: "SOXL", NASDAQ: "QQQ", KOSPI: "EWY", SOX: "SOXX" };
export const META = {
  KORU:   { label: "KORU", unit: "$", dec: 2 },
  SOXL:   { label: "SOXL", unit: "$", dec: 2 },
  NASDAQ: { label: "나스닥", unit: "pt", dec: 2, proxyLabel: "나스닥 대용(QQQ)" },
  KOSPI:  { label: "코스피", unit: "pt", dec: 2, proxyLabel: "한국 대용(EWY)" },
  SOX:    { label: "필라델피아 반도체", unit: "pt", dec: 2, proxyLabel: "반도체 대용(SOXX)" },
  USDKRW: { label: "원/달러", unit: "원", dec: 1 }
};
const CFG = Object.assign({ firebase: null, finnhubKey: "", priceRefreshSec: 15 }, window.LEVER_CONFIG || {});
const REFRESH = Math.max(10, Number(CFG.priceRefreshSec) || 15) * 1000;
const PUSHER_FRESH_MS = 90 * 1000;

function rid() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }
function clampStr(s, n) { return String(s == null ? "" : s).replace(/[\u0000-\u001f]/g, "").slice(0, n); }

// ---------------- 미국 거래 세션 (뉴욕 시간 기준) ----------------
export function usSession(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false
  }).formatToParts(now);
  const g = t => (parts.find(p => p.type === t) || {}).value;
  const wd = g("weekday"); let h = parseInt(g("hour"), 10) % 24; const m = parseInt(g("minute"), 10);
  const mins = h * 60 + m;
  const weekend = wd === "Sat" || (wd === "Sun" && mins < 20 * 60) || (wd === "Fri" && mins >= 20 * 60);
  if (weekend) return { key: "closed", label: "휴장(주말)" };
  if (mins >= 4 * 60 && mins < 9 * 60 + 30) return { key: "pre", label: "프리마켓" };
  if (mins >= 9 * 60 + 30 && mins < 16 * 60) return { key: "regular", label: "정규장" };
  if (mins >= 16 * 60 && mins < 20 * 60) return { key: "after", label: "애프터마켓" };
  return { key: "overnight", label: "주간거래(데이마켓) 시간" };
}

// ---------------- 공용 이벤트 ----------------
const priceSubs = new Set();
let lastPrices = {};
function emitPrices(p) {
  lastPrices = Object.assign({}, lastPrices, p);
  priceSubs.forEach(fn => { try { fn(lastPrices); } catch (e) { console.error(e); } });
}
export function onPrices(fn) { priceSubs.add(fn); if (Object.keys(lastPrices).length) fn(lastPrices); return () => priceSubs.delete(fn); }
export function getPrices() { return lastPrices; }

async function finnhubQuote(sym) {
  const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(sym)}&token=${encodeURIComponent(CFG.finnhubKey)}`);
  if (!r.ok) throw new Error("finnhub " + r.status);
  const j = await r.json();
  if (!(j && j.c > 0)) throw new Error("finnhub empty");
  return { p: +j.c, pc: j.pc > 0 ? +j.pc : null, ts: j.t ? j.t * 1000 : Date.now(), src: "finnhub" };
}
async function finnhubKey(key) {
  const tk = FINNHUB_MAP[key]; if (!tk) throw new Error("no map");
  const q = await finnhubQuote(tk);
  if (tk !== key) q.proxy = tk;
  return q;
}

// ---------------- 상태 ----------------
let ready = null;
export const live = {
  mode: "local",          // 'firebase' | 'local'
  priceSource: "manual",  // 'finnhub' | 'db' | 'manual'
  uid: null,
  error: null,
  setManualPrice(sym, p, pc) {
    p = Number(p);
    if (!(p > 0)) return;
    pc = Number(pc) > 0 ? Number(pc) : null; // (선택) 전일 종가 — 등락률 표시용
    emitPrices({ [sym]: { p, pc, ts: Date.now(), src: "manual" } });
    if (this.mode === "local") { try { bc && bc.postMessage({ t: "price", sym, v: lastPrices[sym] }); } catch (e) {} }
  },
  joinRoom: null
};

// =====================================================================
//  LOCAL backend (BroadcastChannel)
// =====================================================================
let bc = null;
function localInit() {
  live.mode = "local";
  live.uid = (() => { try { let u = sessionStorage.getItem("lv_uid"); if (!u) { u = "local-" + rid(); sessionStorage.setItem("lv_uid", u); } return u; } catch (e) { return "local-" + rid(); } })();
  try {
    bc = new BroadcastChannel("levergachi-prices");
    bc.onmessage = ev => {
      const d = ev.data || {};
      if (d.t === "price" && ALL.includes(d.sym) && d.v && d.v.p > 0) {
        const cur = lastPrices[d.sym];
        if (!cur || (d.v.ts || 0) >= (cur.ts || 0)) emitPrices({ [d.sym]: d.v });
      } else if (d.t === "priceReq") {
        ALL.forEach(s => { if (lastPrices[s]) bc.postMessage({ t: "price", sym: s, v: lastPrices[s] }); });
      }
    };
    bc.postMessage({ t: "priceReq" }); // 나중에 연 탭도 기존 입력 시세를 받도록
  } catch (e) { bc = null; }
  if (CFG.finnhubKey) {
    live.priceSource = "finnhub";
    const poll = async () => {
      for (const s of Object.keys(FINNHUB_MAP)) { try { emitPrices({ [s]: await finnhubKey(s) }); live.error = null; } catch (e) { live.error = "시세 조회 실패: " + e.message; } }
    };
    poll(); setInterval(poll, REFRESH);
  } else live.priceSource = "manual";

  live.joinRoom = (room) => localRoom(room);
}

function localRoom(room) {
  const ch = new BroadcastChannel("levergachi-room-" + room);
  const peers = new Map(); // uid -> {data, seen}
  let me = null;
  const subs = { peers: new Set(), chat: new Set(), fx: new Set(), moktak: new Set() };
  const chatKey = "lv_chat_" + room, mokKey = "lv_mok_" + room, cntKey = "lv_cnt_" + room, voteKey = "lv_vote_" + room;
  let counters = {}; try { counters = JSON.parse(localStorage.getItem(cntKey) || "{}"); } catch (e) {}
  let votes = {}; try { votes = JSON.parse(localStorage.getItem(voteKey) || "{}"); } catch (e) {}
  const cntSubs = {}, voteSubs = {};
  const fireVotes = (topic) => { const t = votes[topic] || {}; const c = { up: 0, down: 0 }; Object.values(t).forEach(v => { if (v === "up" || v === "down") c[v]++; }); (voteSubs[topic] || []).forEach(f => f(c, t[live.uid] || null)); };
  let chat = []; try { chat = JSON.parse(localStorage.getItem(chatKey) || "[]"); } catch (e) {}
  let moktak = 0; try { moktak = +localStorage.getItem(mokKey) || 0; } catch (e) {}
  const firePeers = () => { const arr = []; if (me) arr.push(Object.assign({ uid: live.uid, you: true }, me)); peers.forEach((v, k) => arr.push(Object.assign({ uid: k, you: false }, v.data))); subs.peers.forEach(f => f(arr)); };
  const hb = () => { if (me) ch.postMessage({ t: "hi", uid: live.uid, data: me }); };
  const sweep = () => { const now = Date.now(); let ch2 = false; peers.forEach((v, k) => { if (now - v.seen > 6000) { peers.delete(k); ch2 = true; } }); if (ch2) firePeers(); };
  const t1 = setInterval(hb, 2000), t2 = setInterval(sweep, 2000);
  ch.onmessage = ev => {
    const d = ev.data || {};
    if (d.uid === live.uid) return;
    if (d.t === "hi") { peers.set(d.uid, { data: d.data, seen: Date.now() }); firePeers(); }
    else if (d.t === "bye") { peers.delete(d.uid); firePeers(); }
    else if (d.t === "chat") { chat.push(d.msg); chat = chat.slice(-50); subs.chat.forEach(f => f(d.msg)); }
    else if (d.t === "fx") subs.fx.forEach(f => f(d.fx));
    else if (d.t === "mok") { moktak = Math.max(moktak, d.n); subs.moktak.forEach(f => f(moktak)); }
    else if (d.t === "cnt") { counters[d.name] = Math.max(counters[d.name] || 0, d.n); (cntSubs[d.name] || []).forEach(f => f(counters[d.name])); }
    else if (d.t === "vote") { const t = votes[d.topic] = votes[d.topic] || {}; t[d.uid] = d.choice; fireVotes(d.topic); }
    else if (d.t === "who") hb();
  };
  window.addEventListener("pagehide", () => { try { ch.postMessage({ t: "bye", uid: live.uid }); } catch (e) {} });
  return {
    mode: "local", uid: live.uid, room,
    setMe(data) { me = data; hb(); firePeers(); ch.postMessage({ t: "who", uid: live.uid }); },
    onPeers(f) { subs.peers.add(f); firePeers(); },
    sendChat(text) {
      const msg = { id: rid(), uid: live.uid, nick: me ? me.nick : "?", text: clampStr(text, 120), ts: Date.now() };
      chat.push(msg); chat = chat.slice(-50); try { localStorage.setItem(chatKey, JSON.stringify(chat)); } catch (e) {}
      ch.postMessage({ t: "chat", uid: live.uid, msg }); subs.chat.forEach(f => f(msg));
    },
    onChat(f, history) { subs.chat.add(f); if (history) history(chat.slice()); },
    sendFx(kind) { const fx = { id: rid(), uid: live.uid, kind: clampStr(kind, 20), ts: Date.now() }; ch.postMessage({ t: "fx", uid: live.uid, fx }); subs.fx.forEach(f => f(fx)); },
    onFx(f) { subs.fx.add(f); },
    bumpMoktak() { moktak += 1; try { localStorage.setItem(mokKey, String(moktak)); } catch (e) {} ch.postMessage({ t: "mok", uid: live.uid, n: moktak }); subs.moktak.forEach(f => f(moktak)); },
    onMoktak(f) { subs.moktak.add(f); f(moktak); },
    // 공용 누적 카운터 (예: offer=시주함 동전, bell=종)
    bumpCounter(name) { name = clampStr(name, 16); counters[name] = (counters[name] || 0) + 1; try { localStorage.setItem(cntKey, JSON.stringify(counters)); } catch (e) {} ch.postMessage({ t: "cnt", uid: live.uid, name, n: counters[name] }); (cntSubs[name] || []).forEach(f => f(counters[name])); },
    onCounter(name, f) { (cntSubs[name] = cntSubs[name] || []).push(f); f(counters[name] || 0); },
    // 투표: topic 별로 1인 1표(바꾸기 가능), choice = 'up' | 'down'
    vote(topic, choice) { if (choice !== "up" && choice !== "down") return; const t = votes[topic] = votes[topic] || {}; t[live.uid] = choice; try { localStorage.setItem(voteKey, JSON.stringify(votes)); } catch (e) {} ch.postMessage({ t: "vote", uid: live.uid, topic, choice }); fireVotes(topic); },
    onVotes(topic, f) { (voteSubs[topic] = voteSubs[topic] || []).push(f); fireVotes(topic); },
    leave() { try { ch.postMessage({ t: "bye", uid: live.uid }); } catch (e) {} clearInterval(t1); clearInterval(t2); ch.close(); }
  };
}

// =====================================================================
//  FIREBASE backend (Realtime Database + 익명 로그인)
// =====================================================================
async function firebaseInit() {
  const base = `https://www.gstatic.com/firebasejs/${FB_VER}/`;
  const [{ initializeApp }, A, D] = await Promise.all([
    import(base + "firebase-app.js"), import(base + "firebase-auth.js"), import(base + "firebase-database.js")
  ]);
  const app = initializeApp(CFG.firebase);
  const auth = A.getAuth(app);
  const cred = await A.signInAnonymously(auth);
  const db = D.getDatabase(app);
  live.mode = "firebase"; live.uid = cred.user.uid;

  let offset = 0;
  D.onValue(D.ref(db, ".info/serverTimeOffset"), s => { offset = s.val() || 0; });
  const now = () => Date.now() + offset;

  // ---- 시세 구독 ----
  live.priceSource = "db";
  D.onValue(D.ref(db, "prices"), s => {
    const v = s.val() || {}; const out = {};
    ALL.forEach(k => { if (v[k] && v[k].p > 0) { out[k] = { p: +v[k].p, pc: v[k].pc > 0 ? +v[k].pc : null, ts: +v[k].ts || 0, src: String(v[k].src || "db") }; if (v[k].proxy) out[k].proxy = String(v[k].proxy).slice(0, 8); } });
    if (Object.keys(out).length) emitPrices(out);
  });

  // ---- Finnhub 대표 조회(lease) ----
  if (CFG.finnhubKey) {
    const leaseRef = D.ref(db, "priceLease");
    const tick = async () => {
      // 노트북 송신기가 최근에 썼으면 양보
      const fresh = SYMS.every(k => lastPrices[k] && lastPrices[k].src === "pusher" && now() - lastPrices[k].ts < PUSHER_FRESH_MS);
      if (fresh) return;
      let mine = false;
      try {
        const r = await D.runTransaction(leaseRef, cur => {
          const t = now();
          if (!cur || !cur.until || cur.until < t || cur.uid === live.uid) return { uid: live.uid, until: t + REFRESH * 3 };
          return; // abort
        });
        mine = r.committed && r.snapshot.val() && r.snapshot.val().uid === live.uid;
      } catch (e) { mine = false; }
      if (!mine) return;
      for (const s of Object.keys(FINNHUB_MAP)) {
        // 송신기가 진짜 지수를 최근에 썼으면 대용 ETF로 덮어쓰지 않음
        const cur = lastPrices[s];
        if (cur && cur.src === "pusher" && now() - cur.ts < PUSHER_FRESH_MS) continue;
        try { const q = await finnhubKey(s); const row = { p: q.p, pc: q.pc, ts: q.ts, src: "finnhub" }; if (q.proxy) row.proxy = q.proxy; await D.set(D.ref(db, "prices/" + s), row); live.error = null; }
        catch (e) { live.error = "시세 조회 실패: " + e.message; }
      }
    };
    tick(); setInterval(tick, REFRESH);
  }

  live.setManualPrice = function (sym, p, pc) { p = Number(p); if (p > 0) emitPrices({ [sym]: { p, pc: Number(pc) > 0 ? Number(pc) : null, ts: Date.now(), src: "manual" } }); };

  live.joinRoom = (room) => {
    const R = "rooms/" + room;
    const meRef = D.ref(db, `${R}/users/${live.uid}`);
    D.onDisconnect(meRef).remove();
    let me = null;
    const api = {
      mode: "firebase", uid: live.uid, room,
      setMe(data) {
        me = data;
        const clean = {
          nick: clampStr(data.nick, 12), color: clampStr(data.color, 9), seat: Number.isInteger(data.seat) ? data.seat : -1,
          koru: data.koru > 0 ? Number(data.koru) : 0, soxl: data.soxl > 0 ? Number(data.soxl) : 0,
          pose: clampStr(data.pose || "sit", 12), ts: D.serverTimestamp()
        };
        // 자유 이동 좌표(바닥 기준 %), 바라보는 방향, 걷는 중 여부
        const cl = v => Math.max(0, Math.min(100, Math.round(Number(v) * 10) / 10));
        if (isFinite(Number(data.x)) && isFinite(Number(data.y))) { clean.x = cl(data.x); clean.y = cl(data.y); }
        clean.dir = data.dir === "l" ? "l" : "r";
        clean.mv = !!data.mv;
        // 게임 요소: 공덕 포인트(정수), 머리띠 문구(짧은 문자열), 획득 칭호
        if (data.pts > 0) clean.pts = Math.min(1e7, Math.floor(Number(data.pts)) || 0);
        if (data.hb) clean.hb = clampStr(data.hb, 6);
        if (data.title) clean.title = clampStr(data.title, 12);
        D.set(meRef, clean).catch(e => console.error(e));
      },
      onPeers(f) {
        D.onValue(D.ref(db, `${R}/users`), s => {
          const v = s.val() || {}; const arr = [];
          Object.keys(v).forEach(k => arr.push(Object.assign({ uid: k, you: k === live.uid }, v[k])));
          f(arr);
        });
      },
      sendChat(text) {
        const t = clampStr(text, 120).trim(); if (!t) return;
        D.push(D.ref(db, `${R}/chat`), { uid: live.uid, nick: me ? clampStr(me.nick, 12) : "?", text: t, ts: D.serverTimestamp() });
      },
      onChat(f, history) {
        let first = true; const seen = new Set();
        const q = D.query(D.ref(db, `${R}/chat`), D.limitToLast(50));
        D.onValue(q, s => {
          const arr = []; s.forEach(c => { arr.push(Object.assign({ id: c.key }, c.val())); });
          if (first) { first = false; arr.forEach(m => seen.add(m.id)); if (history) history(arr); return; }
          arr.forEach(m => { if (!seen.has(m.id)) { seen.add(m.id); f(m); } });
        });
      },
      sendFx(kind) { D.push(D.ref(db, `${R}/fx`), { uid: live.uid, kind: clampStr(kind, 20), ts: D.serverTimestamp() }); },
      onFx(f) {
        const q = D.query(D.ref(db, `${R}/fx`), D.limitToLast(20));
        const seen = new Set(); let first = true;
        D.onValue(q, s => {
          const arr = []; s.forEach(c => { arr.push(Object.assign({ id: c.key }, c.val())); });
          arr.forEach(x => { if (seen.has(x.id)) return; seen.add(x.id); if (!first && now() - (x.ts || 0) < 8000) f(x); });
          first = false;
        });
      },
      bumpMoktak() { D.runTransaction(D.ref(db, `${R}/moktak`), n => (n || 0) + 1).catch(() => {}); },
      onMoktak(f) { D.onValue(D.ref(db, `${R}/moktak`), s => f(s.val() || 0)); },
      bumpCounter(name) { name = String(name).replace(/[^a-z0-9]/g, "").slice(0, 16); if (!name) return; D.runTransaction(D.ref(db, `${R}/counters/${name}`), n => (n || 0) + 1).catch(() => {}); },
      onCounter(name, f) { name = String(name).replace(/[^a-z0-9]/g, "").slice(0, 16); D.onValue(D.ref(db, `${R}/counters/${name}`), s => f(s.val() || 0)); },
      vote(topic, choice) { topic = String(topic).replace(/[^a-z0-9-]/g, "").slice(0, 32); if (!topic || (choice !== "up" && choice !== "down")) return; D.set(D.ref(db, `${R}/votes/${topic}/${live.uid}`), choice).catch(() => {}); },
      onVotes(topic, f) { topic = String(topic).replace(/[^a-z0-9-]/g, "").slice(0, 32); D.onValue(D.ref(db, `${R}/votes/${topic}`), s => { const v = s.val() || {}; const c = { up: 0, down: 0 }; Object.values(v).forEach(x => { if (x === "up" || x === "down") c[x]++; }); f(c, v[live.uid] || null); }); },
      leave() { D.remove(meRef).catch(() => {}); }
    };
    return api;
  };
}

export function initLive() {
  if (ready) return ready;
  ready = (async () => {
    if (CFG.firebase && CFG.firebase.apiKey && CFG.firebase.databaseURL) {
      try { await firebaseInit(); return live; }
      catch (e) { console.warn("Firebase 연결 실패, 미리보기 모드로 전환", e); live.error = "Firebase 연결 실패 → 미리보기 모드"; }
    }
    localInit();
    return live;
  })();
  return ready;
}

export const SYMBOLS = SYMS;
export const INDEXES = IDX;
export const ALL_KEYS = ALL;
export const CONFIG = CFG;
