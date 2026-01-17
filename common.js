const axios = require('axios');
// const fs = require('fs');

// ... (existing helper functions) ...

const getCoupangLink = async () => {
  const moment = require('moment');
  let coupangShortenUrl = null;
  let isCoupangToday = false;
  const COUPANG_JSON_URL = 'https://raw.githubusercontent.com/ggpt6choi-coder/blogman/main/data/coupang.json';

  try {
    const response = await axios.get(COUPANG_JSON_URL);
    // axios는 response.data에 바로 JSON 데이터가 있음
    const coupangData = response.data;

    if (coupangData && coupangData.length > 0) {
      // 첫 번째 데이터 사용 (가장 최근 것)
      const item = coupangData[0];
      const executedDate = moment(item.executedAt).format('YYYY-MM-DD');
      const todayDate = moment().format('YYYY-MM-DD');

      if (executedDate === todayDate) {
        isCoupangToday = true;
        coupangShortenUrl = item.shortenUrl;
        logWithTime(`[Coupang] 오늘 생성된 링크 발견: ${coupangShortenUrl}`);
      } else {
        logWithTime(`[Coupang] 오늘 날짜가 아님 (Executed: ${executedDate}, Today: ${todayDate})`);
      }
    } else {
      logWithTime('[Coupang] 데이터가 비어있습니다.');
    }
  } catch (err) {
    logWithTime(`[Coupang] 데이터 읽기 오류: ${err.message}`);
  }

  if (!isCoupangToday) {
    logWithTime('쿠팡 실행 조건 불만족: 오늘 생성된 링크가 없습니다.', '❌')
    process.exit(0);
  }

  return coupangShortenUrl;
}
const logWithTime = (message, sticker = '🤖') => {
  const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  console.log(`${sticker}[${now}] ${message}`);
};

//✅ 날짜시간 포맷팅 함수(반환값: 'YYYY-MM-DDTHH:mm:ss+09:00' 형태의 KST ISO 문자열)
const getKstIsoNow = () => {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  const kst = new Date(utc + 9 * 60 * 60000);
  const Y = kst.getFullYear();
  const M = String(kst.getMonth() + 1).padStart(2, '0');
  const D = String(kst.getDate()).padStart(2, '0');
  const h = String(kst.getHours()).padStart(2, '0');
  const m = String(kst.getMinutes()).padStart(2, '0');
  const s = String(kst.getSeconds()).padStart(2, '0');
  return `${Y}-${M}-${D}T${h}:${m}:${s}+09:00`;
};

//✅ 현재시간으로부터 1시간 이내인지 확인하는 함수
function isWithinLastHour(timestampStr) {
  if (!/^\d{17}$/.test(timestampStr)) {
    throw new Error("형식 오류: YYYYMMDDHHmmssSSS 형식의 문자열을 입력해야 합니다.");
  }

  // 문자열을 날짜 객체로 변환
  const year = parseInt(timestampStr.slice(0, 4));
  const month = parseInt(timestampStr.slice(4, 6)) - 1; // 0부터 시작
  const day = parseInt(timestampStr.slice(6, 8));
  const hour = parseInt(timestampStr.slice(8, 10));
  const minute = parseInt(timestampStr.slice(10, 12));
  const second = parseInt(timestampStr.slice(12, 14));
  const ms = parseInt(timestampStr.slice(14, 17));

  const inputDate = new Date(year, month, day, hour, minute, second, ms);
  const now = new Date();

  const diffMs = now - inputDate; // 밀리초 단위 차이
  const oneHourMs = 60 * 60 * 1000;

  // 현재 시간보다 과거이고, 1시간 이내면 true
  return diffMs >= 0 && diffMs <= oneHourMs;
}


const loadLinks = async () => {
  const url = "https://raw.githubusercontent.com/ggpt6choi-coder/blogman/refs/heads/main/adv-item-links.json";
  try {
    const response = await axios.get(url);
    const data = response.data;
    return data.links; // JSON 구조에 따라 조정
  } catch (error) {
    console.error("Error loading links:", error);
    return [];
  }
};

