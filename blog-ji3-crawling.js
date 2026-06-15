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
    if (!process.env.GEMINI_API_KEY_M3) {
        logWithTime('GEMINI_API_KEY_M3 is missing in .env');
        process.exit(1);
    }
    const browser = await chromium.launch({ headless: true });
    const scList = ['ent'];
    // const scList = ['sisa'];
    const newsArr = [];
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY_M3);
    const model = genAI.getGenerativeModel({
        model: 'gemini-2.5-flash',
        generationConfig: { responseMimeType: 'application/json' }
    });
    // 테스트 목적: User-Agent에 서비스명/이메일 포함
    const userAgent = 'MyCrawler/1.0 (contact: your@email.com)';

    // 요청 간 5~15초 랜덤 지연 함수
    const delay = (ms) => new Promise(res => setTimeout(res, ms));

    const now = new Date();
    const utc = now.getTime() + now.getTimezoneOffset() * 60000;
    const kst = new Date(utc + 9 * 60 * 60000);
    const yyyy = kst.getFullYear();
    const mm = String(kst.getMonth() + 1).padStart(2, '0');
    const dd = String(kst.getDate()).padStart(2, '0');
    const dateStr = `${yyyy}${mm}${dd}`;

    // data 디렉터리 없으면 자동 생성 (monitor 파일보다 먼저)
    if (!fs.existsSync('data')) {
        fs.mkdirSync('data', { recursive: true });
        logWithTime('data 디렉터리 생성됨');
    }

    // data/ji3_monitor.json 로드 (없으면 빈 배열로 초기화)
    const monitorPath = 'data/ji3_monitor.json';
    let crawledTitles = [];
    if (fs.existsSync(monitorPath)) {
        try {
            crawledTitles = JSON.parse(fs.readFileSync(monitorPath, 'utf-8'));
            if (!Array.isArray(crawledTitles)) crawledTitles = [];
        } catch (e) {
            logWithTime('blog-ji3-monitor.json 파싱 오류. 빈 배열로 초기화합니다.');
            crawledTitles = [];
        }
    }
    logWithTime(`모니터 파일 로드 완료: ${crawledTitles.length}개 제목 기록됨`);

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
                url.match(/\.(gif|jpg|png|svg)$/)
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
        await page.goto(url, { timeout: 60000, waitUntil: 'domcontentloaded' });
        const links = await page.$$eval('.mlt01 a', (as) => as.map((a) => a.href));
        let count = 0;
        for (const link of links) {
            if (count >= 2) break;
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
                    url.match(/\.(gif|jpg|png|svg)$/)
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

            // ✅ 중복 제목 체크: 이미 크롤링한 기사면 스킵
            if (title && title !== '[제목 없음]' && crawledTitles.includes(title)) {
                logWithTime(`[스킵] 이미 처리된 기사: "${title}"`);
                await newPage.close();
                continue;
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
                    너는 네이버 홈판(AiRS) 알고리즘에 최적화된 '공감형 이야기꾼 블로거'야.
                    주어진 뉴스 기사를 재료로, 독자가 피드에서 첫 줄을 보자마자 클릭하고 끝까지 읽고 싶어지는 블로그 포스팅을 작성해.
                    네이버 홈판은 **완독률, CTR(클릭률), 공감·저장 수**를 핵심 지표로 삼으니 이 세 가지를 극대화해.

                    [필수 출력 포맷: JSON]
                    - 결과값은 오직 JSON만 출력해. (앞뒤 잡담, Markdown 코드블록 절대 금지)
                    - content 내 줄바꿈은 '\\n'으로 이스케이프 처리해.
                    - **극단적 주의 (JSON 파싱 오류 원천 차단)**: newArticle의 content와 title 값 내부에서는 쌍따옴표/큰따옴표(")를 단 하나라도 사용하면 JSON 파싱이 무조건 깨집니다. 따라서 본문 내부의 인용 대사, 네티즌 반응, 댓글 등 모든 텍스트에서는 큰따옴표(")의 사용을 완전히 금지하고, 오직 작은따옴표(')만 사용하세요. 큰따옴표가 들어갈 자리는 반드시 작은따옴표로 대체해서 출력해야 합니다.

                    {
                        "newTitle": "공감·호기심을 자극하는 제목 (특수문자 제외, 30자 이내)",
                        "newArticle": [
                            {
                                "title": "섹션1 소제목 (아래 지침 참고)",
                                "content": "섹션1 본문"
                            },
                            {
                                "title": "섹션2 소제목",
                                "content": "섹션2 본문"
                            },
                            {
                                "title": "섹션3 소제목",
                                "content": "섹션3 본문"
                            },
                            {
                                "title": "섹션4 소제목",
                                "content": "섹션4 본문"
                            },
                            {
                                "title": "섹션5 소제목",
                                "content": "섹션5 본문"
                            }
                        ],
                        "hashTag": ["#태그1", "#태그2", "#태그3", "#태그4", "#태그5"]
                    }

                    [📌 소제목 작성 규칙 - 매우 중요]
                    - 소제목은 절대 고정된 문구("피드 훅: 멈추게 만드는 첫 이야기", "그래서 무슨 일이 있었냐면요" 등)를 반복하지 마.
                    - 매번 기사 내용·분위기에 맞게 완전히 새로운 소제목을 만들어.
                    - 각 섹션의 역할:
                      · 섹션1: 독자를 잡아당기는 감성 훅 + 이 글을 읽어야 할 이유 (500자 이상)
                      · 섹션2: 사건 전말을 생생하게 스토리텔링 (600자 이상)
                      · 섹션3: 대중 반응 + 블로거 솔직 감상 + 독자와 대화 (500자 이상)
                      · 섹션4: 독자 일상/감정과의 연결 고리 (500자 이상)
                      · 섹션5: 따뜻한 마무리 + 댓글·공감 유도 (300자 이상)
                    - 소제목 5개가 모두 다른 형태여야 해. 비슷한 구조 반복 금지.
                    - **매 기사마다 완전히 다른 소제목을 써줘.**

                    [🏠 홈판 노출 핵심 전략 1: 클릭을 부르는 제목]
                    - 메인 키워드를 제목 앞부분에 배치하되, **궁금증·공감·놀라움**을 자극하는 형태로 써.
                    - 좋은 예: "OOO 근황 이거 실화인가요", "OOO 이렇게 됐다는 거 다들 알고 계셨어요"
                    - 나쁜 예: "OOO 팩트체크 총정리" (검색용이라 홈판 CTR 낮음)
                    - **특수문자 절대 금지**: 오직 한글·영문·숫자·공백만 사용.

                    [🏠 홈판 노출 핵심 전략 2: 완독률을 높이는 글쓰기]
                    - **도입부 첫 2~3문장**이 피드 미리보기에 노출됨 → 이 부분이 가장 중요. 반드시 감성 훅으로 시작해.
                    - 전체 글자 수 **3,000자 이상** 목표. 단, 지루하지 않게 스토리 흐름을 유지해.
                    - 소제목은 딱딱한 명사형보다 **질문형·감탄형**으로 써서 계속 읽고 싶게 만들어.
                    - 문단 사이에 짧은 감탄·공감 문장("정말 대단하지 않나요?", "저도 이 부분에서 멈췄어요.")을 자연스럽게 삽입.

                    [🏠 홈판 노출 핵심 전략 3: 반응(공감·저장) 유도]
                    - 글 곳곳에 독자에게 말을 거는 문장 삽입: "여러분은 어떻게 생각하세요?", "공감되시면 좋아요 눌러주세요 😊"
                    - 마지막 섹션에서 반드시 한 번 이상 댓글·공감 유도 문구를 포함해.

                    [✍️ 톤앤매너: 친한 언니/오빠가 카톡으로 정보 알려주는 느낌]
                    - 말투: "~했거든요", "~더라고요", "~잖아요", "진짜요?", "완전 공감이에요" 등 구어체 위주.
                    - 감정 표현 적극 활용 (놀람, 안타까움, 응원, 웃음 등).
                    - 절대 합쇼체(~입니다, ~합니다)로만 쓰지 마. 딱딱해 보여서 홈판 이탈률 올라감.
                    - **매번 다른 감성·분위기·소제목으로 써줘. 이전 글과 똑같은 패턴 절대 금지.**

                    [📱 모바일 최적화 레이아웃 지침 - 매우 중요]
                    - 모바일 스마트폰 화면에서 글이 잘리고 어색해지는 것을 막기 위해 다음 지침을 반드시 따르세요.
                    - 전체 글을 **가운데 정렬(Center Alignment)** 해서 읽는다고 가정하고 문장을 구성하세요.
                    - **한 줄의 길이는 공백 포함 13자 ~ 18자 내외**로 아주 짧게 작성하세요. 스마트폰 가로 폭 안에서 줄이 자동으로 깨지지 않고 자연스럽게 전체 어절이 출력되도록 하기 위함입니다.
                    - 문장의 호흡과 어절 단위에 맞추어 의도적으로 **줄바꿈('\\n')**을 넣어 아래 줄로 내리세요.
                    - 네이버 에디터 특성상 '\\n'을 한 번만 입력해도 문단 구분을 위한 충분한 여백이 생기므로, 절대 '\\n\\n'을 사용하지 말고 오직 단일 '\\n'만 사용하여 줄바꿈을 처리하세요.

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
                // ✅ 성공한 기사 제목을 monitor 파일에 즉시 기록
                if (title && title !== '[제목 없음]' && !crawledTitles.includes(title)) {
                    crawledTitles.push(title);
                    fs.writeFileSync(monitorPath, JSON.stringify(crawledTitles, null, 2), 'utf-8');
                    logWithTime(`[모니터] 제목 기록: "${title}"`);
                }
            }
            await newPage.close();
            // 10 RPM 제한 준수를 위한 지연 (기사당 1회 호출하므로, 기사당 최소 6초 이상 소요되어야 함)
            // 기존 15~25초 -> 6~10초로 변경 (속도 최적화)
            await delay(6000 + Math.random() * 4000);
        }
        await page.close();
    }
    const dirPath = 'data';
    fs.writeFileSync(
        `${dirPath}/ji3_data.json`,
        JSON.stringify(newsArr, null, 2),
        'utf-8'
    );

    const endNow = new Date();
    const endUtc = endNow.getTime() + endNow.getTimezoneOffset() * 60000;
    const endKst = new Date(endUtc + 9 * 60 * 60000);
    // KST 기준 시각을 구성
    const year = endKst.getFullYear();
    const month = String(endKst.getMonth() + 1).padStart(2, "0");
    const day = String(endKst.getDate()).padStart(2, "0");
    const hours = String(endKst.getHours()).padStart(2, "0");
    const minutes = String(endKst.getMinutes()).padStart(2, "0");
    const seconds = String(endKst.getSeconds()).padStart(2, "0");

    fs.writeFileSync(
        `${dirPath}/ji3_time_check.json`,
        JSON.stringify({ created: `${year}-${month}-${day}T${hours}:${minutes}:${seconds}+09:00` }, null, 2),
        'utf-8'
    );
    logWithTime(`뉴스 데이터 저장 완료: ${newsArr.length}`);
    await browser.close();
})();