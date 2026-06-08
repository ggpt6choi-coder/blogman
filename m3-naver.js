require('dotenv').config();
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();

// Stealth 플러그인 활성화
chromium.use(stealth);

const { logWithTime, getAdItemLink, insertLinkAndRemoveUrl } = require('./common');
const { naverLogin, checkExecutionTime } = require('./common-write');
const { generateThumbnail } = require('./image-generator');
const fetch = require('node-fetch');
const _fetch = fetch.default || fetch;
const fs = require('fs');
const SHOW_BROWSER = false; // 실행 중 브라우저 창 표시 여부


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
  // 📸 썸네일 생성 (글쓰기 페이지 이동 전)
  const path = require('path');
  const thumbnailPath = path.resolve(`image/thumbnail_${Date.now()}.png`);
  try {
    await generateThumbnail(page, title, thumbnailPath);
  } catch (genErr) {
    console.log('썸네일 생성 실패:', genErr.message);
  }

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

  // 본문 입력 처리 (content: string 또는 배열 모두 지원)
  const contentParagraphSelector =
    'div.se-component.se-text .se-component-content p.se-text-paragraph';
  const contentSpanSelector =
    'div.se-component.se-text .se-component-content p.se-text-paragraph span.se-ff-nanumgothic.se-fs15.__se-node';
  await frame.waitForSelector(contentParagraphSelector, { timeout: 5000 });
  await frame.click(contentParagraphSelector, { clickCount: 1, delay: 100 });
  await frame.waitForTimeout(200);

  // content가 배열(newArticle 구조)일 경우 각 소제목+내용 순차 입력
  await frame.type(contentSpanSelector, title, { delay: 40 });

  // 공정위문구사진
  // try {
  //   const sentenceImagePath = path.resolve('image/sentence.png');
  //   // 파일 선택창 대기
  //   const fileChooserPromise = page.waitForEvent('filechooser');
  //   // '사진' 버튼 클릭
  //   await frame.click('button.se-image-toolbar-button');
  //   const fileChooser = await fileChooserPromise;
  //   await fileChooser.setFiles(sentenceImagePath);
  //   await frame.waitForTimeout(2000); // 업로드 및 렌더링 대기
  //   await frame.waitForTimeout(500);
  // } catch (e) {
  //   console.log('sentence.png 업로드 실패:', e.message);
  // }

  // 📸 이미지 업로드 (맨 위 - 생성된 썸네일 사용)
  try {
    // 파일 선택창 대기
    const fileChooserPromise = page.waitForEvent('filechooser');

    // '사진' 버튼 클릭 (상단 툴바의 첫 번째 버튼인 경우가 많음, 클래스로 시도)
    // se-image-toolbar-button 클래스가 일반적임. 실패 시 예외처리.
    await frame.click('button.se-image-toolbar-button');

    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(thumbnailPath);

    await frame.waitForTimeout(2000); // 업로드 대기

    // 🗑️ 썸네일 파일 삭제
    try {
      const fs = require('fs');
      if (fs.existsSync(thumbnailPath)) {
        fs.unlinkSync(thumbnailPath);
      }
    } catch (delErr) {
      console.log('썸네일 삭제 실패:', delErr.message);
    }
  } catch (e) {
    console.log('이미지 업로드 실패 (버튼을 못 찾았거나 파일 문제):', e.message);
  }

  let count = 0;
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

    if (count === 0 || count === 1) {
      // await insertLinkAndRemoveUrl(frame, page, contentSpanSelector, await getAdItemLink());
      // await frame.waitForTimeout(2000);
    }

    // 소제목/내용 사이 구분을 위해 한 줄 띄움
    await frame.waitForTimeout(100);
    count++;
  }

  // 링크 카드 삽입 (하단)
  // await insertLinkAndRemoveUrl(frame, page, contentSpanSelector, await getAdItemLink());
  // await frame.waitForTimeout(2000);

  // 해시태그 입력 (본문 맨 끝)
  if (hashTag && hashTag.length > 0) {
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await frame.type(contentSpanSelector, hashTag.join(' '), { delay: 80 });
    await page.keyboard.press('Enter');
  }

  // 📸 캐릭터 이미지 업로드 및 대표 이미지 설정
  try {
    const path = require('path');
    const charImagePath = path.resolve(`image/${blogName}/${new Date().getDay()}.png`);

    // 파일 선택창 대기
    const fileChooserPromise = page.waitForEvent('filechooser');

    // '사진' 버튼 클릭 (상단 툴바)
    await frame.click('button.se-image-toolbar-button');

    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(charImagePath);

    await frame.waitForTimeout(3000); // 업로드 대기

    // 업로드된 이미지 선택 (첫 번째 이미지 - 썸네일)
    // se-image-container 또는 se-module-image 클래스를 가진 요소 중 첫 번째 것
    const images = await frame.$$('.se-module-image');
    if (images.length > 0) {
      const firstImage = images[0];
      await firstImage.click();
      await frame.waitForTimeout(1000);

      // 대표 이미지 버튼 클릭
      // 툴바가 뜨면 '대표' 버튼을 찾음
      const repBtnSelector = 'button.se-toolbar-option-visible-representative-button';
      const repBtn = await frame.$(repBtnSelector);

      if (repBtn) {
        await repBtn.click();

      } else {
        // 클래스로 못 찾으면 텍스트로 시도
        const buttons = await frame.$$('button');
        for (const btn of buttons) {
          const text = await btn.textContent();
          if (text && text.includes('대표')) {
            await btn.click();

            break;
          }
        }
      }
    }
  } catch (e) {
    console.log('캐릭터 이미지 업로드 또는 대표 설정 실패:', e.message);
  }

  // 발행 세팅
  // 1. 발행 버튼 클릭 (frame context)
  const publishBtnSelector =
    'div.header__Ceaap > div > div.publish_btn_area__KjA2i > div:nth-child(2) > button';
  await frame.waitForSelector(publishBtnSelector, { timeout: 10000 });
  await frame.click(publishBtnSelector);

  // 2. 예약 설정
  // #radio_time2 대신 '예약' 텍스트가 있는 라벨이나 버튼을 찾아서 클릭
  try {
    const reservationLabel = frame.locator('label', { hasText: '예약' }).last();
    await reservationLabel.click();
  } catch (e) {
    // 실패 시 기존 ID 방식 시도
    await frame.click('#radio_time2');
  }
  await frame.waitForTimeout(500); // UI 반영 대기



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
    sisa: '시사',
    spo: '스포츠',
    ent: '연예',
    pol: '정치',
    eco: '경제',
    soc: '사회',
    int: '세계',
    its: 'IT/과학',
  };
  const categoryName = typeMap[type] || type;
  await frame.click('button[aria-label="카테고리 목록 버튼"]');
  await frame.click(
    `span[data-testid^="categoryItemText_"]:text("${categoryName}")`
  );

  // 발행버튼 클릭
  const finalPublishBtnSelector = 'div.layer_btn_area__UzyKH > div > button';
  await frame.waitForSelector(finalPublishBtnSelector, { timeout: 10000 });
  await frame.click(finalPublishBtnSelector);
}

