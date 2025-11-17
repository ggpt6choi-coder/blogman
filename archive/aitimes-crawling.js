
const { chromium } = require('playwright');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();
const fs = require('fs');
const { logWithTime, getKstIsoNow } = require('../common');
const SHOW_BROWSER = false; // 실행 중 브라우저 창 표시 여부

(async () => {
    const delay = (ms) => new Promise(res => setTimeout(res, ms));

    logWithTime('크롤링 시작', '⏰');
    const browser = await chromium.launch({ headless: !SHOW_BROWSER });
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY_AITIMES);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });

    const page = await browser.newPage();
    await page.goto("https://www.aitimes.com/news/articleList.html?view_type=sm");

    // 1. 뉴스 리스트 추출
    const newsPosts = await page.$$('li.altlist-webzine-item');
    const now = new Date();

    let count = 1;
    const results = [];
    for (const post of newsPosts) {
        if (count > 4) continue;
        // 2. 날짜/시간 추출
        let dateText;
        try {
            // altlist-info-item들은 여러개이므로 세번째(인덱스 2)를 사용
            dateText = await post.$$eval('.altlist-info .altlist-info-item', els => els.map(e => e.textContent.trim()))
                .then(arr => arr[2]);
        } catch (err) {
            continue;
        }
        if (!dateText) continue;

        // 예: '10-11 06:55' -> 현재 연도로 가정, KST(로컬)
        const m = dateText.match(/(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})/);
        if (!m) continue;
        const [__, mm, dd, hourStr, minuteStr] = m;
        const year = now.getFullYear();
        const month = Number(mm);
        const day = Number(dd);
        let hour = Number(hourStr);
        const minute = Number(minuteStr);
        const articleDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+09:00`;
        // 3. 1시간 이내만 필터링
        if (now - new Date(articleDate) > 60 * 60 * 1000) continue;

        // 4. 기사 링크 추출 및 본문 크롤링
        const link = await post.$eval('a.altlist-image, h2.altlist-subject a', el => el.href);
        logWithTime(`크롤링 중... ${link}`, '🔍');

        // 5. 기사별 제목, 기사 크롤링
        let title = '';
        let article = '';
        try {
            const articlePage = await browser.newPage();
            await articlePage.goto(link, { timeout: 30000 });

            // 제목 크롤링
            try {
                title = await articlePage.$eval('h1', el => el.textContent.trim());
            } catch (err) {
                try {
                    title = await articlePage.$eval('#article-view > div > div > header > h1', el => el.textContent.trim());
                } catch (e) {
                    title = '[제목 없음]';
                }
            }

            // 본문 크롤링
            try {
                const paragraphs = await articlePage.$$eval('#article-view-content-div p', els => els.map(e => e.textContent.trim()).filter(Boolean));
                if (paragraphs && paragraphs.length) {
                    article = paragraphs.join('\n');
                } else {
                    article = '[본문 없음]';
                }
            } catch (err) {
                article = '[본문 없음]';
            }

            //6. GEMINI API로 재생성
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
                    const errorLog = `[${new Date().toISOString()}] [Gemini newArticle 변환 실패] title: ${title}\nError: ${e && e.stack ? e.stack : e}\n\n`;
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
                    const errorLog = `[${new Date().toISOString()}] [Gemini newArticle 변환 실패] title: ${title}\nError: ${e && e.stack ? e.stack : e}\n\n`;
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
                    date: articleDate,
                    title,
                    article,
                    link,
                    type: 'AITIMES',
                    newTitle,
                    newArticle,
                    hashTag
                });
            }
            await articlePage.close();
            await delay(Math.random() * 10000);
        } catch (err) {
            // 페이지 열기/이동 실패 시 해당 기사만 건너뜀
            console.error(`기사 페이지 오류: ${link}\n${err}`);
            continue;
        }

    }

    //////////////////////////////////////////////////////////////////////////
    //🌟🌟🌟🌟🌟 json 파일로 저장 
    logWithTime(`크롤링된 뉴스 기사 수: ${results.length}`, '✅');

    // 🔵파일로 저장
    const dirPath = 'data';
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
        logWithTime('data 디렉터리 생성됨');
    }
    // daum_entertainment_data.json 저장
    fs.writeFileSync(`${dirPath}/aitimes_data.json`, JSON.stringify(results, null, 2), 'utf-8');
    // time_check.json 저장
    fs.writeFileSync(`${dirPath}/aitimes_time_check.json`, JSON.stringify({ created: `${getKstIsoNow()}` }, null, 2), 'utf-8');

    await browser.close();
})();