
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
                    주어진 뉴스 기사를 재료로 삼아, 이웃들이 궁금해할 만한 정보를 아주 상세하고 친절하게 풀어주는 포스팅 데이터를 생성해줘.

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

                    [핵심 전략 1: SEO 및 키워드 최적화]
                    - 기사 내용에서 사람들이 가장 많이 검색할 법한 '메인 키워드' 1개를 스스로 추출해.
                    - newTitle(제목): 메인 키워드가 반드시 문장의 '앞부분'에 오도록 배치할 것. (예: "양말 세균(키워드), 방치하면 큰일나요" O / "큰일나는 이유는 양말 세균(키워드) 때문" X)
                    - 소제목: 5개의 소제목 중 최소 2개 이상에 메인 키워드를 포함시킬 것.
                    - 본문 내용: 메인 키워드가 전체 글에서 5~8회 자연스럽게 반복되도록 작성할 것.

                    [핵심 전략 2: 분량 확보 (글자 수 2,000자 목표)]
                    - 절대로 기사를 단순히 요약하지 마. 기사는 '소재'일 뿐이야.
                    - 기사 내용이 짧다면, 관련된 너의 '배경지식', '일반 상식', '구체적인 예시', '상황 설정'을 덧붙여서 내용을 풍성하게 불려야 해.
                    - 한 문단(content)은 최소 400자 이상, 10~12문장으로 구성해서 호흡을 길게 가져가.

                    [작성 톤앤매너]
                    - 말투: "~다/함" 금지. "그거 아세요?", "~했거든요", "~더라고요", "~인가 봐요" 같은 100% 구어체(수다 떠는 말투) 사용.
                    - 감정: "세상에..", "진짜 충격이죠?", "완전 꿀팁이네요" 같은 추임새 필수.
                    - 독자: 친한 친구에게 카톡 보낸다고 생각하고 작성.

                    [세부 작성 조건]
                    1. newTitle: 
                        - 25~32자 이내. 특수문자 제거. 호기심 자극형.

                    2. newArticle (총 5개 섹션 필수):
                        - 섹션 1 (도입부): 기사 요약 절대 금지. "오늘 뉴스 보셨나요?" 같은 질문이나, "어제 제가 겪은 일인데..." 같은 가상의 에피소드(Storytelling)로 시작. 독자의 공감을 얻고 체류시간을 늘리는 구간.
                        - 섹션 2 (배경 설명): 이 뉴스가 왜 나왔는지, 어려운 용어가 있다면 초등학생도 알기 쉽게 풀어서 설명. (배경지식 활용하여 분량 늘리기)
                        - 섹션 3 (핵심 정보): 기사의 핵심 내용을 전달하되, "예를 들어"를 사용하여 구체적인 상황을 묘사할 것.
                        - 섹션 4 (적용/팁): 독자가 이 정보를 보고 당장 실천할 수 있는 꿀팁이나 행동 요령 제시.
                        - 섹션 5 (title: '솔직한 후기'): 기사 요약 X. "앞으로 저는 이렇게 하려고요", "여러분도 꼭 챙기세요" 같은 주관적인 다짐과 1인칭 시점의 생각.

                    3. hashTag: 
                        - 본문 키워드와 연관된 태그 5~8개.

                    4. sourceCredit:
                        - "※ 본 포스팅은 [언론사명]의 기사 내용을 바탕으로 이해하기 쉽게 재구성하였습니다." (URL 제외, 텍스트만)

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