//✅ 네이버 커넥트 URL 가져오는 함수(로컬)
// JSON 파일에서 링크를 불러오는 함수
// const loadLinks = () => {
//   return new Promise((resolve, reject) => {
//     fs.readFile('adv-item-links.json', 'utf8', (err, data) => {
//       if (err) {
//         reject(err);
//       } else {
//         resolve(JSON.parse(data).links); // links 배열만 반환
//       }
//     });
//   });
// };

// getAdItemLink 함수 수정 (비동기 처리)
const getAdItemLink = async () => {
  try {
    const links = await loadLinks(); // 링크 배열 불러오기
    return links[Math.floor(Math.random() * links.length)];
  } catch (error) {
    console.error('Error loading links:', error);
    return null; // 오류가 발생하면 null 반환
  }
};

//✅ 링크 카드 처리 함수(링크 삽입하고 제품 나오고 링크 삭제)
async function insertLinkAndRemoveUrl(frame, page, selector, url) {
  if (!url) return;

  // 0. 기존 링크 카드 개수 확인 (선택자 확대)
  const linkSelector = '.se-module-oglink, .se-oglink-info, .se-oglink';
  const getLinkCardCount = async () => {
    return await frame.$$eval(linkSelector, els => els.length);
  };
  const initialCount = await getLinkCardCount();

  // 1. URL 입력 및 엔터 (링크 카드 생성 유도)
  // frame.type은 selector에 해당하는 첫 번째 요소로 포커스를 옮기기 때문에, 
  // 글이 길어지면 맨 위로 올라가는 문제가 있음. 현재 커서 위치에 입력하기 위해 keyboard.type 사용.
  await page.keyboard.type(url, { delay: 40 });
  await page.keyboard.press('Enter');

  // 2. 새 링크 카드 생성 대기 (매뉴얼 폴링)
  // 개수가 initialCount보다 커질 때까지 루프
  let newCount = initialCount;
  let retries = 0;
  const maxRetries = 20; // 500ms * 20 = 10초

  while (retries < maxRetries) {
    await frame.waitForTimeout(500);
    newCount = await getLinkCardCount();

    if (newCount > initialCount) {
      break;
    }
    retries++;
  }

  if (newCount <= initialCount) {
    // 진행을 위해 엔터 한번 더 (혹시 텍스트만 남아있을 수 있으니)
    await page.keyboard.press('Enter');
    return; // 삭제 로직 진행 불가
  }

  // 3. 스마트 삭제 로직
  // 마지막 요소가 아니라 역순으로 탐색하여 "최신" 링크 카드를 찾음
  try {
    const components = await frame.$$('.se-component');

    let linkIndex = -1;
    // 뒤에서부터 3개 정도만 확인해보자 (보통 마지막이나 그 앞임)
    for (let i = components.length - 1; i >= Math.max(0, components.length - 5); i--) {
      const comp = components[i];
      const classAttr = await comp.getAttribute('class');
      if (classAttr && (classAttr.includes('se-oglink') || classAttr.includes('se-module-oglink'))) {
        linkIndex = i;
        break;
      }
    }

    if (linkIndex !== -1 && linkIndex > 0) {
      // 바로 위 요소(URL 텍스트 추정) 확인
      const prevComp = components[linkIndex - 1];
      let prevText = await prevComp.innerText();
      prevText = prevText ? prevText.trim() : "";

      if ((prevText && prevText.includes(url)) || (prevText.startsWith('http'))) {
        // 커서 위치 계산
        // 현재 커서는 맨 마지막 컴포넌트(엔터로 생긴 빈 줄)에 있을 가능성이 높음
        // 이동해야 할 횟수 = (전체길이 - 1 - 링크인덱스) + 1 (링크위로가야하니까)
        const movesUp = (components.length - 1 - linkIndex) + 1;

        for (let k = 0; k < movesUp; k++) {
          await page.keyboard.press('ArrowUp');
          await frame.waitForTimeout(50);
        }

        // 이제 커서는 [URL 텍스트 라인]에 위치해야 함

        await page.keyboard.press('Meta+ArrowRight'); // 줄 끝
        await page.keyboard.down('Shift');
        await page.keyboard.down('Meta');
        await page.keyboard.press('ArrowLeft'); // 전체 선택
        await page.keyboard.up('Meta');
        await page.keyboard.up('Shift');

        await frame.waitForTimeout(100);
        await page.keyboard.press('Backspace'); // 삭제

        // 다시 원위치로 복귀
        // 원래 위치(맨 아래 빈 줄)로 돌아오려면 Down을 movesUp 만큼 하면 됨
        // 하지만 삭제되었으므로 컴포넌트 하나가 줄었음.
        // 또한 링크 카드를 지나쳐야 함.
        // 여기서 안전하게 "엔터"를 칠 수 있는 곳으로 가야함.
        // 링크 카드 아래로 이동
        await page.keyboard.press('ArrowDown'); // 링크 카드로 이동
        await page.keyboard.press('ArrowDown'); // 그 다음 줄(빈 줄)
        // await page.keyboard.press('Enter');
      }
    }
  } catch (e) {
    await page.keyboard.press('Enter');
  }
  await frame.waitForTimeout(1000);
}

