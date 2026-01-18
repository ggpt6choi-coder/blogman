const axios = require('axios');
const { logWithTime } = require('./common');

//✅ 네이버 로그인 공통 함수
async function naverLogin(page, id, pw) {
    if (!id || !pw) {
        throw new Error('Naver Login Error: ID or Password is missing.');
    }
    await page.goto('https://nid.naver.com/nidlogin.login');
    await page.fill('#id', id);
    await page.fill('#pw', pw.replace(/"/g, ''));
    await page.click('#log\\.login');
    await page.waitForNavigation();
}

//✅ 실행 시간 조건 체크 함수
const checkExecutionTime = async (jsonFileName, limitHours) => {
    try {
        const TIME_CHECK_URL = 'https://raw.githubusercontent.com/ggpt6choi-coder/blogman/main/data';
        const response = await axios.get(`${TIME_CHECK_URL}/${jsonFileName}`);
        const timeData = response.data;
        const createdTime = new Date(timeData.created);
        const now = new Date();
        const limitHoursAgo = new Date(now.getTime() - limitHours * 60 * 60 * 1000);

        if (!(createdTime >= limitHoursAgo && createdTime <= now)) {
            logWithTime(`실행 조건 불만족: ${jsonFileName}의 created 값이 ${limitHours}시간 이내가 아닙니다.`, '❌');
            process.exit(0);
        }
    } catch (error) {
        logWithTime(`[오류] 시간 데이터 확인 실패 (${jsonFileName}): ${error.message}`, '❌');
        process.exit(0);
    }
};

module.exports = { naverLogin, checkExecutionTime };
