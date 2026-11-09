// =====================================================================
//  레버가치 원복 계산기 / 원복 법당 — 설정 파일
//  비워 두면: 시세는 수동 입력, 법당은 '같은 브라우저 탭끼리'만 연결되는 미리보기 모드
//  채우면:   누구나 접속해 같은 법당에서 만나고, 시세가 자동 반영됩니다.
//  (설정 방법은 README.md 참고)
// =====================================================================
window.LEVER_CONFIG = {
  // Firebase 콘솔 > 프로젝트 설정 > 내 앱(웹) > SDK 구성 값을 그대로 붙여 넣기
  // 예: { apiKey: "AIza...", authDomain: "xxx.firebaseapp.com",
  //       databaseURL: "https://xxx-default-rtdb.asia-southeast1.firebasedatabase.app",
  //       projectId: "xxx", appId: "1:...:web:..." }
  firebase: {
    apiKey: "AIzaSyDQm1IcdcjItUlOufrY7jpkkU7In3bWzJY",
    authDomain: "wonbok-gaekjang.firebaseapp.com",
    databaseURL: "https://wonbok-gaekjang-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "wonbok-gaekjang",
    storageBucket: "wonbok-gaekjang.firebasestorage.app",
    messagingSenderId: "268108760695",
    appId: "1:268108760695:web:40acf78ac828ca6a5ca872"
  },

  // https://finnhub.io 무료 API 키 (없으면 빈 문자열)
  finnhubKey: "",

  // 시세 갱신 주기(초). Finnhub 무료 한도(분당 60회)를 넘지 않도록 10초 이상 권장
  priceRefreshSec: 15
};
