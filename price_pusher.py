r"""
price_pusher.py — (선택) 프리마켓·애프터마켓 시세를 원복 법당/계산기에 올려 주는 송신기

- yfinance 의 prepost=True 1분봉에서 마지막 체결가를 읽어 Firebase prices/ 에 씁니다.
- KORU·SOXL 과 함께 나스닥(^IXIC)·코스피(^KS11)·필라델피아 반도체(^SOX)·원/달러(KRW=X) 진짜 지수값도 올립니다.
- 이 스크립트가 90초 안에 값을 쓰고 있으면, 브라우저들은 Finnhub 조회를 멈추고 이 값을 씁니다.
- 국내 증권사 '데이마켓(주간거래)' 시세는 yfinance 에도 없습니다.

사용법 (윈도우 노트북, 예: C:\stockbot 옆에 두고 작업 스케줄러로 실행)
    pip install yfinance requests
    python price_pusher.py

아래 두 값은 config.js 의 firebase.apiKey, firebase.databaseURL 과 같게 넣으세요.
"""
import time
import requests
import yfinance as yf

API_KEY = "여기에_firebase_apiKey"
DB_URL = "https://여기에-default-rtdb.asia-southeast1.firebasedatabase.app"
# DB 키 : 야후 티커  (지수는 진짜 지수값이라 계산기의 '현재 지수' 자동 반영에 쓰임)
SYMBOLS = {"KORU": "KORU", "SOXL": "SOXL", "NASDAQ": "^IXIC", "KOSPI": "^KS11", "SOX": "^SOX", "USDKRW": "KRW=X"}
INTERVAL_SEC = 30


def anon_token():
    r = requests.post(
        f"https://identitytoolkit.googleapis.com/v1/accounts:signUp?key={API_KEY}",
        json={"returnSecureToken": True}, timeout=10)
    r.raise_for_status()
    j = r.json()
    return j["idToken"], time.time() + int(j.get("expiresIn", 3600)) - 120


def last_price(sym):
    t = yf.Ticker(sym)
    # 지수·환율은 연장거래가 없어도 prepost=True 로 문제없음
    h = t.history(period="1d", interval="1m", prepost=True)
    if h.empty:
        return None
    p = float(h["Close"].dropna().iloc[-1])
    ts = int(h.index[-1].timestamp() * 1000)
    pc = None
    try:
        pc = float(t.fast_info["previous_close"])
    except Exception:
        pass
    return {"p": round(p, 4), "pc": pc, "ts": ts, "src": "pusher"}


def main():
    token, exp = anon_token()
    while True:
        if time.time() > exp:
            token, exp = anon_token()
        for s, tk in SYMBOLS.items():
            try:
                q = last_price(tk)
                if q:
                    # 노트북 시각이 아니라 '지금 쓴 시각'을 넣어 신선도 판단(브라우저는 ts 기준 90초)
                    q["ts"] = int(time.time() * 1000)
                    requests.put(f"{DB_URL}/prices/{s}.json?auth={token}", json=q, timeout=10).raise_for_status()
                    print(time.strftime("%H:%M:%S"), s, q["p"])
            except Exception as e:
                print("오류", s, e)
        time.sleep(INTERVAL_SEC)


if __name__ == "__main__":
    main()
