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
    if (!process.env.GEMINI_API_KEY_REVIEW36524) {
        logWithTime('GEMINI_API_KEY_REVIEW36524 is missing in .env');
        process.exit(1);
    }
    const browser = await chromium.launch({ headless: true });
    const scList = ['sisa', 'spo', 'ent', 'eco', 'soc', 'int', 'its'];
    const newsArr = [];
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY_REVIEW36524);
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
        ;
        let count = 0;
        for (const link of links) {
            if (stopCrawling) break;
            if (count >= 2) break; // 최대 2개 뉴스만 처리
            count++;
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
                    너는 네이버 검색 로직(DIA+)이 가장 선호하는 '전문성과 통찰력을 갖춘 이슈 분석가'야.
                    주어진 뉴스 기사를 단순 전달하는 게 아니라, 그 이면에 숨겨진 의미와 앞으로 벌어질 일을 예측하여 독자가 "이 블로그는 진짜 전문가네!"라고 느끼게 만드는 포스팅 데이터를 생성해.

                    [필수 출력 포맷: JSON]
                    {
                        "searchKeywords": ["메인키워드", "서브키워드1", "서브키워드2"],
                        "newTitle": "메인키워드 포함 및 특수문자 없는 깔끔한 제목",
                        "newArticle": [
                            {
                                "title": "사건의 발단: 도대체 무슨 일이 일어났나?",
                                "content": "독자의 호기심을 자극하며 사건의 개요를 설명하는 도입부 (줄글 형태, 400자 이상)"
                            },
                            {
                                "title": "심층 분석: 왜 이 이슈가 터졌을까?",
                                "content": "단순 사실 나열이 아닌, 사건의 원인과 배경을 전문가적 시선으로 분석한 본문 (500자 이상)"
                            },
                            {
                                "title": "놓치면 안 될 디테일과 숨겨진 맥락",
                                "content": "기사에는 없는 배경지식이나 업계 상황, 연관된 과거 사례 등을 추가하여 풍성하게 작성 (500자 이상)"
                            },
                            {
                                "title": "향후 전망 및 시사점",
                                "content": "이 사건이 불러올 파장이나 나의 예측, 독자에게 던지는 묵직한 메시지 (400자 이상)"
                            }
                        ],
                        "hashTag": ["#태그1", "#태그2", "#태그3", "#태그4", "#태그5"]
                    }

                    [🚀 핵심 전략 1: 무조건 상위 노출되는 제목 법칙]
                    - 기사에서 검색량이 가장 많을 법한 **'메인 키워드'**를 하나 뽑아.
                    - **NewTitle(제목):** 무조건 **메인 키워드로 문장을 시작**해.
                    - **🚨 특수문자 절대 금지:** 마침표(.), 쉼표(,), 물음표(?), 느낌표(!), 따옴표("), 괄호([]), 하이픈(-) 등 **모든 기호를 쓰지 마.**
                    - **오직 한글, 영어, 숫자, 띄어쓰기**만 사용해서 깔끔한 평서문이나 명사형으로 끝내.
                    - (나쁜 예): "비트코인 폭락!! 그 이유는?" (X - 특수문자 사용)
                    - (좋은 예): "비트코인 폭락 원인과 향후 시장 전망 분석" (O - 깔끔함)
                    - 제목 길이는 20~28자 이내로 간결하게.

                    [🚀 핵심 전략 2: 검색 엔진이 사랑하는 본문 패턴]
                    - **키워드 밀도:** 메인 키워드를 전체 본문(content 합계)에서 **최소 6회 이상, 최대 9회 이하**로 자연스럽게 언급해.
                    - **분량 확보:** 전체 글자 수(공백 제외) **2,000자 이상**을 목표로 해. 
                    - **살 붙이기:** 기사 내용이 짧으면 너의 방대한 지식(배경, 역사, 유사 사례)을 총동원해서 내용을 불려. (절대 기사만 요약하지 마!)

                    [✍️ 작성 톤앤매너: '뇌섹남/뇌섹녀' 스타일]
                    - 1번 프롬프트가 '수다스러운 이웃'이라면, 너는 **'날카로운 분석가'**야.
                    - 말투: "~했거든요", "~더라고요" 같은 구어체를 쓰되, 너무 가볍지 않게. **"주목해야 할 점은~", "사실 이 문제의 본질은~", "결국 중요한 건~"** 같은 표현 사용.
                    - 감정: 무조건적인 공감보다는 **냉철한 비판**이나 **놀라움**, **의문 제기**를 섞어서 독자의 지적 호기심을 자극해.

                    [입력 데이터]
                    - 제목: ${title}
                    - 내용: ${article}
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
        `${dirPath}/review36524_nate.json`,
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
        `${dirPath}/review36524_nate_time_check.json`,
        JSON.stringify({ created: `${year}-${month}-${day}T${hours}:${minutes}:${seconds}+09:00` }, null, 2),
        'utf-8'
    );
    logWithTime(`뉴스 데이터 저장 완료: ${newsArr.length}`);
    await browser.close();
})();