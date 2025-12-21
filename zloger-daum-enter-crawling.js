
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
                    // 연예 뉴스에 특화된 3가지 페르소나 (그대로 유지)
                    const concepts = [
                        "주접킹 팬심 모드: '우리 오빠 미모 무슨 일이야'라며 비주얼과 매력을 찬양하고 감정을 과몰입해서 표현하는 열성 팬 스타일.",
                        "방구석 1열 리포터 모드: '대박 사건 터졌네요', '네티즌 반응은 이렇습니다' 처럼 이슈의 흐름을 생동감 있게 전달하는 유튜버 스타일.",
                        "TMI 수집가 모드: 해당 연예인의 과거 작품, 유사한 사례, 비하인드 스토리 등 지식과 정보를 엮어서 설명해주는 연예계 척척박사 스타일."
                    ];

                    // const randomConcept = concepts[Math.floor(Math.random() * concepts.length)];
                    const randomConcept = 0;

                    const prompt = `
                        너는 네이버 블로그 로직을 완벽히 이해하는 '인기 연예 블로거'야.
                        주어진 기사를 재료로, 이웃들이 클릭하고 싶어지는 포스팅 데이터를 생성해줘.

                        [🔴 작성 컨셉: "${randomConcept}"]
                        - 위 컨셉에 맞춰 말투와 리액션을 연기하되, **검색 최적화(SEO)** 규칙은 무조건 지켜야 해.

                        결과는 반드시 아래의 JSON 포맷으로만 출력해.

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

                        [Step 1. 제목(newTitle) 작성 절대 규칙]
                        - **특수문자, 이모지(😊), 괄호(), ㅠㅠ, ㅋㅋ 절대 금지.** (느낌표 ! 물음표 ? 는 1개만 허용)
                        - 기사 내용에서 **'메인 키워드(연예인명/프로그램명)'**와 **'서브 키워드(이슈 내용)'**를 추출.
                        - 형식: "[메인 키워드] [서브 키워드] 관련 호기심 문구"
                        - 예시: "전현무 대상 소감 박나래 언급 없었던 진짜 이유" (O)
                        - 예시: "전현무 대상!! ㅠㅠ 박나래는?? (대박)" (X - 특수문자 과다)

                        [Step 2. 본문(newArticle) 키워드 배치 전략]
                        - 총 5개 섹션, 전체 2,000자 목표.
                        - **메인 키워드**는 전체 글에서 5~8회, **서브 키워드**는 3~5회 반드시 포함시킬 것.
                        - 대명사("그는", "이 프로그램은") 대신 **고유명사("전현무 씨는", "나 혼자 산다는")**를 사용할 것.

                        [Step 3. 섹션별 구성 가이드]
                        * 섹션 1 (도입): 인사말 + **메인 키워드** 언급 + [작성 컨셉]에 맞는 리액션.
                        * 섹션 2 (상황): 사건의 전말을 초등학생도 알기 쉽게 설명. (육하원칙)
                        * 섹션 3 (이슈): 기사의 핵심 내용 + **서브 키워드** 포함하여 상세 풀이.
                        * 섹션 4 (TMI/반응): 기사에 없는 **과거 작품, 네티즌 반응, 연관 에피소드** 등 풍부한 배경지식 방출. (분량 확보 핵심)
                        * 섹션 5 (생각): 1인칭 시점의 감상평. (요약 금지)

                        [Step 4. 톤앤매너]
                        - 100% 구어체 사용 ("~했어요", "~더라고요").
                        - 문장은 길게 쓰되, 호흡이 끊기지 않도록 접속사 활용.
                        - 이모지는 본문(content) 안에만 적절히 사용. (제목에는 절대 사용 금지)

                        [Step 5. 기타]
                        - hashTag: 연예인 이름, 프로그램명, 관련 이슈 등 5~8개.
                        - sourceCredit: "※ 본 포스팅은 [언론사명]의 보도 내용을 바탕으로 재구성하였습니다." (텍스트만)

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