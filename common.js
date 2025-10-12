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

module.exports = { logWithTime, getKstIsoNow };


