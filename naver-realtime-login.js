require('dotenv').config();
const { chromium } = require('playwright');
const { logWithTime, getAdItemLink } = require('./common');
const fs = require('fs');

// ==========================
// 네이버 로그인 함수
// ==========================
async function naverLogin(page) {
  await page.goto('https://nid.naver.com/nidlogin.login');
  await page.fill('#id', process.env.NAVER_ID_2);
  await page.fill('#pw', process.env.NAVER_PW_2.replace(/"/g, ''));
  await page.click('#log\\.login');
  await page.waitForNavigation();
}

// ==========================
// 블로그 글쓰기 함수
// ==========================
async function writeBlog({
  page,
  blogName,
  title,
  content,
  url,
  hashTag,
  type,
  idx = 0, // 예약 간격을 위한 인덱스(기본값 0)
}) {
  // 글쓰기 페이지 이동
  await page.goto(`https://blog.naver.com/${blogName}?Redirect=Write`);

  // mainFrame iframe 접근
  // iframe DOM 먼저 확인
  await page.waitForSelector('iframe#mainFrame', { timeout: 15000 });
  // 그 다음 frame 객체 추출
  const frame = await page.frame({ name: 'mainFrame' });
  if (!frame) throw new Error('mainFrame을 찾지 못했습니다');

  // '취소' 버튼 처리 (있으면 클릭)
  const cancelBtn = await frame
    .waitForSelector('button.se-popup-button.se-popup-button-cancel', {
      timeout: 5000,
    })
    .catch(() => null);
  if (cancelBtn) await cancelBtn.click();

  // '도움말' 버튼 처리 (있으면 클릭)
  const helpBtn = await frame
    .waitForSelector('article > div > header > button', {
      timeout: 5000,
    })
    .catch(() => null);
  if (helpBtn) await helpBtn.click();

  // '제목' 입력
  const titleParagraphSelector =
    'div.se-component.se-documentTitle .se-title-text p.se-text-paragraph';

  // 실제 클릭으로 커서 이동 후 입력
  await frame.click(titleParagraphSelector, { clickCount: 1, delay: 100 });
  await frame.waitForTimeout(300);
  await frame.type(titleParagraphSelector, title, { delay: 80 });

  // 본문 입력 처리
  const contentParagraphSelector =
    'div.se-component.se-text .se-component-content p.se-text-paragraph';
  const contentSpanSelector =
    'div.se-component.se-text .se-component-content p.se-text-paragraph span.se-ff-nanumgothic.se-fs15.__se-node';
  await frame.waitForSelector(contentParagraphSelector, { timeout: 5000 });
  await frame.click(contentParagraphSelector, { clickCount: 1, delay: 100 });
  await frame.waitForTimeout(200);

  await frame.type(contentSpanSelector, title, { delay: 40 });
  await page.waitForTimeout(300);
  await page.keyboard.press('Enter');

  await frame.type(contentSpanSelector, await getAdItemLink(), { delay: 40 });
  await page.keyboard.press('Enter');
  await frame.waitForTimeout(3000);

  if (Array.isArray(content)) {
    for (const section of content) {
      if (section.title) {
        await frame.click('button.se-text-icon-toolbar-select-option-button.__se-sentry', { clickCount: 1, delay: 100 });
        await frame.click('button.se-toolbar-option-insert-quotation-quotation_underline-button', { clickCount: 1, delay: 100 });
        await frame.type(contentSpanSelector, section.title, { delay: 40 });
        await frame.click('div.se-canvas-bottom.se-is-clickable-canvas-bottom-button > button', { clickCount: 1, delay: 100 });
        await frame.waitForTimeout(100);
      }
      if (section.content) {
        await frame.type(contentSpanSelector, section.content, { delay: 10 });
        await page.keyboard.press('Enter');
        await frame.waitForTimeout(200);
      }
      // 소제목/내용 사이 구분을 위해 한 줄 띄움
      await page.keyboard.press('Enter');
      await frame.waitForTimeout(100);
    }
  } else if (typeof content === 'string') {
    // 본문 길면 오류나는거 방지 차원에서 본문 반틈 나눠서 작성
    const half = Math.floor(content.length / 2);
    const firstHalf = content.slice(0, half);
    const secondHalf = content.slice(half);

    await frame.type(contentSpanSelector, firstHalf, { delay: 10 });
    // await page.keyboard.press('Enter');
    await frame.waitForTimeout(200);
    await frame.type(contentSpanSelector, secondHalf, { delay: 10 });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
  }

  await frame.type(contentSpanSelector, await getAdItemLink(), { delay: 40 });
  await page.keyboard.press('Enter');
  await frame.waitForTimeout(3000);
  await page.keyboard.press('Enter');

  const spans = await frame.$$(contentSpanSelector);
  const lastSpan = spans[spans.length - 1];
  if (lastSpan) {
    await lastSpan.type(hashTag.join(' '), { delay: 80 });
  }
  // await frame.type(contentSpanSelector, hashTag.join(' '), { delay: 80 });

  // 발행 세팅
  // 1. 발행 버튼 클릭 (frame context)
  const publishBtnSelector =
    'div.header__Ceaap > div > div.publish_btn_area__KjA2i > div:nth-child(2) > button';
  await frame.waitForSelector(publishBtnSelector, { timeout: 10000 });
  await frame.click(publishBtnSelector);

  // 2. #radio_time2 라디오버튼 등장 시 클릭 (frame context)
  await frame.waitForSelector('#radio_time2', { timeout: 10000 });
  await frame.evaluate(() => {
    document.querySelector('#radio_time2')?.click();
  });

  // 3. 시간설정 (2개씩 같은 시간)
  const group = Math.floor(idx / 2);
  const baseTime = new Date();
  baseTime.setMinutes(baseTime.getMinutes() + 10 + group * 10);
  let hour = baseTime.getHours();
  let minute = baseTime.getMinutes();
  minute = Math.ceil(minute / 10) * 10;
  if (minute === 60) {
    minute = 0;
    hour += 1;
  }
  if (hour === 24) {
    hour = 0;
  }
  const hourStr = hour.toString().padStart(2, '0');
  const minuteStr = minute.toString().padStart(2, '0');
  await frame.selectOption('select.hour_option__J_heO', hourStr);
  await frame.selectOption('select.minute_option__Vb3xB', minuteStr);

  // 4. 카테고리 설정
  const typeMap = {
    경제: '경제',
    사회: '사회',
    기업: '기업',
    문화: '문화',
    정치: '정치',
    국제: '국제',
    증권: '증권',
    부동산: '부동산',
    스포츠: '스포츠',
    게임: '게임',
  };

  const categoryName = typeMap[type] || type;
  await frame.click('button[aria-label="카테고리 목록 버튼"]');
  await frame.click(
    `span[data-testid^="categoryItemText_"]:text("${categoryName}")`
  );

  // 발행버튼 클릭
  await frame.waitForSelector('.confirm_btn__WEaBq', { timeout: 10000 });
  await frame.click('.confirm_btn__WEaBq');
}

// ==========================
// 실행 부분
// ==========================
(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();
  // navigator.webdriver 제거 (로봇 탐지 우회)
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  logWithTime('시작');
  await naverLogin(page);
  logWithTime('로그인 완료');

  // 카테고리명 인자 받아서 해당 JSON 파일 읽기
  // const category = process.argv[2] || 'economy';
  // const fileName = `./data/mk-news-${category}.json`;
  const fileName = `./data/mk-news.json`;
  const newsList = JSON.parse(fs.readFileSync(fileName, 'utf-8'));

  let errCount = 0;
  for (let i = 0; i < newsList.length; i++) {
    const news = newsList[i];
    if (news.newTitle === '[변환 실패]' || news.newArticle === '[변환 실패]')
      continue;

    const blogData = {
      page,
      blogName: process.env.BLOG_NAME_2,
      title: news.newTitle || news.title,
      content: news.newArticle,
      url: news.url,
      hashTag: news.hashTag,
      type: news.type,
      idx: i,
    };
    try {
      await writeBlog(blogData);
    } catch (err) {
      errCount++;
      const errorLog = `[${new Date().toISOString()}] [writeBlog 오류] idx: ${i}, title: ${news.title
        }\nError: ${err && err.stack ? err.stack : err}\n`;
      console.error(errorLog);
      fs.appendFileSync(
        'error-log/naver-realtime-upload-error.log',
        errorLog,
        'utf-8'
      );
    }
    // 필요시 대기시간 추가 가능 (예: await page.waitForTimeout(1000);)
  }
  logWithTime(
    // `[${category}]모든 글 작성 완료 (실패건수: ${errCount} / ${newsList.length})`
    `[모든 글 작성 완료 (실패건수: ${errCount} / ${newsList.length})`
  );
  await browser.close();
})();
