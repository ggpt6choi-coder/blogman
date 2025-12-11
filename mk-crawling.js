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
  const delay = (ms) => new Promise(res => setTimeout(res, ms));
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

      // Gemini API로 통합 가공 (제목, 본문, 해시태그)
      let newTitle = '';
      let newArticle = '';
      let hashTag = [];

      if (article !== '[본문 없음]' && article.length !== 0 && title !== '[제목 없음]') {
        try {
          const prompt = `
          다음 뉴스 기사를 바탕으로 네이버 블로그 포스팅을 위한 데이터를 생성해줘.
          결과는 반드시 아래의 JSON 포맷으로만 출력해줘. 다른 말은 절대 하지 마.

          {
              "newTitle": "블로그용 제목",
              "newArticle": [
                  {"title": "소제목1", "content": "내용1"},
                  {"title": "소제목2", "content": "내용2"}
              ],
              "hashTag": ["#태그1", "#태그2", ...]
          }

          [작성 조건]
          1. newTitle (제목):
              - 네이버 블로그 검색 최적화된 제목 (30~45자)
              - 광고, 논란, 자극적 표현 제외
              - 따옴표, 대괄호, 특수문자 제거
              - 뉴스 핵심 키워드를 포함한 자연스러운 설명형 문장

          2. newArticle (본문):
              - 기사 내용을 핵심 주제별로 4~7개의 문단으로 나누어 구성
              - 각 소제목(title)은 핵심 키워드 포함 10자 이내
              - 각 내용(content)은 300~700자 사이의 자연스러운 하나의 문단 (줄바꿈, 리스트, 마크업 금지)
              - 전체 글 분량은 약 1500자 이상
              - 마지막 문단의 title은 반드시 '개인적인 생각'으로 하고, 기사 내용에 대한 견해와 시사점을 분석적으로 작성
              - SEO를 위해 핵심 키워드가 문장 내에 자연스럽게 반복되도록 작성
              - 기사와 관련 없는 광고, 기자 정보 등 제거

          3. hashTag (해시태그):
              - 네이버 검색 알고리즘에 최적화된 해시태그 5개 이상 10개 미만
              - '#태그명' 형태의 문자열 배열

          [입력 데이터]
          - 원본 제목: ${title}
          - 기사 내용: ${article}
          `;

          const result = await generateContentWithRetry(model, prompt);
          const raw = result.response.text().trim();

          let parsedData = null;
          try {
            // 1. Try parsing raw directly
            parsedData = JSON.parse(raw);
          } catch (jsonErr) {
            // 2. Try cleaning markdown code blocks
            let cleanRaw = raw.replace(/```json/g, '').replace(/```/g, '').trim();
            try {
              parsedData = JSON.parse(cleanRaw);
            } catch (e2) {
              // 3. Try extracting json object with regex
              const match = cleanRaw.match(/\{[\s\S]*\}/);
              if (match) {
                try {
                  parsedData = JSON.parse(match[0]);
                } catch (e3) {
                  console.log('JSON parsing failed even with regex match. Raw:', raw);
                }
              } else {
                console.log('JSON parsing failed. Raw:', raw);
              }
            }
          }

          if (parsedData) {
            newTitle = parsedData.newTitle || '[변환 실패]';
            newArticle = parsedData.newArticle || '[변환 실패]';
            hashTag = parsedData.hashTag || [];

            // 해시태그 유효성 검사 (기존 로직 유지)
            if (Array.isArray(hashTag)) {
              const invalidTags = ['본문', '#해시태그2', '알고리즘', '최적', '드리겠습니다.'];
              if (hashTag.some(tag => invalidTags.some(invalid => tag.includes(invalid)))) {
                hashTag = [];
              }
            } else {
              hashTag = [];
            }

          } else {
            newTitle = '[변환 실패]';
            newArticle = '[변환 실패]';
            hashTag = [];
            logWithTime(`JSON parsing failed completely for ${link}`);
          }

          await new Promise((res) => setTimeout(res, 2000));

        } catch (e) {
          newTitle = '[변환 실패]';
          newArticle = '[변환 실패]';
          hashTag = [];
          logWithTime(`Gemini processing failed for ${link}`);
          const errorLog = `[${new Date().toISOString()}] [Gemini 통합 변환 실패] title: ${title}\nError: ${e && e.stack ? e.stack : e}\n`;
          if (!fs.existsSync('error-log')) {
            fs.mkdirSync('error-log', { recursive: true });
          }
          fs.appendFileSync('error-log/gemini-mk-error.log', errorLog, 'utf-8');
        }
      } else {
        newTitle = '[제목 없음]';
        newArticle = '[본문 없음]';
        hashTag = [];
        logWithTime(`Skipping Gemini: Missing title or article for ${link}`);
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
      // 10 RPM 제한 준수를 위한 지연 (기사당 1회 호출하므로, 기사당 최소 6초 이상 소요되어야 함)
      await delay(6000 + Math.random() * 4000);
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
