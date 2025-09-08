require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { chromium } = require('playwright');
const fs = require('fs');
const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');
const { logWithTime } = require('./common');
const { exec } = require('child_process');

// RSS 링크와 타입 매핑
const typeMap = {
  'https://www.mk.co.kr/rss/30100041/': 'economy',
  'https://www.mk.co.kr/rss/50400012/': 'society',
  'https://www.mk.co.kr/rss/50100032/': 'company',
  'https://www.mk.co.kr/rss/30000023/': 'culture',
  'https://www.mk.co.kr/rss/30200030/': 'politics',
  'https://www.mk.co.kr/rss/30300018/': 'world',
  'https://www.mk.co.kr/rss/50200011/': 'stock',
  'https://www.mk.co.kr/rss/50300009/': 'estate',
  'https://www.mk.co.kr/rss/71000001/': 'sports',
  'https://www.mk.co.kr/rss/50700001/': 'game',
};

function isWithinLastHour(pubDateStr) {
  const pubDate = new Date(pubDateStr);
  const now = new Date();
  const diffMs = now.getTime() - pubDate.getTime();
  return diffMs >= 0 && diffMs <= 3600000;
}

async function fetchAndExtractXML(url) {
  const res = await axios.get(url, { responseType: 'text' });
  const parser = new XMLParser();
  const json = parser.parse(res.data);
  const items = json.rss.channel.item.filter((item) =>
    isWithinLastHour(item.pubDate)
  );
  return items;
}

