
const { chromium } = require('playwright');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();
const fs = require('fs');
const { logWithTime } = require('./common');

(async () => {
    // 추가 광고/트래킹/외부 리소스 차단

    const delay = (ms) => new Promise(res => setTimeout(res, ms));

    logWithTime('크롤링 시작', '⏰');
    const browser = await chromium.launch({ headless: true });
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY_HS);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });

    const page = await browser.newPage();
    // 광고, 추적, 불필요 리소스 차단
    await page.route('**/*.{png,jpg,jpeg,gif,css,js,woff,woff2,svg}', route => route.abort());
    await page.route('**/ads/**', route => route.abort());
    await page.route('**/sync/**', route => route.abort());
    await page.route('**/openx/**', route => route.abort());
    await page.route('**/doubleclick.net/**', route => route.abort());
    await page.route('**/ybp.yahoo.com/**', route => route.abort());
    await page.route('**/freewheel-ssp/**', route => route.abort());
    await page.route('**/pxd?PLATFORM_ID=*', route => route.abort());
    await page.route('**/cdn-ima.33across.com/**', route => route.abort());
    await page.route('**/pr-bh.ybp.yahoo.com/**', route => route.abort());
    await page.route('**/see?*_bee_ppp=*', route => route.abort());
    await page.route('**/tracker.digitalcamp.co.kr/**', route => route.abort());
    await page.route('**/PelicanC.dll**', route => route.abort());
    await page.route('**/ad.aceplanet.co.kr/**', route => route.abort());
    await page.route('**/unruly?rndcb=*', route => route.abort());
    await page.route('**/cookies.nextmillmedia.com/**', route => route.abort());
    await page.route('**/match.rundsp.com/**', route => route.abort());
    await page.route('**/cs.nex8.net/**', route => route.abort());
    await page.route('**/dps.jp.cinarra.com/**', route => route.abort());
    await page.route('**/t.adx.opera.com/**', route => route.abort());
    await page.route('**/bind.excelate.ai/**', route => route.abort());


    // await page.setExtraHTTPHeaders({ 'User-Agent': userAgent });
    // await page.route('**/*', (route) => {
    //     const url = route.request().url();
    //     if (
    //         url.includes('ads') ||
    //         url.includes('pubmatic') ||
    //         url.includes('opera.com/pub/sync') ||
    //         url.includes('idsync.rlcdn.com') ||
    //         url.includes('turn.com') ||
    //         url.match(/\\.(gif|jpg|png|svg)$/)
    //     ) {
    //         return route.abort();
    //     }
    //     route.continue();
    // });

    await page.goto("https://zdnet.co.kr/news/?lstcode=0000");


    // 1. 뉴스 리스트 추출
    const newsPosts = await page.$$('.newsPost');
    const now = new Date();

    let count = 0;
    const results = [];
    for (const post of newsPosts) {
        // 2. 날짜/시간 추출 (에러 핸들링 추가)
        let dateText;
        try {
            dateText = await post.$eval('.byline > span', el => el.textContent.trim());
        } catch (err) {
            // 날짜 정보가 없으면 건너뜀
            continue;
        }

        // 예: '2025.10.09 PM 06:14'
        const dateMatch = dateText.match(/(\d{4}\.\d{2}\.\d{2})\s+(AM|PM)\s+(\d{2}):(\d{2})/);
        if (!dateMatch) continue;

        let [_, ymd, ampm, hour, minute] = dateMatch;
        let [year, month, day] = ymd.split('.').map(Number);
        hour = Number(hour);
        minute = Number(minute);
        if (ampm === 'PM' && hour < 12) hour += 12;
        if (ampm === 'AM' && hour === 12) hour = 0;
        const articleDate = new Date(year, month - 1, day, hour, minute);
        // 3. 1시간 이내만 필터링
        if (now - articleDate > 60 * 60 * 1000) continue;

        // 4. 기사 링크 추출 및 본문 크롤링 (안정성 개선)
        const link = await post.$eval("a[href^='/view/?no=']", el => el.href);
        logWithTime(`크롤링 중... ${link}`, '🔍');
        let title = '';
        let article = '';
        try {
            //🔵 크롤링
            const articlePage = await browser.newPage();
            // 기사 본문 페이지도 불필요 리소스 차단: 본문 URL만 허용
            await articlePage.route('**', (route) => {
                if (route.request().url() === link) {
                    route.continue();
                } else {
                    route.abort();
                }
            });
            await articlePage.goto(link, { timeout: 30000 });

            // 제목 크롤링
            try {
                title = await articlePage.$eval(
                    'body > div.contentWrapper > div.container > div.left_cont > div > div > div.news_head > h1',
                    el => el.textContent.trim()
                );
            } catch (err) {
                title = '[제목 없음]';
            }

            // 본문 크롤링: #article-[no] > p
            const noMatch = link.match(/no=(\d+)/);
            if (noMatch) {
                const no = noMatch[1];
                try {
                    const paragraphs = await articlePage.$$eval(`#content-${no} > p`, els => els.map(e => e.textContent.trim()).filter(Boolean));
                    article = paragraphs.join('\n');
                } catch (err) {
                    article = '[본문 없음]';
                }
            } else {
                article = '[본문 없음]';
            }



            //🔵GEMINI API로 재생성
            //제목 가공
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
                    console.error('Gemini newTitle 변환 실패:', e);
                    console.error('환경변수 GEMINI_API_KEY_HS:', process.env.GEMINI_API_KEY_HS);
                    const errorLog = `[${new Date().toISOString()}] [Gemini newTitle 변환 실패] title: ${title}\nError: ${e && e.stack ? e.stack : e}\nGEMINI_API_KEY_HS: ${process.env.GEMINI_API_KEY_HS}\n`;
                    if (!fs.existsSync('error-log')) {
                        fs.mkdirSync('error-log', { recursive: true });
                    }
                    fs.appendFileSync('error-log/gemini-error.log', errorLog, 'utf-8');
                }
            } else {
                newTitle = '[제목 없음]';
                console.log(`title parsing에 실패해서 newTitle = '[제목 없음]' ${link}`);
            }

            //본문 가공
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
                    console.error('Gemini newArticle 변환 실패:', e);
                    console.error('환경변수 GEMINI_API_KEY_HS:', process.env.GEMINI_API_KEY_HS);
                    const errorLog = `[${new Date().toISOString()}] [Gemini newArticle 변환 실패] title: ${title}\nError: ${e && e.stack ? e.stack : e}\nGEMINI_API_KEY_HS: ${process.env.GEMINI_API_KEY_HS}\n`;
                    if (!fs.existsSync('error-log')) {
                        fs.mkdirSync('error-log', { recursive: true });
                    }
                    fs.appendFileSync('error-log/gemini-error.log', errorLog, 'utf-8');
                }
            } else {
                newArticle = '[본문 없음]';
                console.log(`article parsing에 실패해서 newArticle = '[본문 없음]' ${link}`);
            }

            //해시태그 생성
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

            //🔵 모든 결과 저장 (실패/빈 값 포함)
            if (
                newArticle !== '[본문 없음]' &&
                newTitle !== '[제목 없음]' &&
                newArticle !== '[변환 실패]' &&
                newTitle !== '[변환 실패]'
            ) {
                results.push({
                    date: articleDate.toISOString(),
                    title,
                    article,
                    link,
                    newTitle,
                    newArticle,
                    hashTag
                });
            }

            count++;
            await articlePage.close();
            await delay(Math.random() * 10000);
        } catch (err) {
            // 페이지 열기/이동 실패 시 해당 기사만 건너뜀
            console.error(`기사 페이지 오류: ${link}\n${err}`);
            continue;
        }

    }

    // 🔵파일로 저장
    const dirPath = 'data';
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
        logWithTime('data 디렉터리 생성됨');
    }
    fs.writeFileSync(`${dirPath}/hs-1.json`, JSON.stringify(results, null, 2), 'utf-8');

    const nowTime = new Date();
    const utc = nowTime.getTime() + nowTime.getTimezoneOffset() * 60000;
    const kst = new Date(utc + 9 * 60 * 60000);
    // KST 기준 시각을 구성
    const year = kst.getFullYear();
    const month = String(kst.getMonth() + 1).padStart(2, "0");
    const day = String(kst.getDate()).padStart(2, "0");
    const hours = String(kst.getHours()).padStart(2, "0");
    const minutes = String(kst.getMinutes()).padStart(2, "0");
    const seconds = String(kst.getSeconds()).padStart(2, "0");

    fs.writeFileSync(
        `${dirPath}/time_check_hs.json`,
        JSON.stringify({ created: `${year}-${month}-${day}T${hours}:${minutes}:${seconds}+09:00` }, null, 2),
        'utf-8'
    );

    console.log(`크롤링된 IT 뉴스 기사 수: ${count}`);
    await browser.close();
})();