// ==========================
// 🔵 실행 부분
// ==========================
(async () => {
  // 외부 time_check.json에서 created 시간 읽기
  // await checkExecutionTime('m3_time_check.json', 2);

  //시작
  const browser = await chromium.launch({
    headless: !SHOW_BROWSER,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  // 팝업/알림창 자동 수락 (페이지 이동 시 '저장하지 않고 나가시겠습니까?' 등 방지)
  page.on('dialog', async dialog => {
    await dialog.accept();
  });
  logWithTime('시작');
  await naverLogin(page, process.env.NAVER_ID_M3, process.env.NAVER_PW_M3);
  logWithTime('로그인 완료');
  // nate.json에서 로커엘 있는거 데이터 읽기
  const fs = require('fs');
  const newsList = JSON.parse(fs.readFileSync('./data/m3_data.json', 'utf-8'));

  // 외부 URL에서 newsList 데이터 가져오기 (github raw)
  // const NEWS_JSON_URL = 'https://raw.githubusercontent.com/ggpt6choi-coder/blogman/main/data/m3_data.json';
  // const response = await _fetch(NEWS_JSON_URL);
  // const newsList = await response.json();

  let errCount = 0;
  for (let i = 0; i < newsList.length; i++) {
    const news = newsList[i];
    if (news.newTitle == null || news.newArticle == null || news.newArticle.length == 0 || news.newTitle === '[변환 실패]' || news.newArticle === '[변환 실패]')
      continue;

    const blogData = {
      page,
      blogName: process.env.BLOG_NAME_M3,
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
      if (!fs.existsSync('error-log')) {
        fs.mkdirSync('error-log', { recursive: true });
      }
      fs.appendFileSync('error-log/naver-upload-error.log', errorLog, 'utf-8');
    }
    // 필요시 대기시간 추가 가능 (예: await page.waitForTimeout(1000);)
  }
  logWithTime(
    `🍀모든 글 작성 완료 (실패 건수: ${errCount} / ${newsList.length})`
  );
  await browser.close();
})();