//✅ 문구와 URL을 입력받아 스타일 적용 후 링크 삽입하는 함수
const writeStyledLink = async (page, frame, text, url) => {
  // 텍스트 입력
  await page.keyboard.type(text, { delay: 50 });
  await frame.waitForTimeout(200);

  // 텍스트 선택 (Shift + Home)
  await page.keyboard.down('Shift');
  await page.keyboard.press('Home');
  await page.keyboard.up('Shift');
  await frame.waitForTimeout(300);

  // [스타일 적용] 굵게 / 글자 크기 / 색상 / 가운데 정렬
  try {
    // 1. 굵게 (Cmd+B)
    await page.keyboard.down('Meta');
    await page.keyboard.press('b');
    await page.keyboard.up('Meta');
    await frame.waitForTimeout(200);

    // 2. 글자 크기 키우기 (34px)
    // 툴바에서 글자 크기 버튼 찾기
    try {
      // 유저 제보: li.se-toolbar-item-font-size-code > div > button
      const fontSizeBtnSelector = 'li.se-toolbar-item-font-size-code button';
      const fontSizeBtn = await frame.$(fontSizeBtnSelector);

      if (fontSizeBtn) {
        await fontSizeBtn.click();
        await frame.waitForTimeout(300);

        // 34px 선택 (se-toolbar-option-font-size-code-fs34-button)
        const sizeOptionSelector = 'button.se-toolbar-option-font-size-code-fs19-button';
        const sizeOption = await frame.$(sizeOptionSelector);

        if (sizeOption) {
          await sizeOption.click();
        } else {
          // 혹시 클래스명이 다를 수 있으니 fs34 포함하는거 찾기
          const fallbackOption = await frame.$('button[class*="fs34"]');
          if (fallbackOption) await fallbackOption.click();
        }
        await frame.waitForTimeout(200);
      } else {
        // 기존 셀렉터 fallback
        const oldBtn = await frame.$('button.se-font-size-toolbar-button');
        if (oldBtn) await oldBtn.click();
      }
    } catch (e) {
      // console.log('글자 크기 변경 실패:', e.message);
    }

    // 3. 글자 색상 변경 (빨강색 #ff0010)
    try {
      const colorBtn = await frame.$('button.se-font-color-toolbar-button');
      if (colorBtn) {
        await colorBtn.click();
        await frame.waitForTimeout(300);

        // 유저 제보: button.se-color-palette[data-color="#ff0010"]
        const redColorSelector = 'button.se-color-palette[data-color="#ff0010"]';
        const redColorBtn = await frame.$(redColorSelector);

        if (redColorBtn) {
          await redColorBtn.click();
        } else {
          // 못 찾으면 기존 방식(2번째)
          const colorOptions = await frame.$$('.se-popup-color-layer button');
          if (colorOptions.length > 1) await colorOptions[1].click();
        }
        await frame.waitForTimeout(200);
      }
    } catch (e) {
      // console.log('글자 색상 변경 실패:', e.message);
    }

    // 4. 글자 배경색 변경 (연한 노랑 #fff593)
    try {
      const bgColorBtn = await frame.$('button.se-background-color-toolbar-button');
      if (bgColorBtn) {
        await bgColorBtn.click();
        await frame.waitForTimeout(300);

        const yellowBgBtn = await frame.$('button.se-color-palette[data-color="#fff593"]');
        if (yellowBgBtn) {
          await yellowBgBtn.click();
        }
        await frame.waitForTimeout(200);
      }
    } catch (e) {
      // console.log('글자 배경색 변경 실패:', e.message);
    }

    // 5. 가운데 정렬
    try {
      const alignCenterBtn = await frame.$('button.se-align-center-toolbar-button');
      if (alignCenterBtn) {
        await alignCenterBtn.click();
      } else {
        // 그룹 안에 있을 경우
        const alignGroupBtn = await frame.$('button.se-align-group-toggle-toolbar-button');
        if (alignGroupBtn) {
          await alignGroupBtn.click();
          await frame.waitForTimeout(300);
          const realCenterBtn = await frame.$('button.se-align-center-toolbar-button');
          if (realCenterBtn) await realCenterBtn.click();
        }
      }
      await frame.waitForTimeout(200);
    } catch (e) {
      // console.log('가운데 정렬 실패:', e.message);
    }

  } catch (e) {
    // console.log('스타일 적용 중 오류:', e.message);
  }

  // 링크 삽입 시도
  try {
    // 툴바의 링크 버튼 찾기
    const linkBtnSelector = '.se-l-property-toolbar .se-toolbar-item-link button';
    const linkBtn = await frame.$(linkBtnSelector);

    if (linkBtn) {
      // console.log('링크 버튼 찾음, 클릭 시도');
      await linkBtn.click();
    } else {
      // console.log('링크 버튼 못 찾음, 단축키(Cmd+K) 시도');
      await page.keyboard.down('Meta');
      await page.keyboard.press('k');
      await page.keyboard.up('Meta');
    }

    await frame.waitForTimeout(1000); // 팝업 대기

    // 링크 입력창 대기
    const linkInputSelector = '.se-toolbar-item-link input';
    try {
      await frame.waitForSelector(linkInputSelector, { timeout: 3000 });
      // console.log('링크 입력창 뜸');
      await frame.type(linkInputSelector, url, { delay: 50 });
      await page.keyboard.press('Enter'); // 링크 적용
      await frame.waitForTimeout(500);

      // 팝업 닫기 (혹시 남아있을 경우)
      await page.keyboard.press('Escape');
      await frame.waitForTimeout(300);

      // console.log('제품 링크 삽입 완료');
    } catch (e) {
      // console.log('링크 입력창 Timeout:', e.message);
      await page.keyboard.press('Escape');
    }
  } catch (e) {
    // console.log('링크 삽입 과정 중 오류:', e.message);
  }

  // 링크 삽입 후 다음 줄로 이동
  await page.keyboard.press('Escape'); // 팝업 닫기 (안전장치)
  await frame.waitForTimeout(200);

  // [수정] 엔터 키가 선택된 텍스트를 지우는 문제 해결
  // 대신 에디터 하단 여백을 클릭하여 강제로 새 줄 생성
  try {
    await frame.click('div.se-canvas-bottom', { force: true });
    // console.log('에디터 하단 클릭 (새 줄 생성)');
  } catch (e) {
    // console.log('하단 클릭 실패, 엔터 시도:', e.message);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
  }
  await frame.waitForTimeout(500);

  // 줄바꿈 확인을 위해 공백 하나 입력 (이미지 업로드 시 덮어쓰기 방지)
  await page.keyboard.type('');
  await frame.waitForTimeout(200);

  // [추가] 원복 전에 엔터를 쳐서 다음 줄로 이동
  await page.keyboard.press('Enter');
  await frame.waitForTimeout(200);
};

