require('dotenv').config();
const { chromium } = require('playwright');
const feedsConfig = require('./new-feeds-config');

(async () => {
  const cfg = feedsConfig.k1;
  const blogName = process.env[cfg.blogEnv];

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' });
  const page = await context.newPage();

  await page.goto('https://nid.naver.com/nidlogin.login');
  console.log('⏳ 로그인해주세요...');
  await page.waitForURL(url => !url.href.includes('nidlogin'), { timeout: 120000 });
  console.log('✅ 로그인 완료!');

  // writeNaverPost 직접 테스트
  const { writeNaverPost } = require('./new-common-write');

  const testContent = [
    {
      title: '이게 바로 소제목입니다',
      content: '소제목 아래 들어가는 본문 내용입니다. 이 텍스트는 일반 크기로 표시됩니다. 여러 줄에 걸쳐서 작성될 수 있습니다.',
    },
    {
      title: '두 번째 섹션 소제목',
      content: '두 번째 섹션의 본문 내용입니다. 구분선이 위에 표시되고, 소제목은 굵고 파란색으로 표시됩니다.',
    },
    {
      title: '세 번째 섹션 마지막',
      content: '마지막 섹션입니다. 구분선 없이 끝납니다.',
    },
  ];

  await writeNaverPost({
    page,
    blogName,
    title: '🔧 스타일 테스트 포스팅',
    content: testContent,
    hashTag: ['테스트', '자동화'],
    type: null,
    idx: 0,
    dryRun: true, // 실제 발행 안 함
  });

  console.log('\n✅ 테스트 완료! 브라우저에서 결과를 확인하세요.');
  console.log('60초 후 종료됩니다.');
  await page.waitForTimeout(60000);
  await browser.close();
})();
