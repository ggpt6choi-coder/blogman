require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { chromium } = require('playwright');
const fs = require('fs');
const { logWithTime } = require('./common');

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
    const scList = ['sisa', 'spo', 'ent', 'pol', 'eco', 'soc', 'int', 'its'];
    // const scList = ['sisa'];
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
        for (const link of links) {
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
                    다음 뉴스 기사를 바탕으로 이웃들에게 정보를 공유하는 블로그 포스팅 데이터를 생성해줘.
                    
                    결과는 반드시 아래의 JSON 포맷으로만 출력해줘. 다른 말은 절대 하지 마.

                    {
                        "newTitle": "블로그용 제목",
                        "newArticle": [
                            {"title": "소제목1", "content": "내용1"},
                            {"title": "소제목2", "content": "내용2"}
                        ],
                        "hashTag": ["#태그1", "#태그2", ...]
                    }

                    [작성 톤앤매너 - 중요!]
                    - 말투: "~다.", "~함." 같은 딱딱한 문어체나 뉴스 말투 절대 금지.
                    - "~해요", "~했거든요", "~더라고요", "~인가 봐요" 같은 부드러운 '해요체' 구어체 사용.
                    - 감정 표현: "정말 놀랐어요", "다들 공감하시죠?", "큰일 날 뻔했네요" 같은 추임새를 자연스럽게 섞을 것.
                    - 독자 설정: 친한 친구나 이웃에게 이야기하듯이 작성.

                    [작성 조건]
                    1. newTitle (제목):
                        - 네이버 블로그 검색 최적화된 제목 (25~35자)
                        - 클릭을 유도하되 낚시성이 아닌 호기심 자극형
                        - 특수문자 제거, 뉴스 제목 그대로 사용 금지
                        - 예시: "매일 신는 양말, 하루 더 신었다가 충격받은 이유 (발 건강 관리 꿀팁)"

                    2. newArticle (본문):
                        - 총 4~6개의 문단으로 구성 (전체 1500자 이상)
                        - 각 소제목(title)은 핵심 키워드 포함 15자 이내의 흥미로운 문장형 (예: "양말 속 세균이 이렇게 많다고?")
                        - 각 내용(content)은 줄바꿈 없이 자연스럽게 이어지는 300~500자의 줄글
                        
                        * 첫 번째 문단(content): 기사 요약이 아닌, 이 주제와 관련된 가벼운 실수담이나 질문으로 시작할 것. (예: "어제 귀찮아서 그냥 잤는데...")
                        * 중간 문단들(content): 기사 정보를 전달하되, 어려운 용어는 쉽게 풀어서 설명하고 독자의 공감을 유도할 것.
                        * 마지막 문단(title: '솔직한 후기'): '개인적인 생각'이라는 제목 대신 '솔직한 후기', '주관적인 생각' 등으로 하고, 기사 내용을 요약하지 말 것. 대신 "앞으로 이렇게 해야겠다", "저도 예전에 이런 적이 있었는데 고생했다"는 식의 '가상의 경험'이나 '다짐'을 1인칭 시점으로 구체적으로 작성.

                        - 기사와 관련 없는 광고, 기자 정보, 언론사 명칭 등은 완벽히 제거
                        - 마크업, 리스트 기호 사용 금지 (오직 텍스트만)

                    3. hashTag (해시태그):
                        - 본문 내용과 밀접한 연관이 있는 감성적인 태그 포함 5~8개
                        - 예: #생활꿀팁 #솔직후기 #건강관리 등

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