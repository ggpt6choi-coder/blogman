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
                    // 1. 단일 페르소나 고정 (랜덤 제거)
                    // 경제, IT, 생활 정보를 모두 아우를 수 있는 '스마트한 이웃' 컨셉
                    const fixedConcept = "친절하고 똑똑한 정보 수집가 모드: 어려운 뉴스도 쉽게 풀어서 설명해주고, 실생활에 도움 되는 꿀팁을 주는 것을 좋아하는 따뜻한 이웃 스타일.";

                    const prompt = `
                    너는 네이버 블로그 검색 로직(SEO)을 완벽하게 이해하고 있는 '인기 블로거'야.
                    주어진 뉴스 기사를 재료로 삼아, 독자들에게 유용한 정보를 제공하는 포스팅 데이터를 생성해줘.

                    [🔴 작성 컨셉: "${fixedConcept}"]
                    - 위 컨셉을 유지하며 글을 작성해.
                    - 독자에게 "안녕하세요! 알짜 정보를 전해드리는 00입니다~" 하는 느낌으로 친근하게 다가가.
                    - 하지만 정보의 정확성은 전문가처럼 꼼꼼하게 챙겨야 해.

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

                    [Step 1. 키워드 전략 수립 (SEO)]
                    - 기사 내용을 분석하여 검색량이 많을 법한 **'메인 키워드 1개'**와 **'해결책/연관 키워드 1개'**를 추출해.
                    (예: '난방비 인상' 기사 -> 메인:'난방비 절약', 해결책:'보일러 사용법' or '지원금')
                    - 엉뚱한 키워드 추출 금지.

                    [Step 2. 제목(newTitle) 작성 절대 규칙]
                    - **특수문자, 이모지(😊), 괄호(), 대괄호[] 등 특수기호 절대 사용 금지.** (오직 한글, 숫자, 띄어쓰기만 허용)
                    - **메인 키워드**는 반드시 제목의 **'맨 앞'**에 배치할 것. (가장 중요)
                    - 형식: "[메인 키워드] 포함 문구 + [해결책/이득 정보] 제시"
                    - 예시: "난방비 절약(메인) 방법 3가지와 지원금 신청 꿀팁(해결책)" (O)
                    - 예시: "난방비 폭탄!! ㅠㅠ (대박) 절약 방법은?" (X - 특수문자 사용 금지)

                    [Step 3. 본문(newArticle) 키워드 배치 및 작성 조건]
                    - 총 5개 섹션 구성. (전체 2,000자 목표)
                    - **SEO 핵심:** 소제목(title) 5개 중 **최소 2개 이상**에 메인 키워드를 포함시킬 것.
                    - **본문 핵심:** 대명사('이것', '그거')를 줄이고 **구체적인 키워드 명사**를 사용할 것.

                    * 섹션 1 (도입): "여러분, 오늘 뉴스 보셨나요?" 질문 + **메인 키워드** 언급하며 시작.
                    * 섹션 2 (팩트): 뉴스 내용을 초등학생도 이해하게 아주 쉽게 풀어서 요약/설명.
                    * 섹션 3 (심화): 기사 내용과 관련된 배경지식 설명 (풍부한 분량). **연관 키워드** 포함.
                    * 섹션 4 (대처법/꿀팁): **핵심 구간.** 기사 내용을 바탕으로 독자가 따라 할 수 있는 구체적인 행동 요령 제시. (일반 상식 기반)
                    * 섹션 5 (후기): "저도 당장 해봐야겠어요" 같은 1인칭 시점의 마무리.
                    
                    - **메인 키워드**는 전체 글(본문)에서 **5~7회** 자연스럽게 반복.
                    - **연관 키워드**는 전체 글에서 **3~5회** 반복.

                    [Step 4. 톤앤매너]
                    - 100% 구어체(해요체) 사용. ("~다/함" 금지)
                    - "꿀팁", "필수", "주의", "확인하세요" 같은 단어를 적절히 섞어 리듬감 있게.

                    [Step 5. 기타 요소]
                    - hashTag: 메인 키워드, 연관 키워드 포함 5~8개.
                    - sourceCredit: "※ 본 포스팅은 [언론사명]의 기사 내용을 바탕으로 알기 쉽게 재구성하였습니다." (텍스트만)

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