const fs = require('fs');

//✅ 로그 함수: 시간과 메시지 출력
const logWithTime = (message, sticker = '🤖') => {
  const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  console.log(`${sticker}[${now}] ${message}`);
};

//✅ 날짜시간 포맷팅 함수(반환값: 'YYYY-MM-DDTHH:mm:ss+09:00' 형태의 KST ISO 문자열)
const getKstIsoNow = () => {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  const kst = new Date(utc + 9 * 60 * 60000);
  const Y = kst.getFullYear();
  const M = String(kst.getMonth() + 1).padStart(2, '0');
  const D = String(kst.getDate()).padStart(2, '0');
  const h = String(kst.getHours()).padStart(2, '0');
  const m = String(kst.getMinutes()).padStart(2, '0');
  const s = String(kst.getSeconds()).padStart(2, '0');
  return `${Y}-${M}-${D}T${h}:${m}:${s}+09:00`;
};

//✅ 현재시간으로부터 1시간 이내인지 확인하는 함수
function isWithinLastHour(timestampStr) {
  if (!/^\d{17}$/.test(timestampStr)) {
    throw new Error("형식 오류: YYYYMMDDHHmmssSSS 형식의 문자열을 입력해야 합니다.");
  }

  // 문자열을 날짜 객체로 변환
  const year = parseInt(timestampStr.slice(0, 4));
  const month = parseInt(timestampStr.slice(4, 6)) - 1; // 0부터 시작
  const day = parseInt(timestampStr.slice(6, 8));
  const hour = parseInt(timestampStr.slice(8, 10));
  const minute = parseInt(timestampStr.slice(10, 12));
  const second = parseInt(timestampStr.slice(12, 14));
  const ms = parseInt(timestampStr.slice(14, 17));

  const inputDate = new Date(year, month, day, hour, minute, second, ms);
  const now = new Date();

  const diffMs = now - inputDate; // 밀리초 단위 차이
  const oneHourMs = 60 * 60 * 1000;

  // 현재 시간보다 과거이고, 1시간 이내면 true
  return diffMs >= 0 && diffMs <= oneHourMs;
}

//✅ 네이버 커넥트 URL 가져오는 함수
// JSON 파일에서 링크를 불러오는 함수
const loadLinks = () => {
  return new Promise((resolve, reject) => {
    fs.readFile('adv-item-links.json', 'utf8', (err, data) => {
      if (err) {
        reject(err);
      } else {
        resolve(JSON.parse(data).links); // links 배열만 반환
      }
    });
  });
};
// getAdItemLink 함수 수정 (비동기 처리)
const getAdItemLink = async () => {
  try {
    const links = await loadLinks(); // 링크 배열 불러오기
    return links[Math.floor(Math.random() * links.length)];
  } catch (error) {
    console.error('Error loading links:', error);
    return null; // 오류가 발생하면 null 반환
  }
};

module.exports = { logWithTime, getKstIsoNow, isWithinLastHour, getAdItemLink };
