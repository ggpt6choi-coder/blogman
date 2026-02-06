require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { chromium } = require('playwright');
const fs = require('fs');
const { logWithTime, parseGeminiResponse } = require('./common');

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

(async () => {
    if (!process.env.GEMINI_API_KEY_WOW) {
        logWithTime('GEMINI_API_KEY_WOW is missing in .env');
        process.exit(1);
    }
    const browser = await chromium.launch({ headless: true });
    // const scList = ['sisa', 'spo', 'ent', 'pol', 'eco', 'soc', 'int', 'its'];
    const scList = ['sisa'];
    const newsArr = [];
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY_WOW);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });
    // 테스트 목적: User-Agent에 서비스명/이메일 포함
    const userAgent = 'MyCrawler/1.0 (contact: your@email.com)';

    // 요청 간 5~15초 랜덤 지연 함수
    const delay = (ms) => new Promise(res => setTimeout(res, ms));

    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    const dateStr = `${yyyy}${mm}${dd}`;

    logWithTime('크롤링 시작', '⏰');
    let stopCrawling = false;
    for (const sc of scList) {
        if (stopCrawling) break;
        const page = await browser.newPage();
        await page.setExtraHTTPHeaders({ 'User-Agent': userAgent });
        // 광고/트래킹/이미지 등 불필요한 리소스 요청 차단
        await page.route('**/*', (route) => {
            const url = route.request().url();
            if (
                url.includes('ads') ||
                url.includes('pubmatic') ||
                url.includes('opera.com/pub/sync') ||
                url.includes('idsync.rlcdn.com') ||
                url.includes('turn.com') ||
                url.match(/\\.(gif|jpg|png|svg)$/)
            ) {
                return route.abort();
            }
            route.continue();
        });
        // HTTP 상태, 응답 헤더, 차단 로그 기록
        page.on('response', async (response) => {
            const status = response.status();
            const url = response.url();
            const headers = response.headers();
            if (status >= 400) {
                fs.appendFileSync('crawl-log.txt', `[${new Date().toISOString()}] ${status} ${url} ${JSON.stringify(headers)}\n`);
            }
        });
        const url = `https://news.nate.com/rank/interest?sc=${sc}&p=day&date=${dateStr}`;
        await page.goto(url);
        const links = await page.$$eval('.mlt01 a', (as) => as.map((a) => a.href));
        let count = 0;
        for (const link of links) {
            if (count > 1) break;
            count++;
            if (stopCrawling) break;
            logWithTime(`Processing: ${link}`);
            const newPage = await browser.newPage();
            await newPage.setExtraHTTPHeaders({ 'User-Agent': userAgent });
            // 광고/트래킹/이미지 등 불필요한 리소스 요청 차단
            await newPage.route('**/*', (route) => {
                const url = route.request().url();
                if (
                    url.includes('ads') ||
                    url.includes('pubmatic') ||
                    url.includes('opera.com/pub/sync') ||
                    url.includes('idsync.rlcdn.com') ||
                    url.includes('turn.com') ||
                    url.match(/\\.(gif|jpg|png|svg)$/)
                ) {
                    return route.abort();
                }
                route.continue();
            });
            // HTTP 상태, 응답 헤더, 차단 로그 기록
            newPage.on('response', async (response) => {
                const status = response.status();
                const url = response.url();
                const headers = response.headers();
                if (status >= 400) {
                    fs.appendFileSync('crawl-log.txt', `[${new Date().toISOString()}] ${status} ${url} ${JSON.stringify(headers)}\n`);
                }
            });
            await newPage.goto(link, { timeout: 150000, waitUntil: 'domcontentloaded' });

            // 캡차 감지 시 즉시 중단
            if (await newPage.$('input[type="checkbox"][name*="captcha"], .g-recaptcha, iframe[src*="recaptcha"]')) {
                logWithTime('CAPTCHA 감지됨. 크롤링 중단하고 현재까지 데이터 저장.');
                stopCrawling = true;
                await newPage.close();
                break;
            }

            // 제목 크롤링
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
                    logWithTime(`title = '[제목 없음]' ${link}`);
                }
            }
            // 본문 크롤링
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
                    logWithTime(`article = '[본문 없음]' ${link} `);
                }
            }
            // Gemini API로 통합 가공 (제목, 본문, 해시태그)
            let newTitle = '';
            let newArticle = '';
            let hashTag = [];

            if (article !== '[본문 없음]' && article.length !== 0 && title !== '[제목 없음]') {
                try {
                    const prompt = `
          너는 네이버 블로그를 운영하는 친근하고 소통을 잘하는 '인기 블로거'야.
          주어진 뉴스 기사를 재료로 삼아, 이웃들이 궁금해할 만한 정보를 아주 상세하고 친절하게 풀어주는 포스팅 데이터를 생성해줘.

          결과는 반드시 아래의 JSON 포맷으로만 출력해줘. JSON 외에 다른 말은 절대 하지 마.

          {
              "newTitle": "블로그용 제목",
              "newArticle": [
                  {"title": "소제목1", "content": "내용1"},
                  {"title": "소제목2", "content": "내용2"},
                  {"title": "소제목3", "content": "내용3"},
                  {"title": "소제목4", "content": "내용4"},
                  {"title": "솔직한 후기", "content": "내용5"}
              ],
              "hashTag": ["#태그1", "#태그2", ...],
              "sourceCredit": "출처 표기 문구"
          }

          [핵심 전략 1: SEO 및 키워드 최적화]
          - 기사 내용에서 사람들이 가장 많이 검색할 법한 '메인 키워드' 1개를 스스로 추출해.
          - newTitle(제목): 메인 키워드가 반드시 문장의 '앞부분'에 오도록 배치할 것. (예: "양말 세균(키워드), 방치하면 큰일나요" O / "큰일나는 이유는 양말 세균(키워드) 때문" X)
          - 소제목: 5개의 소제목 중 최소 2개 이상에 메인 키워드를 포함시킬 것.
          - 본문 내용: 메인 키워드가 전체 글에서 5~8회 자연스럽게 반복되도록 작성할 것.

          [핵심 전략 2: 분량 확보 (글자 수 2,000자 목표)]
          - 절대로 기사를 단순히 요약하지 마. 기사는 '소재'일 뿐이야.
          - 기사 내용이 짧다면, 관련된 너의 '배경지식', '일반 상식', '구체적인 예시', '상황 설정'을 덧붙여서 내용을 풍성하게 불려야 해.
          - 한 문단(content)은 최소 400자 이상, 10~12문장으로 구성해서 호흡을 길게 가져가.

          [작성 톤앤매너]
          - 말투: "~다/함" 금지. "그거 아세요?", "~했거든요", "~더라고요", "~인가 봐요" 같은 100% 구어체(수다 떠는 말투) 사용.
          - 감정: "세상에..", "진짜 충격이죠?", "완전 꿀팁이네요" 같은 추임새 필수.
          - 독자: 친한 친구에게 카톡 보낸다고 생각하고 작성.

          [세부 작성 조건]
          1. newTitle: 
             - 25~32자 이내. 특수문자 제거. 호기심 자극형.

          2. newArticle (총 5개 섹션 필수):
             - 섹션 1 (도입부): 기사 요약 절대 금지. "오늘 뉴스 보셨나요?" 같은 질문이나, "어제 제가 겪은 일인데..." 같은 가상의 에피소드(Storytelling)로 시작. 독자의 공감을 얻고 체류시간을 늘리는 구간.
             - 섹션 2 (배경 설명): 이 뉴스가 왜 나왔는지, 어려운 용어가 있다면 초등학생도 알기 쉽게 풀어서 설명. (배경지식 활용하여 분량 늘리기)
             - 섹션 3 (핵심 정보): 기사의 핵심 내용을 전달하되, "예를 들어"를 사용하여 구체적인 상황을 묘사할 것.
             - 섹션 4 (적용/팁): 독자가 이 정보를 보고 당장 실천할 수 있는 꿀팁이나 행동 요령 제시.
             - 섹션 5 (title: '솔직한 후기'): 기사 요약 X. "앞으로 저는 이렇게 하려고요", "여러분도 꼭 챙기세요" 같은 주관적인 다짐과 1인칭 시점의 생각.

          3. hashTag: 
             - 본문 키워드와 연관된 태그 5~8개.

          4. sourceCredit:
             - "※ 본 포스팅은 [언론사명]의 기사 내용을 바탕으로 이해하기 쉽게 재구성하였습니다." (URL 제외, 텍스트만)

          [입력 데이터]
          - 원본 제목: ${title}
          - 기사 내용: ${article}
          `;

                    const result = await generateContentWithRetry(model, prompt);
                    const raw = result.response.text().trim();

                    const parsedData = parseGeminiResponse(raw);

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
                    fs.appendFileSync('error-log/gemini-error.log', errorLog, 'utf-8');
                }
            } else {
                newTitle = '[제목 없음]';
                newArticle = '[본문 없음]';
                hashTag = [];
                logWithTime(`Skipping Gemini: Missing title or article for ${link}`);
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
                    hashTag,
                });
            }
            await newPage.close();
            // 10 RPM 제한 준수를 위한 지연 (기사당 1회 호출하므로, 기사당 최소 6초 이상 소요되어야 함)
            // 기존 15~25초 -> 6~10초로 변경 (속도 최적화)
            await delay(6000 + Math.random() * 4000);
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
        `${dirPath}/nate.json`,
        JSON.stringify(newsArr, null, 2),
        'utf-8'
    );

    const now = new Date();
    const utc = now.getTime() + now.getTimezoneOffset() * 60000;
    const kst = new Date(utc + 9 * 60 * 60000);
    // KST 기준 시각을 구성
    const year = kst.getFullYear();
    const month = String(kst.getMonth() + 1).padStart(2, "0");
    const day = String(kst.getDate()).padStart(2, "0");
    const hours = String(kst.getHours()).padStart(2, "0");
    const minutes = String(kst.getMinutes()).padStart(2, "0");
    const seconds = String(kst.getSeconds()).padStart(2, "0");

    fs.writeFileSync(
        `${dirPath}/nate_time_check.json`,
        JSON.stringify({ created: `${year}-${month}-${day}T${hours}:${minutes}:${seconds}+09:00` }, null, 2),
        'utf-8'
    );
    logWithTime(`뉴스 데이터 저장 완료: ${newsArr.length}`);
    await browser.close();
})();