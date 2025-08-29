export const logWithTime = (message, sticker = '🤖') => {
  const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  console.log(`${sticker}[${now}] ${message}`);
};
