const fs = require('fs');

// 로그 함수: 시간과 메시지 출력
const logWithTime = (message, sticker = '🤖') => {
  const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  console.log(`${sticker}[${now}] ${message}`);
};

// 반환값: 'YYYY-MM-DDTHH:mm:ss+09:00' 형태의 KST ISO 문자열
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

module.exports = { logWithTime, getKstIsoNow, getAdItemLink };
