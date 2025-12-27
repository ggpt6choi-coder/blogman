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
    if (!process.env.GEMINI_API_KEY_JI) {
        logWithTime('GEMINI_API_KEY_JI is missing in .env');
        process.exit(1);
    }
    const browser = await chromium.launch({ headless: true });
    const scList = ['sisa', 'spo', 'ent', 'pol', 'eco', 'soc', 'int', 'its'];
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
            if (count > 2) break; // 최대 3개 뉴스만 처리
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
                    // 1. 단일 페르소나 고정: SEO 전문가 + 친절한 이웃
                    const fixedConcept = "SEO 최적화 전문가이자 친절한 정보 공유자: 검색 로직을 완벽히 이해하고 있으며, 독자에게 도움이 되는 정보를 가장 쉽고 명확하게 전달하는 스타일.";

                    const prompt = `
                    당신은 네이버 블로그의 상위 노출 로직(C-Rank, DIA+)을 완벽히 마스터한 '파워 블로거'입니다.
                    **최우선 목표는 '검색 노출'이며, 그 다음이 '체류 시간 확보'입니다.**

                    [🔴 필수 페르소나 지침]
                    - **검색 최적화**: 제목과 본문에 키워드를 정확하게 배치하는 것을 목숨처럼 여기세요.
                    - **가독성**: 모바일에서 읽기 편하게 짧은 문장과 줄바꿈을 적극 활용하세요.
                    - **말투**: "~해요", "~더라고요" 같은 부드러운 구어체를 사용하되, 정보 전달은 확실하게 하세요.

                    결과는 반드시 아래의 JSON 포맷으로만 출력하세요. (JSON 포맷 외 잡담 금지)

                    {
                        "newTitle": "SEO 최적화 제목",
                        "newArticle": [
                            {"title": "소제목1 (상황 분석)", "content": "내용1"},
                            {"title": "소제목2 (심층 해설)", "content": "내용2"},
                            {"title": "소제목3 (배경 지식)", "content": "내용3"},
                            {"title": "소제목4 (실생활 꿀팁)", "content": "내용4"},
                            {"title": "마무리 및 요약", "content": "내용5"}
                        ],
                        "hashTag": ["#태그1", "#태그2", ...],
                        "sourceCredit": "출처 표기 문구"
                    }

                    ---

                    ### [Step 1. SEO 최적화 제목 작성 (가장 중요!)]
                    *검색에 걸리지 않는 글은 없는 글과 같습니다.*
                    1. **메인 키워드 선정**: 기사에서 사람들이 가장 많이 검색할 단어 **하나**를 정하세요. (예: '난방비', '손흥민', '연말정산')
                    2. **위치 강제**: 메인 키워드는 **무조건 제목의 맨 앞**에 와야 합니다.
                       - (O) **난방비** 절약 방법, 이것만 알면 50% 감면!
                       - (X) 겨울철 걱정되는 **난방비**, 줄이는 방법은? (뒤로 가면 노출 확률 급락)
                    3. **형식**: \`[메인키워드] + [유입을 부르는 문구/이득] + [서브 키워드]\`

                    ### [Step 2. 도입부 (체류시간 방어)]
                    - **키워드 반복**: 첫 3줄 안에 **메인 키워드**를 2회 이상 자연스럽게 언급하세요.
                    - **후킹**: "혹시 ... 때문에 고민이신가요?"와 같이 독자의 상황을 짚어주며 시작하세요.

                    ### [Step 3. 본문 구성 (C-Rank 신뢰도 상승)]
                    *단순 뉴스 복사가 아니라, AI의 지식을 더해 '새로운 정보'를 제공해야 검색 점수가 오릅니다.*

                    1. **섹션 1 (팩트 체크)**: 뉴스의 핵심 내용을 초등학생도 알기 쉽게 요약 설명.
                    2. **섹션 2 (배경 지식)**: 왜 이런 일이 일어났는지, 과거 사례나 원인 분석을 추가 (기사에 없는 내용 필수).
                    3. **섹션 3 (전망 및 영향)**: 앞으로 어떻게 될 것인지 전문가적 시각에서 예측.
                    4. **섹션 4 (행동 요령)**: 독자가 당장 써먹을 수 있는 **구체적인 팁 3가지** (번호 매기기).
                    5. **섹션 5 (마무리)**: 요약과 함께 댓글을 유도하는 질문.

                    ### [Step 4. 키워드 밀도 및 포맷]
                    - **밀도**: 본문 전체에서 **메인 키워드**를 **총 5~7회** 반복하세요. 너무 적으면 노출 안 됨, 너무 많으면 어뷰징.
                    - **소제목**: 각 소제목에도 연관 키워드를 포함시키면 좋습니다.
                    - **강조**: 핵심 내용은 따옴표("")로 강조하세요.

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