
const { chromium } = require('playwright');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();
const fs = require('fs');
const { logWithTime, getKstIsoNow, isWithinLastHour } = require('./common');
const SHOW_BROWSER = false; // 실행 중 브라우저 창 표시 여부

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
    const delay = (ms) => new Promise(res => setTimeout(res, ms));

    //////////////////////////////////////////////////////////////////////////
    //🌟🌟🌟🌟🌟 초기 세팅
    logWithTime('크롤링 시작', '⏰');
    if (!process.env.GEMINI_API_KEY_HS) {
        logWithTime('GEMINI_API_KEY_HS is missing in .env');
        process.exit(1);
    }
    const browser = await chromium.launch({ headless: !SHOW_BROWSER });
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY_HS);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });

    //////////////////////////////////////////////////////////////////////////
    //🌟🌟🌟🌟🌟 1번째 사이트 크롤링
    const page = await browser.newPage();
    // 뉴스 리스트 추출-01
    await page.goto("https://entertain.daum.net/ranking/popular");
    await page.waitForSelector('ol.list_ranking');
    const newsPosts = await page.$$eval(
        'ol.list_ranking a.link_thumb',
        els => Array.from(new Set(els.map(e => e.href))) // 중복 제거
    );
    // 뉴스 리스트 추출-02
    await page.goto("https://entertain.daum.net/ranking/keyword");
    await page.waitForSelector('ol.list_topkey');
    const newsPosts2 = await page.$$eval(
        'div.item_relate a',
        els => Array.from(new Set(els.map(e => e.href))) // 중복 제거
    );
    // 뉴스 리스트 합치기
    newsPosts.push(...newsPosts2);
    // 조회 시간 1시간 이내 기사만 필터링
    const toProcessLinks = newsPosts.filter(url => {
        const match = url.match(/(\d{17})$/); // URL에서 뒤의 숫자 부분만 추출
        if (!match) return false; // 숫자 없으면 제외
        const timestamp = match[1];
        return isWithinLastHour(timestamp);
    });

    // 기사 크롤링 시작
    let count = 1;
    const results = [];
    for (const link of toProcessLinks) {
        logWithTime(`크롤링 중...[${count++}/${toProcessLinks.length}] ${link}`, '🔍');
        if (count > 10) continue;
        // 2. 기사별 제목, 기사 크롤링
        let title = '';
        let article = '';
        try {
            const articlePage = await browser.newPage();
            await articlePage.goto(link, { timeout: 30000 });

            // 제목 크롤링
            try {
                title = await articlePage.$eval('#mArticle > div.head_view > h3', el => el.textContent.trim());
            } catch (err) {
                try {
                    title = await articlePage.$eval('#mArticle > div.head_view > h3', el => el.textContent.trim());
                } catch (e) {
                    title = '[제목 없음]';
                }
            }

            // 본문 크롤링 (Daum 기사: section[dmcf-sid] 내부의 dmcf-ptype="general" 요소에서 추출)
            try {
                const paragraphs = await articlePage.$$eval(
                    'section[dmcf-sid] div[dmcf-ptype="general"], section[dmcf-sid] p[dmcf-ptype="general"]',
                    els => {
                        const rawLines = els.flatMap(el => {
                            const text = (el.innerText || el.textContent || '').trim();
                            if (!text) return [];
                            return text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
                        });

                        // 연속 중복 라인 제거
                        const deduped = [];
                        for (let i = 0; i < rawLines.length; i++) {
                            const line = rawLines[i];
                            if (line && line !== rawLines[i - 1]) deduped.push(line);
                        }

                        return deduped.join('\n\n');
                    }
                );

                if (paragraphs && paragraphs.length) {
                    // 페이지 컨텍스트 바깥에서 추가 정리: 이메일/기자명 제거, 과도한 공백 축소
                    let cleaned = paragraphs
                        // 이메일 제거
                        .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '')
                        // 기자명(예: '김수진 기자') 혹은 끝부분에 위치한 기자 서명 제거
                        .replace(/(?:^|\n)([\uAC00-\uD7A3A-Za-z\s]+기자(?:\s*[A-Za-z0-9._%+-@]*)?)(?:\n|$)/g, '\n')
                        // 불필요한 여러 줄바꿈을 2개로 축소
                        .replace(/\n{3,}/g, '\n\n')
                        .trim();

                    if (cleaned.length) {
                        article = cleaned;
                    } else {
                        article = '[본문 없음]';
                    }
                } else {
                    article = '[본문 없음]';
                }
            } catch (err) {
                console.error('본문 크롤링 오류:', err);
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
                    const result = await generateContentWithRetry(model, prompt);
                    const raw = result.response.text();
                    newTitle = raw.trim();
                    if (!newTitle) newTitle = '[빈 응답]';
                    await new Promise((res) => setTimeout(res, 2000));
                } catch (e) {
                    newTitle = '[변환 실패]';
                    logWithTime(`newTitle = '[변환 실패]'`);
                    console.error('Gemini newTitle 변환 실패:', e);
                    const errorLog = `[${new Date().toISOString()}] [Gemini newArticle 변환 실패] title: ${title}\nError: ${e && e.stack ? e.stack : e}\n\n`;
                    if (!fs.existsSync('error-log')) {
                        fs.mkdirSync('error-log', { recursive: true });
                    }
                    fs.appendFileSync('error-log/gemini-error.log', errorLog, 'utf-8');
                }
            } else {
                newTitle = '[제목 없음]';
                logWithTime(`title parsing에 실패해서 newTitle = '[제목 없음]' ${link}`);
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
                    const result = await generateContentWithRetry(model, prompt);
                    const raw = result.response.text().trim();
                    try {
                        // 1. Try parsing raw directly
                        newArticle = JSON.parse(raw);
                    } catch (jsonErr) {
                        // 2. Try cleaning markdown code blocks
                        let cleanRaw = raw.replace(/```json/g, '').replace(/```/g, '').trim();
                        try {
                            newArticle = JSON.parse(cleanRaw);
                        } catch (e2) {
                            // 3. Try extracting array with regex
                            const match = cleanRaw.match(/\[.*\]/s);
                            if (match) {
                                try {
                                    newArticle = JSON.parse(match[0]);
                                } catch (e3) {
                                    newArticle = '[변환 실패]';
                                    console.log('JSON parsing failed even with regex match. Raw:', raw);
                                }
                            } else {
                                newArticle = '[변환 실패]';
                                console.log('JSON parsing failed. Raw:', raw);
                            }
                        }
                    }
                    await new Promise((res) => setTimeout(res, 2000));
                } catch (e) {
                    newArticle = '[변환 실패]';
                    logWithTime(`newArticle = '[변환 실패]'`);
                    console.error('Gemini newArticle 변환 실패:', e);
                    const errorLog = `[${new Date().toISOString()}] [Gemini newArticle 변환 실패] title: ${title}\nError: ${e && e.stack ? e.stack : e}\n\n`;
                    if (!fs.existsSync('error-log')) {
                        fs.mkdirSync('error-log', { recursive: true });
                    }
                    fs.appendFileSync('error-log/gemini-error.log', errorLog, 'utf-8');
                }
            } else {
                newArticle = '[본문 없음]';
                logWithTime(`article parsing에 실패해서 newArticle = '[본문 없음]' ${link}`);
            }

            //해시태그 생성
            let hashTag = '';
            if (article !== '[본문 없음]' && article.length !== 0) {
                try {
                    const prompt = `다음 뉴스 본문을 기반으로 네이버 검색 알고리즘에 최적화된 해시태그 5개이상 10개미만 만들어줘.\n\n
                            - '#해시태그1 #해시태그2 #해시태그3' 형태로 만들어줘.\n\n
                            - 답변은 내가 요청한 형태로만 대답해줘. 바로 복사해서 사용할꺼니까\n\n
                            - 기사: ${article}\n\n:`;
                    const result = await generateContentWithRetry(model, prompt);
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
                    logWithTime(`hashTag = '[생성 실패]' ${link}`);
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
                    title,
                    article,
                    link,
                    type: 'daum_enter',
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
    fs.writeFileSync(`${dirPath}/daum_entertainment_data.json`, JSON.stringify(results, null, 2), 'utf-8');
    // time_check.json 저장
    fs.writeFileSync(`${dirPath}/daum_entertainment_time_check.json`, JSON.stringify({ created: `${getKstIsoNow()}` }, null, 2), 'utf-8');

    await browser.close();
})();