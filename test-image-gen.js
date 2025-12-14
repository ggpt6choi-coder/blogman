const { chromium } = require('playwright');
const { generateThumbnail } = require('./image-generator');
const path = require('path');

(async () => {
    const browser = await chromium.launch({ headless: false }); // Show browser to see it happening
    const page = await browser.newPage();

    const testTitle = "이것은 테스트 썸네일입니다.\nPlaywright로 생성되었습니다.";
    const outputPath = path.resolve('image/test_thumbnail.png');

    console.log('썸네일 생성 시작...');
    await generateThumbnail(page, testTitle, outputPath);
    console.log(`썸네일 생성 완료: ${outputPath}`);

    await page.waitForTimeout(2000); // 잠시 대기해서 눈으로 확인
    await browser.close();
})();
