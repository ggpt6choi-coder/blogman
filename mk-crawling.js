require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { chromium } = require('playwright');
const fs = require('fs');
const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');
const { logWithTime, getKstIsoNow } = require('./common');
const { exec } = require('child_process');
const SHOW_BROWSER = false; // 실행 중 브라우저 창 표시 여부

// Gemini API 재시도 헬퍼 함수
async function generateContentWithRetry(model, prompt, retries = 3, delayMs = 2000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await model.generateContent(prompt);
    } catch (e) {
      // 503 Service Unavailable or other transient errors
      if (i === retries - 1) throw e;
      logWithTime(`Gemini API error (attempt ${i + 1}/${retries}): ${e.message}. Retrying...`);
      await new Promise(res => setTimeout(res, delayMs * (i + 1)));
    }
  }
}

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


  if (!process.env.GEMINI_API_KEY_FASTMAN) {
    logWithTime('GEMINI_API_KEY_FASTMAN is missing in .env');
    process.exit(1);
  }
  const browser = await chromium.launch({ headless: !SHOW_BROWSER });
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY_FASTMAN);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });

  let typeLink = '';
  const newsArr = [];
  for (const link of links) {
    typeLink = link;
    const items = await fetchAndExtractXML(link);
    logWithTime(`[${typeMap[typeLink]}]기사 ${items.length}건 수집 시작`);

    let count = 0;
    for (const item of items) {
      if (count > 2) break;
      count++;
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

      if (item.title.includes('증권') || item.title.includes('이벤트') || item.title.includes('혜택') || item.title.includes('주식') || item.title.includes('선착순')) {
        await page.close();
        continue;
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
          const prompt = `다음 뉴스 제목을 네이버 블로그 검색 최적화된 제목으로 바꿔줘.\n                        
                            - 광고, 논란, 자극적 표현은 피할 것.\n                        
                            - 따옴표(\" '\), 대괄호([ ]), 특수문자(→, …, ★ 등)는 모두 제거할 것.\n           
                            - 뉴스 핵심 키워드를 포함해 자연스러운 설명형 문장으로 만들 것.\n
                            - 제목 길이는 30~45자로 조정할 것.\n
                            - 기사 내용을 참고해.\n
                            - 기사 내용: ${article}\n
                            - 원본 제목: ${title}\n
                            답변은 바로 복사해 쓸 수 있도록 제목만 알려줘. 다른 말은 필요 없어.\n
                            변경:\n`;
          const result = await generateContentWithRetry(model, prompt);
          const raw = result.response.text();
          newTitle = raw.trim();
          if (!newTitle) newTitle = '[빈 응답]';
          await new Promise((res) => setTimeout(res, 5000));
        } catch (e) {
          newTitle = '[변환 실패]';
          const errorLog = `[${new Date().toISOString()}] [Gemini newTitle 변환 실패] title: ${title}\nError: ${e && e.stack ? e.stack : e
            }\n`;
          if (!fs.existsSync('error-log')) {
            fs.mkdirSync('error-log', { recursive: true });
          }
          fs.appendFileSync('error-log/gemini-mk-error.log', errorLog, 'utf-8');
        }
      } else {
        newTitle = '[제목 없음]';
      }

      let newArticle = '';
      if (article !== '[본문 없음]' && article.length !== 0) {
        try {
          const prompt = `다음 뉴스 본문을 기반으로 네이버 블로그 검색 엔진에 최적화된 글을 작성해줘.\n
                          결과는 아래의 JSON 배열 형태로 만들어줘.\n
                          [
                          {"title": "소제목1", "content": "내용1"},
                          {"title": "소제목2", "content": "내용2"},
                          ...
                          ]
                          \n
                          작성 조건:
                          - 기사 내용을 핵심 주제별로 4~7개의 문단으로 나누어 구성할 것\n
                          - 각 소제목(title)은 핵심 키워드를 포함해 10자 이내로 작성 (예: ‘미국 금리 전망’, ‘테슬라 주가 급등’)\n
                          - 각 내용(content)은 300~700자 사이의 자연스러운 하나의 문단으로 작성 (줄바꿈, 리스트, 특수문자, 마크업 금지)\n
                          - 전체 글 분량은 약 1500자 이상이 되도록 구성\n
                          - 마지막 문단의 title은 반드시 '개인적인 생각'으로 하고, 기사 내용에 대한 견해와 시사점을 분석적으로 작성\n
                          - 모든 문장은 자연스럽게 연결되도록 하되, SEO(검색 최적화)를 위해 핵심 키워드가 문장 내에 자연스럽게 반복되게 작성\n
                          - 기사와 관련 없는 광고, 스크립트, 기자 서명, 매체명, 불필요한 문장은 모두 제거\n
                          - title은 소제목으로만, content에는 포함하지 말 것\n
                          - 답변은 반드시 위 JSON 배열 형식으로만 출력. 다른 설명이나 불필요한 텍스트는 절대 넣지 마\n
                          원본: ${article}
                          `;

          const result = await generateContentWithRetry(model, prompt);
          const raw = result.response.text().trim();
          try {
            newArticle = JSON.parse(raw);
          } catch (jsonErr) {
            const match = raw.match(/\[.*\]/s);
            if (match) {
              newArticle = JSON.parse(match[0]);
            } else {
              newArticle = '[변환 실패]';
              logWithTime('JSON parsing failed. Raw:', raw);
            }
          }
          await new Promise((res) => setTimeout(res, 2000));
        } catch (e) {
          newArticle = '[변환 실패]';
          logWithTime(`newArticle = '[변환 실패]'`);
          const errorLog = `[${new Date().toISOString()}] [Gemini newArticle 변환 실패] title: ${title}\nError: ${e && e.stack ? e.stack : e}\n`;
          if (!fs.existsSync('error-log')) {
            fs.mkdirSync('error-log', { recursive: true });
          }
          fs.appendFileSync('error-log/gemini-mk-error.log', errorLog, 'utf-8');
        }
      } else {
        newArticle = '[본문 없음]';
        logWithTime(`article parsing에 실패해서 newArticle = '[본문 없음]' ${link}`);
      }

      let hashTag = '';
      if (article !== '[본문 없음]' && article.length !== 0) {
        try {
          const prompt = `다음 뉴스 본문을 기반으로 네이버 검색 알고리즘에 최적화된 해시태그 5개이상 10개미만 만들어줘.\n\n- '#해시태그1 #해시태그2 #해시태그3' 형태로 만들어줘.\n\n- 답변은 내가 요청한 형태로만 대답해줘. 바로 복사해서 사용할꺼니까\n\n기사: ${article}\n\n:`;
          const result = await generateContentWithRetry(model, prompt);
          hashTag = result.response.text().trim().split(/\s+/);
          await new Promise((res) => setTimeout(res, 5000));
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
          const errorLog = `[${new Date().toISOString()}] [Gemini newArticle 변환 실패] title: ${title}\nError: ${e && e.stack ? e.stack : e
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
    }
  }

  //🌟🌟🌟🌟🌟 json 파일로 저장 
  logWithTime(`크롤링된 뉴스 기사 수: ${newsArr.length}`, '✅');

  const typeName = typeMap[typeLink] || 'unknown';
  const dirPath = 'data';
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
    logWithTime('data 디렉터리 생성됨');
  }
  // mk_data.json 저장
  fs.writeFileSync(`${dirPath}/mk_data.json`, JSON.stringify(newsArr, null, 2), 'utf-8');
  // mk_time_check.json 저장
  fs.writeFileSync(`${dirPath}/mk_time_check.json`, JSON.stringify({ created: `${getKstIsoNow()}` }, null, 2), 'utf-8');

  await browser.close();
})();
