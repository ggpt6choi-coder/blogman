
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
    if (!process.env.GEMINI_API_KEY_JI_2) {
        logWithTime('GEMINI_API_KEY_JI_2 is missing in .env');
        process.exit(1);
    }
    const browser = await chromium.launch({ headless: !SHOW_BROWSER });
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY_JI_2);
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
        logWithTime(`크롤링 중...[${count}/${toProcessLinks.length}] ${link}`, '🔍');
        if (count > 5) continue;
        count++;
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
                    // 연예 뉴스에 특화된 3가지 페르소나 정의
                    const concepts = [
                        "주접킹 팬심 모드: '우리 오빠 미모 무슨 일이야', '심장 아파' 등 비주얼과 매력을 찬양하며 감정을 200% 과몰입해서 표현하는 열성 팬 스타일.",
                        "방구석 1열 리포터 모드: '대박 사건 터졌네요', '현재 네티즌 반응은 이렇습니다' 처럼 이슈의 흐름을 생동감 있고 객관적인 척하지만 흥분해서 전달하는 유튜버 스타일.",
                        "TMI 수집가 모드: 해당 연예인의 과거 작품, 유사한 사례, 숨겨진 비하인드 스토리 등 배경 지식을 풍부하게 엮어서 설명해주는 연예계 척척박사 스타일."
                    ];

                    // ... (concepts 배열 동일) ...
                    const selectedConcept = concepts[0];

                    const prompt = `
                        너는 네이버 블로그 검색 로직을 완벽히 이해하는 '상위 1% 연예 블로거'야.
                        주어진 기사를 재료로, **검색 상위 노출(SEO)**과 **높은 클릭률(CTR)**을 동시에 잡는 포스팅을 작성해.

                        [🔴 적용 페르소나: "${selectedConcept}"]
                        - 기계적인 말투 금지. 팬심과 감정을 200% 담아서 작성.
                        - **중요한 문장, 핵심 키워드, 충격적인 숫자는 **볼드체**로 강조.**

                        결과는 반드시 아래의 JSON 포맷으로만 출력해.

                        {
                            "newTitle": "블로그용 제목",
                            "newArticle": [
                                {"title": "소제목1", "content": "내용1 (문단 나눔 필수)"},
                                {"title": "소제목2", "content": "내용2 (문단 나눔 필수)"},
                                {"title": "소제목3", "content": "내용3 (문단 나눔 필수)"},
                                {"title": "소제목4", "content": "내용4 (문단 나눔 필수)"},
                                {"title": "솔직한 후기", "content": "내용5"}
                            ],
                            "hashTag": ["#태그1", "#태그2", ...],
                            "sourceCredit": "출처 표기 문구"
                        }

                        [Step 1. 제목(newTitle) 작성 - '키워드'와 '클릭'의 황금비율]
                        - **제1원칙:** 사람들이 검색할 법한 **'메인 키워드'**를 반드시 제목 **맨 앞**에 배치하라. (노출 기본 조건)
                        - **제2원칙:** 키워드 뒤에는 기사의 **구체적인 숫자(금액, 나이, 시청률 등)**나 **핵심 상황**을 적어 클릭을 유도하라.
                        - (나쁜 예): "김장훈 재산 공개 및 라디오쇼 출연" (너무 밋밋함)
                        - (완벽한 예): "**김장훈 재산**(검색어) 200만원? 62세 가왕의 지하철 무료 고백(후킹)"

                        [Step 2. 본문 도입부(SEO) 전략]
                        - **첫 문장 규칙:** 본문이 시작되자마자 **첫 문장**에 **메인 키워드**를 자연스럽게 포함시킬 것.
                        - 예시: "여러분, 오늘 공개된 **김장훈 재산** 소식 보셨나요? 진짜 저 너무 놀랐잖아요!"

                        [Step 3. 본문 분량 및 구성]
                        - **목표 분량: 공백 포함 2,500자 이상.** (단순 요약 금지, 내용을 풍성하게 부풀릴 것)
                        - **문단 구성:** 각 소제목(content) 당 **반드시 줄바꿈(\\n\\n)을 사용하여 2~3개의 문단**으로 나눌 것.
                        - **내용 확장:** 1. 기사의 육하원칙을 상세하게 묘사.
                            2. 연예인의 과거 에피소드, 네티즌 반응, MBTI 등 TMI 대방출.

                        [Step 4. 섹션별 가이드]
                        * 섹션 1 (도입): 키워드 포함한 첫인사 + 기사를 접한 충격적인 감정 서술.
                        * 섹션 2 (팩트): 기사 내용을 현장감 있게 전달. **핵심 숫자(금액 등)는 볼드체 강조.**
                        * 섹션 3 (심화): 기사 속 상황을 독자가 눈앞에 보듯 묘사.
                        * 섹션 4 (반응): **분량 뻥튀기 구간.** 네티즌 반응 리스트업 + 과거 유사 사례 언급.
                        * 섹션 5 (후기): 진심 어린 응원과 댓글 유도.

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
    fs.writeFileSync(`${dirPath}/zloger_daum_entertainment_data.json`, JSON.stringify(results, null, 2), 'utf-8');
    // time_check.json 저장
    fs.writeFileSync(`${dirPath}/zloger_daum_entertainment_time_check.json`, JSON.stringify({ created: `${getKstIsoNow()}` }, null, 2), 'utf-8');

    await browser.close();
})();