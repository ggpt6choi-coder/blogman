
const { chromium } = require('playwright');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();
const fs = require('fs');
const { logWithTime, getKstIsoNow, isWithinLastHour, parseGeminiResponse } = require('./common');
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
        if (count > 2) continue;
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

            // 6. GEMINI API로 통합 가공 (제목, 본문, 해시태그)
            let newTitle = '';
            let newArticle = '';
            let hashTag = [];

            if (article !== '[본문 없음]' && article.length !== 0 && title !== '[제목 없음]') {
                try {
                    const prompt = `
                    너는 대한민국 연예계 이슈를 가장 감성적이고 수다스럽게 풀어내는 **'투머치토커(TMT) 연예 전문 블로거'**야.
                    주어진 기사 내용을 바탕으로, 독자가 깊이 공감하고 몰입할 수 있는 **풍성한 블로그 포스팅**을 작성해.

                    [입력 데이터]
                    - 원본 제목: ${title}
                    - 기사 내용: ${article}

                    [필수 출력 포맷 (JSON)]
                    - **반드시 아래 JSON 형식을 정확히 지켜.** (Markdown code block '''json 사용 금지)
                    - newArticle 배열 내부의 키값은 **'subTitle'이 아니라 반드시 'title'로** 작성해.
                    - 내용(content) 내의 줄바꿈은 '\\n'으로, 큰따옴표는 '\\"'로 이스케이프 처리해.

                    {
                    "newTitle": "특수문자 없는 깔끔한 제목",
                    "newArticle": [
                        {"title": "소제목1", "content": "내용1 (최소 300자 이상)"},
                        {"title": "소제목2", "content": "내용2 (최소 300자 이상)"},
                        {"title": "소제목3", "content": "내용3 (최소 300자 이상)"},
                        {"title": "소제목4", "content": "내용4 (최소 300자 이상)"},
                        {"title": "솔직한 후기", "content": "내용5 (최소 300자 이상)"}
                    ],
                    "hashTag": ["#태그1", "#태그2", ...]
                    }

                    [작성 가이드 1: 제목 클린 정책 (매우 중요!)]
                    - 제목에 **[ ] , { } , ( ) , ★ , ♥ , " , ' , - , |** 같은 특수문자를 절대 사용하지 마.
                    - 오직 **한글, 영문, 숫자, 물음표(?), 느낌표(!)**만 사용해서 문장을 완성해.
                    - 예시: "[종합] 故안성기 추모.. (눈물)" (X) -> "안성기 추모 물결 배우들의 눈물과 검은 옷 시사회" (O)

                    [작성 가이드 2: 내용 뻥튀기 (TMT 전략)]
                    - 기사를 요약하지 말고, 너의 **배경지식(과거 작품, TMI, 여론)**을 총동원해서 **3배 이상 늘려써.**
                    - 각 섹션(content)은 **최소 10문장 이상**으로 길게 작성해.
                    - 말투: "세상에..", "진짜 마음이 아프네요", "그거 아세요?" 같이 말을 거는 **100% 구어체** 사용.

                    [세부 섹션 구성]
                    1. 섹션 1 (title: 감성 도입부): 기사 요약 금지. "여러분 오늘 소식 들으셨나요?"라며 감성적으로 접근.
                    2. 섹션 2 (title: 배경 설명): 사건의 배경이나 인물에 대한 TMI 설명. (기사에 없어도 관련 지식 활용)
                    3. 섹션 3 (title: 핵심 내용): 기사의 육하원칙을 아주 상세하게 묘사.
                    4. 섹션 4 (title: 의미 부여): 이 사건이 주는 의미나 대중들의 반응 소개.
                    5. 섹션 5 (title: 솔직한 후기): 너의 주관적인 감정과 다짐. ("저는 앞으로~ 할래요")
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
            // 10 RPM 제한 준수를 위한 지연 (기사당 1회 호출하므로, 기사당 최소 6초 이상 소요되어야 함)
            await delay(6000 + Math.random() * 4000);
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
    fs.writeFileSync(`${dirPath}/m1_data.json`, JSON.stringify(results, null, 2), 'utf-8');
    // time_check.json 저장
    fs.writeFileSync(`${dirPath}/m1_time_check.json`, JSON.stringify({ created: `${getKstIsoNow()}` }, null, 2), 'utf-8');

    await browser.close();
})();