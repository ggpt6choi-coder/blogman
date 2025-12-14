
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

            // 6. GEMINI API로 통합 가공 (제목, 본문, 해시태그)
            let newTitle = '';
            let newArticle = '';
            let hashTag = [];

            if (article !== '[본문 없음]' && article.length !== 0 && title !== '[제목 없음]') {
                try {
                    const prompt = `
                    너는 네이버 블로그를 운영하는 친근하고 소통을 잘하는 '인기 블로거'야.
                    다음 뉴스 기사를 바탕으로 이웃들에게 정보를 공유하는 블로그 포스팅 데이터를 생성해줘.
                    
                    결과는 반드시 아래의 JSON 포맷으로만 출력해줘. 다른 말은 절대 하지 마.

                    {
                        "newTitle": "블로그용 제목",
                        "newArticle": [
                            {"title": "소제목1", "content": "내용1"},
                            {"title": "소제목2", "content": "내용2"}
                        ],
                        "hashTag": ["#태그1", "#태그2", ...]
                    }

                    [작성 톤앤매너 - 중요!]
                    - 말투: "~다.", "~함." 같은 딱딱한 문어체나 뉴스 말투 절대 금지.
                    - "~해요", "~했거든요", "~더라고요", "~인가 봐요" 같은 부드러운 '해요체' 구어체 사용.
                    - 감정 표현: "정말 놀랐어요", "다들 공감하시죠?", "큰일 날 뻔했네요" 같은 추임새를 자연스럽게 섞을 것.
                    - 독자 설정: 친한 친구나 이웃에게 이야기하듯이 작성.

                    [작성 조건]
                    1. newTitle (제목):
                        - 네이버 블로그 검색 최적화된 제목 (25~35자)
                        - 클릭을 유도하되 낚시성이 아닌 호기심 자극형
                        - 특수문자 제거, 뉴스 제목 그대로 사용 금지
                        - 예시: "매일 신는 양말, 하루 더 신었다가 충격받은 이유 (발 건강 관리 꿀팁)"

                    2. newArticle (본문):
                        - 총 4~6개의 문단으로 구성 (전체 1500자 이상)
                        - 각 소제목(title)은 핵심 키워드 포함 15자 이내의 흥미로운 문장형 (예: "양말 속 세균이 이렇게 많다고?")
                        - 각 내용(content)은 줄바꿈 없이 자연스럽게 이어지는 300~500자의 줄글
                        
                        * 첫 번째 문단(content): 기사 요약이 아닌, 이 주제와 관련된 가벼운 실수담이나 질문으로 시작할 것. (예: "어제 귀찮아서 그냥 잤는데...")
                        * 중간 문단들(content): 기사 정보를 전달하되, 어려운 용어는 쉽게 풀어서 설명하고 독자의 공감을 유도할 것.
                        * 마지막 문단(title: '솔직한 후기'): '개인적인 생각'이라는 제목 대신 '솔직한 후기', '주관적인 생각' 등으로 하고, 기사 내용을 요약하지 말 것. 대신 "앞으로 이렇게 해야겠다", "저도 예전에 이런 적이 있었는데 고생했다"는 식의 '가상의 경험'이나 '다짐'을 1인칭 시점으로 구체적으로 작성.

                        - 기사와 관련 없는 광고, 기자 정보, 언론사 명칭 등은 완벽히 제거
                        - 마크업, 리스트 기호 사용 금지 (오직 텍스트만)

                    3. hashTag (해시태그):
                        - 본문 내용과 밀접한 연관이 있는 감성적인 태그 포함 5~8개
                        - 예: #생활꿀팁 #솔직후기 #건강관리 등

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
    fs.writeFileSync(`${dirPath}/daum_entertainment_data.json`, JSON.stringify(results, null, 2), 'utf-8');
    // time_check.json 저장
    fs.writeFileSync(`${dirPath}/daum_entertainment_time_check.json`, JSON.stringify({ created: `${getKstIsoNow()}` }, null, 2), 'utf-8');

    await browser.close();
})();