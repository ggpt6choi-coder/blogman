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
    if (!process.env.GEMINI_API_KEY_JI) {
        logWithTime('GEMINI_API_KEY_JI is missing in .env');
        process.exit(1);
    }
    const browser = await chromium.launch({ headless: true });
    const scList = ['sisa', 'spo', 'ent', 'eco', 'soc', 'int', 'its'];
    const newsArr = [];
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY_JI);
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
            if (stopCrawling) break;
            if (count >= 2) break; // 최대 2개 뉴스만 처리
            count++;
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
                        당신은 네이버 블로그 로직(C-Rank, DIA+)을 씹어먹는 '상위 1% 파워 블로거'입니다.
                        주어진 기사를 재료로, **검색 결과 1위와 네이버 메인(홈판) 노출**을 동시에 잡을 수 있는 **고퀄리티 포스팅**을 작성하세요.

                        [🔴 작성 전략]
                        - **검색 최적화**: 제목과 본문 첫 줄에 목숨을 거세요.
                        - **패턴 파괴**: 매번 "안녕하세요", "혹시"로 시작하지 마세요. **기사 내용에 따라 탄식, 놀람, 질문, 결론 제시 등 다양한 도입부**를 사용하세요.
                        - **깊이 있는 콘텐츠**: 단순 요약은 하수입니다. **배경지식(TMI), 과거 사례, 당신만의 분석**을 더해 글을 풍성하게 만드세요.

                        결과는 반드시 아래의 JSON 포맷으로만 출력하세요.

                        {
                            "newTitle": "블로그용 제목",
                            "newArticle": [
                                {"title": "소제목1 (상황 분석)", "content": "내용1 (문단 나눔 필수)"},
                                {"title": "소제목2 (심층 해설)", "content": "내용2 (문단 나눔 필수)"},
                                {"title": "소제목3 (숨겨진 이야기/TMI)", "content": "내용3 (문단 나눔 필수)"},
                                {"title": "소제목4 (실생활 적용/전망)", "content": "내용4 (문단 나눔 필수)"},
                                {"title": "솔직한 후기", "content": "내용5"}
                            ],
                            "hashTag": ["#태그1", "#태그2", ...],
                            "sourceCredit": "출처 표기 문구"
                        }

                        ---

                        ### [Step 1. 제목(newTitle) 작성 - '순수 텍스트'의 힘]
                        - **특수문자([], !, ?) 최소화**: 대괄호 대신 띄어쓰기로 구분하세요. (검색 매칭률 상승)
                        - **원칙**: [메인 키워드]를 맨 앞에 배치 + [자극적인 후킹 문구] + [구체적 수치/팩트]
                        - (이전): [한동훈 가족] 윤석열 부부 비판...
                        - (수정): **한동훈 가족 논란 윤석열 부부 비판 글 진실과 당무감사 결과 분석** (깔끔하고 검색 잘 됨)

                        ### [Step 2. 도입부(SEO) - '혹시' 금지령]
                        - **절대 금지**: "혹시 ~ 궁금하신가요?", "안녕하세요 ~입니다." 같은 상투적인 시작 금지.
                        - **작성법**: 기사의 가장 충격적이거나 핵심적인 내용을 **첫 문장에 바로 던지세요.** 단, **메인 키워드**는 첫 문장에 반드시 포함해야 합니다.
                        - 예시: "와, 결국 밝혀졌네요. **한동훈 가족** 명의로 작성된 게시글이 사실로 확인됐다는 소식입니다."

                        ### [Step 3. 본문 구성 - '블로그다운' 깊이]
                        - **목표 분량: 공백 포함 2,000자 이상.** (내용을 부풀리세요)
                        - **섹션 1 (팩트)**: 육하원칙에 따라 기사를 설명하되, 감정(놀람, 안타까움 등)을 섞어서 전달.
                        - **섹션 2~3 (심화/TMI)**: **AI의 지식 활용 구간.** 기사에는 없지만 관련된 법적 상식, 과거 유사 정치 이슈, 해당 인물의 과거 발언 등을 찾아내어 내용을 확장하세요.
                        - **섹션 4 (전망/팁)**: 앞으로의 파장이나 독자가 알아야 할 점을 정리.

                        ### [Step 4. 키워드 & 가독성]
                        - **메인 키워드**는 본문 전체에 **6~8회** 자연스럽게 녹이세요.
                        - 각 content는 **줄바꿈(\\n\\n)을 사용해 2~3개 문단**으로 나누어 모바일 가독성을 높이세요.

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
            // 기존 5~15초 -> 6~10초로 변경 (속도 최적화)
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
        `${dirPath}/nate-ji.json`,
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
        `${dirPath}/nate-ji_time_check.json`,
        JSON.stringify({ created: `${year}-${month}-${day}T${hours}:${minutes}:${seconds}+09:00` }, null, 2),
        'utf-8'
    );
    logWithTime(`뉴스 데이터 저장 완료: ${newsArr.length}`);
    await browser.close();
})();