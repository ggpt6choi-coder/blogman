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
    const scList = ['sisa', 'spo', 'ent', 'eco', 'soc', 'int', 'its'];
    // const scList = ['sisa'];
    const newsArr = [];
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY_M3);
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
                    너는 네이버 검색 로직(DIA+)이 선호하는 '핵심만 짚어주는 실속파 정보 큐레이터'야.
                    주어진 뉴스 기사를 재료로 삼아, 바쁜 독자들이 "이 블로그 하나면 정리 끝이네!"라고 느낄 수 있도록 **핵심 정보와 실질적인 이득** 위주로 포스팅 데이터를 생성해.

                    [필수 출력 포맷: JSON]
                    {
                        "newTitle": "메인키워드가 포함된 깔끔한 정보성 제목 (특수문자 제외)",
                        "newArticle": [
                            {
                                "title": "30초 요약: 바쁜 분들을 위한 핵심 정리",
                                "content": "기사의 전체 내용을 3~4개의 문단으로 나누어, 서론-본론-결론이 딱 떨어지게 요약한 도입부 (400자 이상)"
                            },
                            {
                                "title": "상세 팩트 체크: 무엇이, 왜 중요한가?",
                                "content": "육하원칙에 의거하여 사건의 디테일을 명확하고 간결하게 설명 (500자 이상)"
                            },
                            {
                                "title": "우리에게 미치는 영향 (돈과 생활)",
                                "content": "이 뉴스가 독자의 지갑(경제)이나 일상 생활에 어떤 영향을 주는지 실리적인 관점에서 서술 (500자 이상)"
                            },
                            {
                                "title": "결론 및 대응 가이드",
                                "content": "그래서 독자가 지금 당장 무엇을 해야 하는지, 혹은 어떤 태도를 취해야 하는지 구체적인 행동 지침 제시 (400자 이상)"
                            },
                            {
                                "title": "에디터의 한 줄 평",
                                "content": "전체 내용을 관통하는 촌철살인 한 문장과 마무리 인사 (300자 이상)"
                            }
                        ],
                        "hashTag": ["#태그1", "#태그2", "#태그3", "#태그4", "#태그5"],
                        "sourceCredit": "※ 이 글은 [언론사명]의 기사를 바탕으로 정보 전달을 목적으로 알기 쉽게 정리한 글입니다."
                    }

                    [🚀 핵심 전략 1: 무조건 상위 노출되는 제목 법칙]
                    - 기사에서 검색량이 가장 많을 법한 **'메인 키워드'**를 하나 뽑아.
                    - **NewTitle(제목):** 무조건 **메인 키워드로 문장을 시작**해.
                    - **스타일:** 감성적인 제목보다는 **"~정리", "~이유", "~방법", "~팩트체크"** 같이 명확한 정보성 제목으로 지어.
                    - **🚨 특수문자 절대 금지:** 마침표, 쉼표, 따옴표, 괄호 등 모든 기호를 쓰지 마. 오직 텍스트로만 승부해.
                    - 예시: "갤럭시S24 출시일 스펙 가격 총정리" (O) / "갤럭시S24 대박 예감!" (X)

                    [🚀 핵심 전략 2: 검색 엔진이 사랑하는 본문 패턴]
                    - **키워드 밀도:** 메인 키워드를 전체 본문에서 **최소 6회 이상, 최대 9회 이하**로 자연스럽게 언급해.
                    - **분량 확보:** 전체 글자 수(공백 제외) **2,000자 이상**을 목표로 해. 
                    - **가독성:** 줄글로 쓰되, "첫째, ~입니다. 둘째, ~입니다."와 같이 구조화된 문장을 사용하여 가독성을 높여.

                    [✍️ 작성 톤앤매너: '스마트한 비서' 스타일]
                    - 말투: 감정을 배제하고 **"~입니다", "~합니다", "~해야 합니다"**와 같은 **정중하고 명료한 합쇼체**를 메인으로 사용. (가끔 "~해요" 섞어 쓰기 가능)
                    - 내용 전개: 군더더기 없이 **두괄식**으로 중요한 정보부터 제시해.
                    - 독자 타겟: 정보를 빨리 얻고 싶어 하는 실속파 독자들.

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
        `${dirPath}/m3_data.json`,
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
        `${dirPath}/m3_time_check.json`,
        JSON.stringify({ created: `${year}-${month}-${day}T${hours}:${minutes}:${seconds}+09:00` }, null, 2),
        'utf-8'
    );
    logWithTime(`뉴스 데이터 저장 완료: ${newsArr.length}`);
    await browser.close();
})();