require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { chromium } = require('playwright');
const fs = require('fs');
const { logWithTime } = require('./common');
const { log } = require('console');

(async () => {
    const browser = await chromium.launch({ headless: false });
    // const scList = ['sisa', 'spo', 'ent', 'pol', 'eco', 'soc', 'int', 'its'];
    const scList = ['sisa'];
    const newsArr = [];
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });
    const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    const dateStr = `${yyyy}${mm}${dd}`;

    logWithTime('크롤링 시작', '⏰');
    for (const sc of scList) {
        const page = await browser.newPage();
        await page.setExtraHTTPHeaders({ 'User-Agent': userAgent });
        const url = `https://news.nate.com/rank/interest?sc=${sc}&p=day&date=${dateStr}`;
        await page.goto(url);
        const links = await page.$$eval('.mlt01 a', (as) => as.map((a) => a.href));
        const linkResults = await Promise.all(links.map(async (link) => {
            console.log(link);
            const newPage = await browser.newPage();
            await newPage.setExtraHTTPHeaders({ 'User-Agent': userAgent });
            await newPage.goto(link, { timeout: 120000 });
            // await newPage.goto(link);

            // 제목 크롤링
            // #articleView > h1 값 가져오기
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
                    console.log(`title = '[제목 없음]'`);
                }
            }
            // 본문 크롤링
            // #realArtcContents 전체에서 태그 제거 후 본문만 추출
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
                    console.log(`article = '[본문 없음]'`);
                }
            }
            // Gemini API로 제목 변환
            let newTitle = '';
            if (title !== '[제목 없음]') {
                try {
                    const prompt = `다음 뉴스 제목을 네이버 블로그 검색 최적화된 제목으로 바꿔줘.
                        - 광고, 논란, 자극적 표현은 피할 것.
                        - 따옴표(" '), 대괄호([ ]), 특수문자(→, …, ★ 등)는 모두 제거할 것.
                        - 뉴스 핵심 키워드를 포함해 자연스러운 설명형 문장으로 만들 것.
                        - 제목 길이는 30~45자로 조정할 것.
                        - 기사 내용을 참고해.
                        - 기사 내용: ${article}
                        - 원본 제목: ${title}
                        답변은 바로 복사해 쓸 수 있도록 제목만 알려줘. 다른 말은 필요 없어.
                        변경:
                        `;
                    const result = await model.generateContent(prompt);
                    const raw = result.response.text();
                    newTitle = raw.trim();
                    if (!newTitle) newTitle = '[빈 응답]';
                    // Gemini API 호출 후 2초 대기
                    await new Promise((res) => setTimeout(res, 2000));
                } catch (e) {
                    newTitle = '[변환 실패]';
                    console.log(`newTitle = '[변환 실패]'`);
                    // Gemini API 오류 로그 파일에 에러 내용 기록
                    const errorLog = `[${new Date().toISOString()}] [Gemini newTitle 변환 실패] title: ${title}\nError: ${e && e.stack ? e.stack : e
                        }\n`;
                    fs.appendFileSync('error-log/gemini-error.log', errorLog, 'utf-8');
                }
            } else {
                newTitle = '[제목 없음]';
                console.log(`title parsing에 실패해서 newTitle = '[제목 없음]'`);
            }
            // Gemini API로 본문 재가공
            let newArticle = '';
            if (article !== '[본문 없음]' && article.length !== 0) {
                try {
                    const prompt = `다음 뉴스 본문을 네이버 블로그 검색 엔진에 최적화된 글로 재구성해줘. 조건은 아래와 같아.
                        - 기사 내용과 직접 관련 없는 광고, 무관한 뉴스, 스크립트 코드는 모두 제거할 것.
                        - 기자 서명, 매체명은 삭제하고 핵심 정보만 남길 것.
                        - 글자 수는 900자 이상 2200자 미만으로 자연스럽게 맞출 것.
                        - 소제목은 문장 맨 앞에 '▶ ' 기호를 붙이고, 짧고 직관적인 키워드를 넣을 것. 
                        - '###', '*' 등 마크업 관련 기호는 사용하지 않을 것. 
                        - 문장은 블로그 독자가 읽기 편하도록 자연스럽게 요약·재구성할 것.
                        - 중요한 부분은 설명을 덧붙여 맥락을 쉽게 이해할 수 있게 할 것.
                        - 처음에는 가볍게 주제를 소개하고, 자연스럽게 본문으로 이어갈 것.
                        - 결론 부분에서는 독자가 느낄 수 있는 인사이트나 시사점을 짧게 정리할 것.
                        - 답변은 불필요한 설명 없이 바로 블로그에 복사해 쓸 수 있는 형태로 작성할 것.
                        원본: ${article}
                        변경:
                        `;
                    const result = await model.generateContent(prompt);
                    newArticle = result.response.text().trim();
                    // Gemini API 호출 후 2초 대기
                    await new Promise((res) => setTimeout(res, 2000));
                } catch (e) {
                    newArticle = '[변환 실패]';
                    console.log(`newArticle = '[변환 실패]'`);
                    // Gemini API 본문 변환 오류 로그 파일에 에러 내용 기록
                    const errorLog = `[${new Date().toISOString()}] [Gemini newArticle 변환 실패] title: ${title}\nError: ${e && e.stack ? e.stack : e
                        }\n`;
                    fs.appendFileSync('error-log/gemini-error.log', errorLog, 'utf-8');
                }
            } else {
                newArticle = '[본문 없음]';
                console.log(`article parsing에 실패해서 newArticle = '[본문 없음]'`);
            }

            // Gemini API로 해시태그 생성
            let hashTag = '';
            if (article !== '[본문 없음]' && article.length !== 0) {
                try {
                    const prompt = `다음 뉴스 본문을 기반으로 네이버 검색 알고리즘에 최적화된 해시태그 5개이상 10개미만 만들어줘.\n\n
                        - '#해시태그1 #해시태그2 #해시태그3' 형태로 만들어줘.\n\n
                        - 답변은 내가 요청한 형태로만 대답해줘. 바로 복사해서 사용할꺼니까\n\n
                        기사: ${article}\n\n:`;
                    const result = await model.generateContent(prompt);
                    hashTag = result.response.text().trim().split(/\s+/);
                    // Gemini API 호출 후 2초 대기
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
                    console.log(`hashTag = '[생성 실패]'`);
                    // Gemini API 본문 변환 오류 로그 파일에 에러 내용 기록
                    const errorLog = `[${new Date().toISOString()}] [Gemini newArticle 변환 실패] title: ${title}\nError: ${e && e.stack ? e.stack : e
                        }\n`;
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
                return {
                    type: sc,
                    title,
                    newTitle,
                    article,
                    newArticle,
                    url: link,
                    hashTag,
                };

            }
            await newPage.close();
            return null;

        }));
        for (const item of linkResults) {
            if (item) newsArr.push(item);
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
    logWithTime(`뉴스 데이터 저장 완료: ${newsArr.length}`);
    await browser.close();
})();