//✅ 스타일 초기화 함수 (검정색 / 15px / 굵게 해제 / 왼쪽 정렬)
const resetStyle = async (frame) => {
  try {
    // 1. 글자 색상 복구 (검정색 #000000)
    try {
      const colorBtn = await frame.$('button.se-font-color-toolbar-button');
      if (colorBtn) {
        await colorBtn.click();
        await frame.waitForTimeout(100);
        const blackColorBtn = await frame.$('button.se-color-palette[data-color="#000000"]');
        if (blackColorBtn) {
          await blackColorBtn.click();
        } else {
          const colorOptions = await frame.$$('.se-popup-color-layer button');
          if (colorOptions.length > 0) await colorOptions[0].click();
        }
        await frame.waitForTimeout(100);
      }
    } catch (e) { }

    // 2. 글자 배경색 초기화 (색상 없음)
    try {
      const bgColorBtn = await frame.$('button.se-background-color-toolbar-button');
      if (bgColorBtn) {
        await bgColorBtn.click();
        await frame.waitForTimeout(100);
        const noColorBtn = await frame.$('button.se-color-palette-no-color');
        if (noColorBtn) {
          await noColorBtn.click();
        }
        await frame.waitForTimeout(100);
      }
    } catch (e) { }

    // 3. 글자 크기 복구 (15px)
    try {
      const fontSizeBtnSelector = 'li.se-toolbar-item-font-size-code button';
      // 툴바 버튼 찾기 시도
      let fontSizeBtn = await frame.$(fontSizeBtnSelector);
      if (!fontSizeBtn) fontSizeBtn = await frame.$('button.se-font-size-toolbar-button');

      if (fontSizeBtn) {
        await fontSizeBtn.click();
        await frame.waitForTimeout(100);
        // 15px (se-toolbar-option-font-size-code-fs15-button or .se-toolbar-option-font-size-15)
        const sizeOption15 = await frame.$('button.se-toolbar-option-font-size-code-fs15-button, button.se-toolbar-option-font-size-15');
        if (sizeOption15) {
          await sizeOption15.click();
        } else {
          // 텍스트로 찾기 (fallback)
          const options = await frame.$$('ul.se-toolbar-list-font-size button');
          for (const opt of options) {
            if ((await opt.innerText()).trim() === '15') {
              await opt.click();
              break;
            }
          }
        }
        await frame.waitForTimeout(100);
      }
    } catch (e) { }

    // 4. 굵게 해제 (se-is-selected 클래스 확인)
    try {
      const boldBtnSelector = 'li.se-toolbar-item-bold button';
      const boldBtn = await frame.$(boldBtnSelector);
      if (boldBtn) {
        const classAttr = await boldBtn.getAttribute('class');
        if (classAttr && classAttr.includes('se-is-selected')) {
          await boldBtn.click();
          await frame.waitForTimeout(100);
        }
      }
    } catch (e) { }

    // 5. 왼쪽 정렬 (기본값 복구)
    try {
      // 정렬 메뉴 열기 (필요시)
      const alignDropdownSelector = 'li.se-toolbar-item-align > div > button';
      const alignDropdownBtn = await frame.$(alignDropdownSelector);

      // 왼쪽 정렬 버튼: se-toolbar-option-align-left-button
      const alignLeftSelector = 'button.se-toolbar-option-align-left-button';

      if (alignDropdownBtn) {
        await alignDropdownBtn.click();
        await frame.waitForTimeout(200);
        const alignLeftBtn = await frame.$(alignLeftSelector);
        if (alignLeftBtn) await alignLeftBtn.click();
      } else {
        // 이미 툴바에 나와있을 수도 있음
        const alignLeftBtn = await frame.$(alignLeftSelector);
        if (alignLeftBtn) await alignLeftBtn.click();
      }
    } catch (e) { }

  } catch (e) {
    // console.log('스타일 원복 실패:', e.message);
  }
};

//✅ Gemini 응답 파싱 헬퍼 함수
const parseGeminiResponse = (raw) => {
  let parsedData = null;
  try {
    // 1. Try parsing raw directly
    parsedData = JSON.parse(raw);
  } catch (jsonErr) {
    // 2. Try cleaning markdown code blocks (case-insensitive)
    let cleanRaw = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
    try {
      parsedData = JSON.parse(cleanRaw);
    } catch (e2) {
      // 3. Try extracting json object with regex
      const firstBrace = cleanRaw.indexOf('{');
      const lastBrace = cleanRaw.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1) {
        const jsonCandidate = cleanRaw.substring(firstBrace, lastBrace + 1);
        try {
          parsedData = JSON.parse(jsonCandidate);
        } catch (e3) {
          console.log('JSON parsing failed even with substring extraction. Raw:', raw);
        }
      } else {
        console.log('JSON parsing failed. Raw:', raw);
      }
    }
  }
  return parsedData;
};


module.exports = { logWithTime, getKstIsoNow, isWithinLastHour, getAdItemLink, getCoupangLink, writeStyledLink, resetStyle, parseGeminiResponse, insertLinkAndRemoveUrl };