(async () => {
  const links = [
    'https://www.mk.co.kr/rss/30100041/', // 경제
    'https://www.mk.co.kr/rss/50400012/', // 사회
    'https://www.mk.co.kr/rss/50100032/', // 기업·경영
    'https://www.mk.co.kr/rss/30000023/', // 문화·연예
    'https://www.mk.co.kr/rss/30200030/', // 정치
    'https://www.mk.co.kr/rss/30300018/', // 국제
    'https://www.mk.co.kr/rss/50200011/', // 증권
    'https://www.mk.co.kr/rss/50300009/', // 부동산
    'https://www.mk.co.kr/rss/71000001/', // 스포츠
    'https://www.mk.co.kr/rss/50700001/', // 게임
  ];

  const browser = await chromium.launch({ headless: true });
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });

  let typeLink = '';
  const newsArr = [];
  for (const link of links) {
    typeLink = link;
    const items = await fetchAndExtractXML(link);
    logWithTime(`[${typeMap[typeLink]}]기사 ${items.length}건 수집 시작`);

    for (const item of items) {
      const page = await browser.newPage();
      let navigationSuccess = false;
      try {
        await page.goto(item.link, {
          waitUntil: 'domcontentloaded',
          timeout: 15000,
        });
        navigationSuccess = true;
      } catch (e) {
        logWithTime(
          `[${item.category}] link = ${item.link}, 페이지 이동 실패: ${e.message}`
        );
      }

      let title = item.title || '[제목 없음]';
      let article = '';
      if (navigationSuccess) {
        try {
          const articleHtmlTag = 'div.news_cnt_detail_wrap';
          await page.waitForSelector(articleHtmlTag, { timeout: 5000 });
          const paragraphs = await page.$$eval(`${articleHtmlTag} > p`, (ps) =>
            ps.map((p) => p.innerText.trim()).filter(Boolean)
          );
          article = paragraphs.join('\n\n');
        } catch (e) {
          article = '[본문 없음]';
        }
      } else {
        article = '[본문 없음]';
      }

      // 본문 조회 못하면 진행하지마
      if (article === '[본문 없음]') continue;

      let newTitle = '';
      if (title !== '[제목 없음]') {
        try {
          const prompt = `다음 뉴스 제목을 네이버 블로그 검색엔진에 최적화된 자연스러운 제목으로 바꿔줘.\n- 광고, 논란, 부정적 뉘앙스는 피하고 정보 전달에 집중해.\n- 기사 내용을 참고해.\n- 기사 내용: ${article}\n- 원본 제목: ${title}\n답변은 바로 복사해 쓸 수 있게 변경된 제목만 알려줘. 다른 말은 필요 없어.\n변경:`;
          const result = await model.generateContent(prompt);
          const raw = result.response.text();
          newTitle = raw.trim();
          if (!newTitle) newTitle = '[빈 응답]';
          await new Promise((res) => setTimeout(res, 5000));
        } catch (e) {
          newTitle = '[변환 실패]';
          const errorLog = `[${new Date().toISOString()}] [Gemini newTitle 변환 실패] title: ${title}\nError: ${
            e && e.stack ? e.stack : e
          }\n`;
          fs.appendFileSync('error-log/gemini-mk-error.log', errorLog, 'utf-8');
        }
      } else {
        newTitle = '[제목 없음]';
      }

      let newArticle = '';
      if (article !== '[본문 없음]') {
        try {
          const prompt = `다음 뉴스 본문을 네이버 블로그 검색 엔진에 최적화된 본문으로 재가공해줘. 조건은 아래와 같아.\n\n- 기사 내용과 직접 관련 없는 광고, 무관한 뉴스, 스크립트 코드는 모두 제거해줘.\n\n- 불필요한 반복, 기자 서명, 매체명은 삭제하고 핵심 정보만 남겨줘.\n\n- 단어나 문장을 다른 말로 바꿀 때는 positive 단어와 negative 단어를 서로 치환하지 말아줘.\n\n- 문장은 블로그 독자가 읽기 편하도록 자연스럽게 요약·재구성해줘.\n\n- 중립적이면서도 맥락을 이해할 수 있는 해설을 곁들여줘.\n\n- 글자 수는 띄어쓰기 포함하여 1000자 이상 2000자 미만으로 맞춰줘.\n\n- 소제목(h2, h3)을 달아 가독성을 높이고, 소제목 단위로 문단을 나눠서 작성해줘. 소제목 앞에는 "✅" 기호를 붙여줘. 그리고 작성시에 '#', '**' 같은 마크다운 표시는 사용하지 말아줘.\n\n- 맨 처음에는 너의 중립적인 생각을 짧게 말해주고, 한 문단 띄운 뒤 "무슨 내용인지 보러 가시죠!"와 같은 느낌의 문장을 넣어줘.\n\n- 답변은 불필요한 설명 없이 바로 전체 복사해 블로그에 쓸 수 있는 형태로 작성해줘.\n\n- 원본: ${article}\n\n변경:`;
          const result = await model.generateContent(prompt);
          newArticle = result.response.text().trim();
          await new Promise((res) => setTimeout(res, 5000));
        } catch (e) {
          newArticle = '[변환 실패]';
          const errorLog = `[${new Date().toISOString()}] [Gemini newArticle 변환 실패] title: ${title}\nError: ${
            e && e.stack ? e.stack : e
          }\n`;
          fs.appendFileSync('error-log/gemini-mk-error.log', errorLog, 'utf-8');
        }
      } else {
        newArticle = '[본문 없음]';
      }

      let hashTag = '';
      if (article !== '[본문 없음]') {
        try {
          const prompt = `다음 뉴스 본문을 기반으로 네이버 검색 알고리즘에 최적화된 해시태그 5개이상 10개미만 만들어줘.\n\n- '#해시태그1 #해시태그2 #해시태그3' 형태로 만들어줘.\n\n- 답변은 내가 요청한 형태로만 대답해줘. 바로 복사해서 사용할꺼니까\n\n기사: ${article}\n\n:`;
          const result = await model.generateContent(prompt);
          hashTag = result.response.text().trim().split(/\s+/);
          await new Promise((res) => setTimeout(res, 5000));
          if (
            hashTag.includes('본문') ||
            hashTag.includes('#해시태그2') ||
            hashTag.includes('드리겠습니다.')
          ) {
            hashTag = [];
          }
        } catch (e) {
          hashTag = [];
          const errorLog = `[${new Date().toISOString()}] [Gemini newArticle 변환 실패] title: ${title}\nError: ${
            e && e.stack ? e.stack : e
          }\n`;
          fs.appendFileSync('error-log/gemini-mk-error.log', errorLog, 'utf-8');
        }
      }

      if (
        newArticle !== '[본문 없음]' &&
        newTitle !== '[제목 없음]' &&
        newArticle !== '[변환 실패]' &&
        newTitle !== '[변환 실패]'
      ) {
        newsArr.push({
          type:
            item.category === '기업/경영'
              ? '기업'
              : item.category === '문화/연예'
              ? '문화'
              : item.category,
          title: item.title,
          newTitle,
          article,
          newArticle,
          url: item.link,
          hashTag,
        });
      }

      await page.close();
      break;
    }

    // data 디렉터리 없으면 자동 생성
    // const typeName = typeMap[typeLink] || 'unknown';
    // const dirPath = 'data';
    // if (!fs.existsSync(dirPath)) {
    //   fs.mkdirSync(dirPath, { recursive: true });
    //   logWithTime('data 디렉터리 생성됨');
    // }
    // fs.writeFileSync(
    //   `${dirPath}/mk-news-${typeName}.json`,
    //   JSON.stringify(newsArr, null, 2),
    //   'utf-8'
    // );
    // logWithTime(`[${typeName}]뉴스 데이터 저장 완료: ${newsArr.length}`);

    // 크롤링 끝난 후 건수가 있으면 네이버 포스팅 자동화 실행
    // if (newsArr.length !== 0) {
    //   exec(
    //     `node naver-realtime-login.js ${typeName}`,
    //     (err, stdout, stderr) => {
    //       if (err) {
    //         logWithTime('네이버 포스팅 자동화 실패:', err);
    //       }
    //     }
    //   );
    // }
  }

  const typeName = typeMap[typeLink] || 'unknown';
  const dirPath = 'data';
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
    logWithTime('data 디렉터리 생성됨');
  }
  fs.writeFileSync(
    `${dirPath}/mk-news.json`,
    JSON.stringify(newsArr, null, 2),
    'utf-8'
  );
  logWithTime(`[${typeName}]뉴스 데이터 저장 완료: ${newsArr.length}`);

  await browser.close();
})();
