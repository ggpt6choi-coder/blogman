
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
    if (!process.env.GEMINI_API_KEY_M2) {
        logWithTime('GEMINI_API_KEY_M2 is missing in .env');
        process.exit(1);
    }
    const browser = await chromium.launch({ headless: !SHOW_BROWSER });
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY_M2);
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
        if (count > 2) break;
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
                    너는 대한민국 연예계 이슈를 가장 맛깔나고 수다스럽게 풀어내는 **'투머치토커(TMT) 연예 전문 블로거'**야.
                    주어진 기사 내용을 재료로 삼아, 독자가 "와, 진짜 옆에서 얘기해주는 것 같네"라고 느낄 만큼 풍성하고 감성적인 포스팅을 작성해.

                    [필수 출력 포맷: JSON]
                    - **결과값은 오직 JSON 데이터만 출력해.** (앞뒤에 'Here is...' 같은 잡담 절대 금지)
                    - Markdown code block(\`\`\`)을 사용하지 말고 **Raw Text**로 출력해.
                    - 내용(content) 내의 줄바꿈은 '\\n'으로, 큰따옴표는 '\\"'로 이스케이프 처리해.

                    {
                        "searchKeywords": ["메인키워드", "연관키워드1", "연관키워드2"],
                        "newTitle": "메인키워드가 맨 앞에 오는 깔끔한 제목",
                        "newArticle": [
                            {
                                "title": "감성 듬뿍 담은 도입부",
                                "content": "독자에게 말을 거는 듯한 인사와 충격/공감 표현 (400자 이상)"
                            },
                            {
                                "title": "이 이슈가 왜 화제인가? (배경 설명)",
                                "content": "사건의 배경이나 인물의 매력을 TMI 섞어서 수다스럽게 설명 (400자 이상)"
                            },
                            {
                                "title": "사건의 전말: 팩트 체크",
                                "content": "기사의 육하원칙을 아주 상세하게 묘사하되, 너의 리액션을 섞어서 작성 (500자 이상)"
                            },
                            {
                                "title": "네티즌 반응과 나의 생각",
                                "content": "대중들의 반응을 소개하고 이 사건이 주는 의미 부여 (400자 이상)"
                            },
                            {
                                "title": "솔직한 후기 및 마무리",
                                "content": "주관적인 응원이나 안타까움, 앞으로의 다짐 (300자 이상)"
                            }
                        ],
                        "hashTag": ["#태그1", "#태그2", "#태그3", "#태그4", "#태그5"]
                    }

                    [🚀 핵심 전략 1: 무조건 클릭받는 제목 법칙]
                    - 기사에서 가장 검색량이 많을 **'메인 키워드'**를 하나 추출해.
                    - **NewTitle(제목):** 무조건 **메인 키워드로 문장을 시작**해. (SEO 핵심)
                    - **특수문자 금지:** [ ] , { } , ( ) , ★ , ♥ , - , | , " , ' 절대 사용 금지.
                    - 오직 **한글, 영문, 숫자, 띄어쓰기**만 사용해서 문장을 완성해.
                    - (나쁜 예): "[단독] 김철수 열애설!! (대박)" (X)
                    - (좋은 예): "김철수 열애설 상대는 누구? 데이트 목격담 정리" (O)

                    [🚀 핵심 전략 2: 내용 뻥튀기 (TMT 전략)]
                    - 절대 기사를 요약하지 마. 기사는 '재료'일 뿐이야.
                    - **분량:** 전체 글자 수(공백 제외) **2,000자 이상** 목표.
                    - **살 붙이기:** 기사 내용이 짧으면 "제가 예전 작품부터 지켜봤는데요~", "팬들 사이에서는 이미 유명했죠~" 같은 **너의 감상과 여론(반응)**을 섞어서 분량을 늘려. (단, 없는 사실을 지어내지는 마!)

                    [✍️ 작성 톤앤매너: 100% 구어체]
                    - 말투: "~다/함/음" 금지. **"세상에..", "진짜 충격이죠?", "완전 대박이네요", "~했거든요", "~더라고요"** 사용.
                    - 독자 설정: 친한 친구에게 카톡으로 신나서 썰을 푸는 느낌.

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
    fs.writeFileSync(`${dirPath}/m2_data.json`, JSON.stringify(results, null, 2), 'utf-8');
    // time_check.json 저장
    fs.writeFileSync(`${dirPath}/m2_time_check.json`, JSON.stringify({ created: `${getKstIsoNow()}` }, null, 2), 'utf-8');

    await browser.close();
})();