require('dotenv').config();
const { chromium } = require('playwright');
const { logWithTime } = require('./common');
const fs = require('fs');
const path = require('path');

const contentsData = JSON.parse(fs.readFileSync(path.join(__dirname, 'blog-data.json'), 'utf8'));
const SHOW_BROWSER = false; // 실행 중 브라우저 창 표시 여부

// ==========================
// 🔵 네이버 로그인 함수
// ==========================
async function naverLogin(page) {
  await page.goto('https://nid.naver.com/nidlogin.login');
  await page.fill('#id', process.env.NAVER_ID_WRITE);
  await page.fill('#pw', process.env.NAVER_PW_WRITE.replace(/"/g, ''));
  await page.click('#log\\.login');
  await page.waitForNavigation();
}

// ==========================
// 🔵 스타일 강제 적용 도우미 함수
// ==========================
async function applyDefaultStyle(frame) {
  try {
    // 1. 글자 색상 복구 (검정색 #000000)
    try {
      const colorBtn = await frame.$('button.se-font-color-toolbar-button');
      if (colorBtn) {
        await colorBtn.click();
        await frame.waitForTimeout(100);
        const blackColorBtn = await frame.$('button.se-color-palette[data-color="#000000"]');
        if (blackColorBtn) {
          await blackColorBtn.click();
        } else {
          const colorOptions = await frame.$$('.se-popup-color-layer button');
          if (colorOptions.length > 0) await colorOptions[0].click();
        }
        await frame.waitForTimeout(100);
      }
    } catch (e) { }

    // 2. 글자 크기 복구 (15px)
    try {
      const fontSizeBtnSelector = 'li.se-toolbar-item-font-size-code button';
      let fontSizeBtn = await frame.$(fontSizeBtnSelector);
      if (!fontSizeBtn) fontSizeBtn = await frame.$('button.se-font-size-toolbar-button');

      if (fontSizeBtn) {
        await fontSizeBtn.click();
        await frame.waitForTimeout(100);
        const sizeOption13 = await frame.$('button.se-toolbar-option-font-size-code-fs13-button, button.se-toolbar-option-font-size-13');
        if (sizeOption13) {
          await sizeOption13.click();
        } else {
          const options = await frame.$$('ul.se-toolbar-list-font-size button');
          for (const opt of options) {
            if ((await opt.innerText()).trim() === '13') {
              await opt.click();
              break;
            }
          }
        }
        await frame.waitForTimeout(100);
      }
    } catch (e) { }

    // 3. 굵게 해제 (se-is-selected 클래스 확인)
    try {
      const boldBtnSelector = 'li.se-toolbar-item-bold button';
      const boldBtn = await frame.$(boldBtnSelector);
      if (boldBtn) {
        const classAttr = await boldBtn.getAttribute('class');
        if (classAttr && classAttr.includes('se-is-selected')) {
          await boldBtn.click();
          await frame.waitForTimeout(100);
        }
      }
    } catch (e) { }

    // 4. 가운데 정렬 적용 (모바일 최적화)
    try {
      const alignDropdownSelector = 'li.se-toolbar-item-align > div > button';
      const alignDropdownBtn = await frame.$(alignDropdownSelector);

      if (alignDropdownBtn) {
        await alignDropdownBtn.click();
        await frame.waitForTimeout(200); // 메뉴 열림 대기
        const alignCenterSelector = 'button.se-toolbar-option-align-center-button';
        const alignCenterBtn = await frame.$(alignCenterSelector);
        if (alignCenterBtn) await alignCenterBtn.click();
      } else {
        const alignCenterSelector = 'button.se-toolbar-option-align-center-button';
        const alignCenterBtn = await frame.$(alignCenterSelector);
        if (alignCenterBtn) await alignCenterBtn.click();
      }
      await frame.waitForTimeout(100);
    } catch (e) { }
  } catch (e) { console.log('스타일 강제 적용 실패:', e.message); }
}

// ==========================
// 🔵 블로그 글쓰기 함수
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

  // 1. 제목 입력
  await frame.click(titleParagraphSelector, { clickCount: 1, delay: 100 });
  await frame.waitForTimeout(300);
  await frame.type(titleParagraphSelector, title, { delay: 80 });

  // 본문 입력 처리 (content: string 또는 배열 모두 지원)
  const contentParagraphSelector =
    'div.se-component.se-text .se-component-content p.se-text-paragraph';
  const contentSpanSelector =
    'div.se-component.se-text .se-component-content p.se-text-paragraph span.se-ff-nanumgothic.se-fs15.__se-node';

  // 2. 썸네일 이미지 생성 및 업로드 (상단)
  // 제목 입력 후 엔터를 쳐서 본문 첫 줄 생성
  await page.keyboard.press('Enter');
  await frame.waitForTimeout(500);

  // 1-1. URL이 있는 경우 'sentence.png' 이미지 삽입 (맨 상단) - 제거됨
  // if (url) { ... }

  // 썸네일 생성 로직 제거됨

  // 3. "제품 먼저 바로보기" 링크 삽입
  // 3. "제품 먼저 바로보기" 링크 삽입 - 제거됨
  // if (url) { ... }


  // URL 입력 (전달받은 url 사용) - 하단에 또 넣을지 여부는 기존 로직 유지
  // 기존 로직에서 하단 URL 입력 부분이 있으므로 여기서는 제거하거나 유지
  // 사용자가 "제품 먼저 바로보기"를 원했으므로 상단 링크는 완료됨.
  // 하단 URL 입력 로직은 아래쪽에 별도로 존재함 (line 390 근처).

  // 본문 입력 처리 (content: Array)
  if (Array.isArray(content)) {
    for (const section of content) {
      // 1. 텍스트 타입 처리
      if (section.type === 'text') {
        // 소제목(subtitle)이 있는 경우 - 인용구 스타일 적용
        if (section.subtitle) {
          // 인용구(소제목) 버튼 클릭
          await frame.click('button.se-text-icon-toolbar-select-option-button.__se-sentry', { clickCount: 1, delay: 100 });
          await frame.click('button.se-toolbar-option-insert-quotation-quotation_underline-button', { clickCount: 1, delay: 100 });
          await frame.waitForTimeout(500);

          // 포커스가 인용구에 있을 것이므로 키보드로 입력
          await page.keyboard.type(section.subtitle, { delay: 40 });

          // 소제목 빠져나오기 (하단 클릭)
          try {
            await page.keyboard.press('PageDown');
            await frame.waitForTimeout(500);
            const bottomBtn = await frame.waitForSelector('div.se-canvas-bottom', { timeout: 3000 });
            if (bottomBtn) await bottomBtn.click();
          } catch (e) {
            console.log('하단 버튼 클릭 실패, 키보드로 이동 시도');
            await page.keyboard.press('ArrowDown');
            await page.keyboard.press('Enter');
            await frame.waitForTimeout(200);
            await page.keyboard.press('ArrowDown');
          }
          await frame.waitForTimeout(200);
        }

        // 본문 내용(value) 입력
        if (section.value) {
          await applyDefaultStyle(frame); // 스타일 강제 적용

          // \n, \n\n 처리를 위해 split 후 한 줄씩 입력
          const lines = section.value.split('\n');
          for (let k = 0; k < lines.length; k++) {
            const line = lines[k];
            if (line) {
              await page.keyboard.type(line, { delay: 10 });
            }
            // 줄바꿈 (빈 줄이면 그냥 엔터만 입력되어 공백 라인이 생김)
            await page.keyboard.press('Enter');
            // 너무 빠르면 씹힐 수 있으므로 약간의 딜레이
            if (lines.length > 5) await frame.waitForTimeout(50);
          }
          await frame.waitForTimeout(100);
        }
        await frame.waitForTimeout(100);
      }

      // 2. 이미지 타입 처리
      else if (section.type === 'image') {
        if (section.guide) {
          console.log(`[이미지 가이드 작성] ${section.guide}`);

          // 가이드 텍스트 입력 (괄호로 묶어서 구분)
          await page.keyboard.press('Enter');
          const guideText = `📷 [사진 넣을 곳: ${section.guide}]`;
          await page.keyboard.type(guideText, { delay: 20 });

          // 입력 후 줄바꿈 2번 (구분감 확보)
          await page.keyboard.press('Enter');
          await page.keyboard.press('Enter');
          await frame.waitForTimeout(100);
        }
      }
    }
  }

  // 하단 URL 입력 (전달받은 url 사용)
  // 하단 URL 입력 (전달받은 url 사용) - 제거됨
  // if (url) { ... }

  // 해시태그 입력 (맨 마지막에)
  if (hashTag && hashTag.length > 0) {
    // 혹시 모르니 맨 아래로 이동 및 엔터
    await page.keyboard.press('PageDown');
    await frame.waitForTimeout(200);

    // 에디터 하단 클릭 (확실하게 맨 끝으로)
    try {
      await frame.click('div.se-canvas-bottom', { force: true });
    } catch (e) {
      // 실패 시 키보드로 이동
      await page.keyboard.press('End');
      await page.keyboard.press('Enter');
    }
    await frame.waitForTimeout(300);

    // 스타일 초기화 (검정, 15px, 왼쪽 정렬) - 해시태그는 깔끔하게
    await applyDefaultStyle(frame);

    await page.keyboard.type(hashTag.join(' '), { delay: 40 });
    await page.keyboard.press('Enter');
  }

  // 발행 세팅 -> 임시저장으로 변경
  try {
    // 저장 버튼 (HTML 분석 결과: save_btn__bzc5B)
    const saveBtnSelector = 'button.save_btn__bzc5B';
    await frame.waitForSelector(saveBtnSelector, { timeout: 5000 });
    await frame.click(saveBtnSelector);
    await frame.waitForTimeout(1500); // 저장 완료 대기
  } catch (e) {
    console.log('임시저장 버튼 클릭 실패:', e.message);
  }
}

// ==========================
// 🔵 실행 부분
// ==========================

(async () => {
  // 데이터 파일 읽기
  let blogPosts = [];
  try {
    blogPosts = JSON.parse(fs.readFileSync('./blog-goods-data.json', 'utf8'));
  } catch (err) {
    console.error('데이터 파일 읽기 실패:', err);
    process.exit(1);
  }

  if (blogPosts.length === 0) {
    console.log('작성할 블로그 포스트가 없습니다.');
    process.exit(0);
  }

  //시작
  const browser = await chromium.launch({
    headless: !SHOW_BROWSER,
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

  let errCount = 0;
  // 1회 반복으로 변경 (contentsData가 단일 객체이므로)
  for (let i = 0; i < 1; i++) {
    // const post = blogPosts[i]; (기존 로직 주석 처리)
    // 수정된 contentsData를 바로 사용
    // contentsData는 상단에 정의된 전역 변수
    const blogData = {
      page,
      blogName: process.env.BLOG_NAME_WRITE,
      title: contentsData.title,
      content: contentsData.content,
      url: '', // 예시 데이터에는 URL이 없으므로 빈 문자열 (필요 시 contentsData에 추가)
      hashTag: contentsData.hashtags || [],
      type: '',
      idx: 0,
    };

    try {
      logWithTime(`글 작성 시작: ${blogData.title}`);
      await writeBlog(blogData);
      logWithTime(`🍀글 작성 완료`);
    } catch (err) {
      errCount++;
      const errorLog = `[${new Date().toISOString()}] [writeBlog 오류] idx: ${i}, title: ${blogData.title}\nError: ${err && err.stack ? err.stack : err}\n`;
      console.error(errorLog);
      // 폴더가 없으면 에러날 수 있으니 체크
      if (!fs.existsSync('error-log')) fs.mkdirSync('error-log');
      fs.appendFileSync('error-log/naver-upload-error.log', errorLog, 'utf-8');
    }

    // 다음 글 작성을 위한 대기 (안전하게 5초)
    if (i < blogPosts.length - 1) {
      await page.waitForTimeout(3000);
    }
  }
  logWithTime(
    `🍀모든 글 작성 완료 (실패 건수: ${errCount} / ${blogPosts.length})`
  );
  await browser.close();
})();
