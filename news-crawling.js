require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { chromium } = require('playwright');
const fs = require('fs');
const { logWithTime } = require('./common');

(async () => {
    const browser = await chromium.launch({ headless: true });
    // const scList = ['sisa', 'spo', 'ent', 'pol', 'eco', 'soc', 'int', 'its'];
    // const scList = ['sisa', 'spo', 'ent'];
    const scList = ['sisa'];
    const newsArr = [];
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
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
    for (const sc of scList) {
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
            console.log(link);
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
                console.log('CAPTCHA 감지됨. 크롤링 중단.');
                process.exit(1);
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
                    console.log(`title = '[제목 없음]' ${link}`);
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
                    console.log(`article = '[본문 없음]' ${link} `);
                }
            }
            // Gemini API로 제목 변환
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
                    const result = await model.generateContent(prompt);
                    const raw = result.response.text();
                    newTitle = raw.trim();
                    if (!newTitle) newTitle = '[빈 응답]';
                    await new Promise((res) => setTimeout(res, 2000));
                } catch (e) {
                    newTitle = '[변환 실패]';
                    console.log(`newTitle = '[변환 실패]'`);
                    const errorLog = `[${new Date().toISOString()}] [Gemini newTitle 변환 실패] title: ${title}\nError: ${e && e.stack ? e.stack : e}\n`;
                    if (!fs.existsSync('error-log')) {
                        fs.mkdirSync('error-log', { recursive: true });
                    }
                    fs.appendFileSync('error-log/gemini-error.log', errorLog, 'utf-8');
                }
            } else {
                newTitle = '[제목 없음]';
                console.log(`title parsing에 실패해서 newTitle = '[제목 없음]' ${link}`);
            }
            // Gemini API로 본문 재가공
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

                    const result = await model.generateContent(prompt);
                    const raw = result.response.text().trim();
                    try {
                        newArticle = JSON.parse(raw);
                    } catch (jsonErr) {
                        const match = raw.match(/\[.*\]/s);
                        if (match) {
                            newArticle = JSON.parse(match[0]);
                        } else {
                            newArticle = '[변환 실패]';
                        }
                    }
                    await new Promise((res) => setTimeout(res, 2000));
                } catch (e) {
                    newArticle = '[변환 실패]';
                    console.log(`newArticle = '[변환 실패]'`);
                    const errorLog = `[${new Date().toISOString()}] [Gemini newArticle 변환 실패] title: ${title}\nError: ${e && e.stack ? e.stack : e}\n`;
                    if (!fs.existsSync('error-log')) {
                        fs.mkdirSync('error-log', { recursive: true });
                    }
                    fs.appendFileSync('error-log/gemini-error.log', errorLog, 'utf-8');
                }
            } else {
                newArticle = '[본문 없음]';
                console.log(`article parsing에 실패해서 newArticle = '[본문 없음]' ${link}`);
            }

            // Gemini API로 해시태그 생성
            let hashTag = '';
            if (article !== '[본문 없음]' && article.length !== 0) {
                try {
                    const prompt = `다음 뉴스 본문을 기반으로 네이버 검색 알고리즘에 최적화된 해시태그 5개이상 10개미만 만들어줘.\n\n
                    - '#해시태그1 #해시태그2 #해시태그3' 형태로 만들어줘.\n\n
                    - 답변은 내가 요청한 형태로만 대답해줘. 바로 복사해서 사용할꺼니까\n\n
                    - 기사: ${article}\n\n:`;
                    const result = await model.generateContent(prompt);
                    hashTag = result.response.text().trim().split(/\s+/);
                    await new Promise((res) => setTimeout(res, 2000));
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
                    console.log(`hashTag = '[생성 실패]' ${link}`);
                    const errorLog = `[${new Date().toISOString()}] [Gemini newArticle 변환 실패] title: ${title}\nError: ${e && e.stack ? e.stack : e}\n`;
                    if (!fs.existsSync('error-log')) {
                        fs.mkdirSync('error-log', { recursive: true });
                    }
                    fs.appendFileSync('error-log/gemini-error.log', errorLog, 'utf-8');
                }
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
            // 요청 간 5~15초 랜덤 지연 (테스트 목적)
            await delay(5000 + Math.random() * 10000);
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
        `${dirPath}/news.json`,
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
        `${dirPath}/time_check.json`,
        JSON.stringify({ created: `${year}-${month}-${day}T${hours}:${minutes}:${seconds}+09:00` }, null, 2),
        'utf-8'
    );
    logWithTime(`뉴스 데이터 저장 완료: ${newsArr.length}`);
    await browser.close();
})();