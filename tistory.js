require('dotenv').config();
const { chromium } = require('playwright');
const { logWithTime } = require('./common');
const fs = require('fs');

// ==========================
// 티스토리 로그인 함수
// ==========================
async function tistoryLogin(page) {
  await page.goto(
    'https://accounts.kakao.com/login/?continue=https%3A%2F%2Fkauth.kakao.com%2Foauth%2Fauthorize%3Fclient_id%3D3e6ddd834b023f24221217e370daed18%26state%3DaHR0cHM6Ly93d3cudGlzdG9yeS5jb20v%26redirect_uri%3Dhttps%253A%252F%252Fwww.tistory.com%252Fauth%252Fkakao%252Fredirect%26response_type%3Dcode%26auth_tran_id%3DD_6h.j6MRcBx1hgddDsXrxr4j4ozRTZX8n2utnvJnOEspBQoIKM4Wltt6vCp%26ka%3Dsdk%252F2.7.3%2520os%252Fjavascript%2520sdk_type%252Fjavascript%2520lang%252Fko-KR%2520device%252FMacIntel%2520origin%252Fhttps%25253A%25252F%25252Fwww.tistory.com%26is_popup%3Dfalse%26through_account%3Dtrue&talk_login=hidden#login'
  );

  await page.fill('#loginId--1', process.env.TISTORY_ID);
  await page.fill('#password--2', process.env.TISTORY_PW.replace(/"/g, ''));
  await page.click(
    '#mainContent > div > div > form > div.confirm_btn > button.btn_g.highlight.submit'
  );
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
  await page.goto(`https://deeev-choi.tistory.com/manage/newpost`);

  // dialog 이벤트 핸들러 설정
  page.on('dialog', async (dialog) => {
    const msg = dialog.message();
    if (msg.includes('작성 모드')) {
      await dialog.accept(); // HTML모드 변경 시 '확인'
    } else {
      await dialog.dismiss(); // 기존 글썼다는 confirm창 처리에서는 '취소'
    }
  });

  // HTML모드로 변경 (이때만 '확인' 버튼 누름)
  await page.click('#editor-mode-layer-btn-open');
  await page.click('#editor-mode-html');

  // 카테고리 선택
  console.log(`type: ${type}`);
  await page.click('#category-btn');
  if (type === '경제') {
    //경제
    await page.click('#category-item-1320035');
  } else if (type === '사회') {
    //사회
    await page.click('#category-item-1320036');
  } else if (type === '기업') {
    //기업
    await page.click('#category-item-1320037');
  } else if (type === '문화') {
    //문화
    await page.click('#category-item-1320038');
  } else if (type === '정치') {
    //정치
    await page.click('#category-item-1320039');
  } else if (type === '국제') {
    //국제
    await page.click('#category-item-1320040');
  } else if (type === '증권') {
    //증권
    await page.click('#category-item-1320041');
  } else if (type === '부동산') {
    //부동산
    await page.click('#category-item-1320042');
  } else if (type === '스포츠') {
    //스포츠
    await page.click('#category-item-1320043');
  } else if (type === '게임') {
    //게임
    await page.click('#category-item-1320044');
  }

  // '제목' 입력
  const titleParagraphSelector = '#post-title-inp';
  await page.click(titleParagraphSelector, { clickCount: 1, delay: 100 });
  await page.waitForTimeout(300);
  await page.type(titleParagraphSelector, title, { delay: 50 });

  // '본문' 입력
  await page.click('.CodeMirror');
  await page.type('.CodeMirror textarea', content, { delay: 20 });

  // 발행
  await page.click('#publish-layer-btn');
  await page.waitForTimeout(1000);
  await page.click('#publish-btn');
}

// ==========================
// 실행 부분
// ==========================
(async () => {
  const browser = await chromium.launch({
    headless: false,
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
  await tistoryLogin(page);
  logWithTime('로그인 완료');

  // 카테고리명 인자 받아서 해당 JSON 파일 읽기
  const category = process.argv[2] || 'economy';
  // const fileName = `./data/mk-news-${category}.json`;
  const fileName = `./data/tistory-mk-news.json`;
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
      const errorLog = `[${new Date().toISOString()}] [writeBlog 오류] idx: ${i}, title: ${
        news.title
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
    `[${category}]모든 글 작성 완료 (실패건수: ${errCount} / ${newsList.length})`
  );
  // await browser.close();
})();
