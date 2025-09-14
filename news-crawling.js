require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { chromium } = require('playwright');
const fs = require('fs');
const { logWithTime } = require('./common');
const { log } = require('console');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const scList = ['sisa', 'spo', 'ent', 'pol', 'eco', 'soc', 'int', 'its'];
  const newsArr = [];
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });

  logWithTime('크롤링 시작', '⏰');
  for (const sc of scList) {
    const page = await browser.newPage();
    const url = `https://news.nate.com/rank/interest?sc=${sc}`;
    await page.goto(url);
    const links = await page.$$eval('.mlt01 a', (as) => as.map((a) => a.href));
    for (const link of links) {
      const newPage = await browser.newPage();
      await newPage.goto(link);
      // #articleView > h1 값 가져오기
      let title = '';
      try {
        await newPage.waitForSelector('#articleView > h1', { timeout: 5000 });
        title = await newPage.$eval('#articleView > h1', (el) =>
          el.textContent.trim()
        );
      } catch (e) {
        title = '[제목 없음]';
        try {
          await newPage.waitForSelector('#cntArea > h1', { timeout: 5000 });
          title = await newPage.$eval('#cntArea > h1', (el) =>
            el.textContent.trim()
          );
        } catch (e) {
          console.log(`title = '[제목 없음]'`);
        }
      }
      // #realArtcContents 전체에서 태그 제거 후 본문만 추출
      let article = '';
      try {
        await newPage.waitForSelector('#realArtcContents', { timeout: 5000 });
        const html = await newPage.$eval(
          '#realArtcContents',
          (el) => el.innerHTML
        );
        article = html
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
      } catch (e) {
        article = '[본문 없음]';
        try {
          await newPage.waitForSelector('#articleContetns', { timeout: 5000 });
          const html = await newPage.$eval(
            '#articleContetns',
            (el) => el.innerHTML
          );
          article = html
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        } catch (e) {
          console.log(`article = '[본문 없음]'`);
        }
      }
      // Gemini API로 제목 변환
      let newTitle = '';
      if (title !== '[제목 없음]') {
        try {
          const prompt = `다음 뉴스 제목을 네이버 블로그 검색엔진에 최적화된 자연스러운 제목으로 바꿔줘.
          - 광고, 논란, 부정적 뉘앙스는 피하고 정보 전달에 집중해.
          - 기사 내용을 참고해.
          - 기사 내용: ${article}
          - 원본 제목: ${title}
          답변은 바로 복사해 쓸 수 있게 변경된 제목만 알려줘. 다른 말은 필요 없어.
          변경:`;
          const result = await model.generateContent(prompt);
          const raw = result.response.text();
          newTitle = raw.trim();
          if (!newTitle) newTitle = '[빈 응답]';
          // Gemini API 호출 후 2초 대기
          await new Promise((res) => setTimeout(res, 2000));
        } catch (e) {
          newTitle = '[변환 실패]';
          console.log(`newTitle = '[변환 실패]'`);
          // Gemini API 오류 로그 파일에 에러 내용 기록
          const errorLog = `[${new Date().toISOString()}] [Gemini newTitle 변환 실패] title: ${title}\nError: ${
            e && e.stack ? e.stack : e
          }\n`;
          fs.appendFileSync('error-log/gemini-error.log', errorLog, 'utf-8');
        }
      } else {
        newTitle = '[제목 없음]';
        console.log(`title parsing에 실패해서 newTitle = '[제목 없음]'`);
      }
      // Gemini API로 본문 재가공 및 해시태그 생성
      let newArticle = '';
      if (article !== '[본문 없음]' && article.length.trim() !== 0) {
        try {
          const prompt = `다음 뉴스 본문을 네이버 블로그 검색 엔진에 최적화된 본문으로 재가공해줘. 조건은 아래와 같아.\n\n
            - 기사 내용과 직접 관련 없는 광고, 무관한 뉴스, 스크립트 코드는 모두 제거해줘.\n\n
            - 불필요한 반복, 기자 서명, 매체명은 삭제하고 핵심 정보만 남겨줘.\n\n
            - 단어나 문장을 다른 말로 바꿀 때는 positive 단어와 negative 단어를 서로 치환하지 말아줘.\n\n
            - 문장은 블로그 독자가 읽기 편하도록 자연스럽게 요약·재구성해줘.\n\n
            - 중립적이면서도 맥락을 이해할 수 있는 해설을 곁들여줘.\n\n
            - 글자 수는 띄어쓰기 포함하여 1000자 이상 2000자 미만으로 맞춰줘.\n\n
            - 소제목(h2, h3)을 달아 가독성을 높이고, 소제목 단위로 문단을 나눠서 작성해줘. 소제목 앞에는 "✅" 기호를 붙여줘. 그리고 작성시에 '#', '**' 같은 마크다운 표시는 사용하지 말아줘.\n\n
            - 맨 처음에는 너의 중립적인 생각을 짧게 말해주고, 한 문단 띄운 뒤 "무슨 내용인지 보러 가시죠!"와 같은 느낌의 문장을 넣어줘.\n\n
            - 답변은 불필요한 설명 없이 바로 전체 복사해 블로그에 쓸 수 있는 형태로 작성해줘.\n\n
            - 원본: ${article}\n\n변경:`;
          const result = await model.generateContent(prompt);
          newArticle = result.response.text().trim();
          // Gemini API 호출 후 2초 대기
          await new Promise((res) => setTimeout(res, 2000));
        } catch (e) {
          newArticle = '[변환 실패]';
          console.log(`newArticle = '[변환 실패]'`);
          // Gemini API 본문 변환 오류 로그 파일에 에러 내용 기록
          const errorLog = `[${new Date().toISOString()}] [Gemini newArticle 변환 실패] title: ${title}\nError: ${
            e && e.stack ? e.stack : e
          }\n`;
          fs.appendFileSync('error-log/gemini-error.log', errorLog, 'utf-8');
        }
      } else {
        newArticle = '[본문 없음]';
        console.log(`article parsing에 실패해서 newArticle = '[본문 없음]'`);
      }
      // 이미지 URL 수집
      let images = [];
      try {
        images = await newPage.$$eval('#realArtcContents img', (imgs) =>
          imgs.map((img) => img.src)
        );
      } catch (e) {
        images = [];
      }
      // 해시태그 생성
      let hashTag = '';
      if (article !== '[본문 없음]' && article.length.trim() !== 0) {
        try {
          const prompt = `다음 뉴스 본문을 기반으로 네이버 검색 알고리즘에 최적화된 해시태그 5개이상 10개미만 만들어줘.\n\n
            - '#해시태그1 #해시태그2 #해시태그3' 형태로 만들어줘.\n\n
            - 답변은 내가 요청한 형태로만 대답해줘. 바로 복사해서 사용할꺼니까\n\n
            기사: ${article}\n\n:`;
          const result = await model.generateContent(prompt);
          hashTag = result.response.text().trim().split(/\s+/);
          // Gemini API 호출 후 2초 대기
          await new Promise((res) => setTimeout(res, 2000));
          if (
            hashTag.includes('본문') ||
            hashTag.includes('#해시태그2') ||
            hashTag.includes('알고리즘') ||
            hashTag.includes('최적') ||
            hashTag.includes('드리겠습니다.')
          ) {
            hashTag = [];
          }
        } catch (e) {
          hashTag = [];
          console.log(`hashTag = '[생성 실패]'`);
          // Gemini API 본문 변환 오류 로그 파일에 에러 내용 기록
          const errorLog = `[${new Date().toISOString()}] [Gemini newArticle 변환 실패] title: ${title}\nError: ${
            e && e.stack ? e.stack : e
          }\n`;
          fs.appendFileSync('error-log/gemini-error.log', errorLog, 'utf-8');
        }
      }
      // 모든 결과 저장 (실패/빈 값 포함)

      if (
        newArticle !== '[본문 없음]' &&
        newTitle !== '[제목 없음]' &&
        newArticle !== '[변환 실패]' &&
        newTitle !== '[변환 실패]'
      ) {
        newsArr.push({
          type: sc,
          title,
          newTitle,
          article,
          newArticle,
          url: link,
          images,
          hashTag,
        });
      }
      await newPage.close();
    }
    await page.close();
  }
  // data 디렉터리 없으면 자동 생성
  const dirPath = 'data';
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
    logWithTime('data 디렉터리 생성됨');
  }
  fs.writeFileSync(
    `${dirPath}/news.json`,
    JSON.stringify(newsArr, null, 2),
    'utf-8'
  );
  logWithTime(`뉴스 데이터 저장 완료: ${newsArr.length}`);
  await browser.close();
})();
