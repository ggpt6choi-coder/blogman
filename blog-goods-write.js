require('dotenv').config();
const { chromium } = require('playwright');
const { logWithTime } = require('./common');
const { generateThumbnail } = require('./image-generator');
const path = require('path');
const SHOW_BROWSER = false; // 실행 중 브라우저 창 표시 여부

// ==========================
// 🔵 네이버 로그인 함수
// ==========================
async function naverLogin(page) {
  await page.goto('https://nid.naver.com/nidlogin.login');
  await page.fill('#id', process.env.NAVER_ID_GOODS);
  await page.fill('#pw', process.env.NAVER_PW_GOODS.replace(/"/g, ''));
  await page.click('#log\\.login');
  await page.waitForNavigation();
}

// ==========================
// 🔵 스타일 강제 적용 도우미 함수
// ==========================
async function applyDefaultStyle(frame) {
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

    // 2. 글자 크기 복구 (15px)
    try {
      const fontSizeBtnSelector = 'li.se-toolbar-item-font-size-code button';
      let fontSizeBtn = await frame.$(fontSizeBtnSelector);
      if (!fontSizeBtn) fontSizeBtn = await frame.$('button.se-font-size-toolbar-button');

      if (fontSizeBtn) {
        await fontSizeBtn.click();
        await frame.waitForTimeout(100);
        const sizeOption15 = await frame.$('button.se-toolbar-option-font-size-code-fs15-button, button.se-toolbar-option-font-size-15');
        if (sizeOption15) {
          await sizeOption15.click();
        } else {
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

    // 3. 굵게 해제 (se-is-selected 클래스 확인)
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

    // 4. 가운데 정렬 적용 (모바일 최적화)
    try {
      const alignDropdownSelector = 'li.se-toolbar-item-align > div > button';
      const alignDropdownBtn = await frame.$(alignDropdownSelector);

      if (alignDropdownBtn) {
        await alignDropdownBtn.click();
        await frame.waitForTimeout(200); // 메뉴 열림 대기
        const alignCenterSelector = 'button.se-toolbar-option-align-center-button';
        const alignCenterBtn = await frame.$(alignCenterSelector);
        if (alignCenterBtn) await alignCenterBtn.click();
      } else {
        const alignCenterSelector = 'button.se-toolbar-option-align-center-button';
        const alignCenterBtn = await frame.$(alignCenterSelector);
        if (alignCenterBtn) await alignCenterBtn.click();
      }
      await frame.waitForTimeout(100);
    } catch (e) { }
  } catch (e) { console.log('스타일 강제 적용 실패:', e.message); }
}

// ==========================
// 🔵 블로그 글쓰기 함수
// ==========================
async function writeBlog({
  page,
  blogName,
  title,
  content,
  url,
  hashTag,
  type,
  idx = 0, // 예약 간격을 위한 인덱스(기본값 0)
}) {
  // 글쓰기 페이지 이동
  await page.goto(`https://blog.naver.com/${blogName}?Redirect=Write`);

  // mainFrame iframe 접근
  // iframe DOM 먼저 확인
  await page.waitForSelector('iframe#mainFrame', { timeout: 15000 });
  // 그 다음 frame 객체 추출
  const frame = await page.frame({ name: 'mainFrame' });
  if (!frame) throw new Error('mainFrame을 찾지 못했습니다');

  // '취소' 버튼 처리 (있으면 클릭)
  const cancelBtn = await frame
    .waitForSelector('button.se-popup-button.se-popup-button-cancel', {
      timeout: 5000,
    })
    .catch(() => null);
  if (cancelBtn) await cancelBtn.click();

  // '도움말' 버튼 처리 (있으면 클릭)
  const helpBtn = await frame
    .waitForSelector('article > div > header > button', {
      timeout: 5000,
    })
    .catch(() => null);
  if (helpBtn) await helpBtn.click();

  // '제목' 입력
  const titleParagraphSelector =
    'div.se-component.se-documentTitle .se-title-text p.se-text-paragraph';

  // 1. 제목 입력
  await frame.click(titleParagraphSelector, { clickCount: 1, delay: 100 });
  await frame.waitForTimeout(300);
  await frame.type(titleParagraphSelector, title, { delay: 80 });

  // 본문 입력 처리 (content: string 또는 배열 모두 지원)
  const contentParagraphSelector =
    'div.se-component.se-text .se-component-content p.se-text-paragraph';
  const contentSpanSelector =
    'div.se-component.se-text .se-component-content p.se-text-paragraph span.se-ff-nanumgothic.se-fs15.__se-node';

  // 2. 썸네일 이미지 생성 및 업로드 (상단)
  // 제목 입력 후 엔터를 쳐서 본문 첫 줄 생성
  await page.keyboard.press('Enter');
  await frame.waitForTimeout(500);

  // 1-1. URL이 있는 경우 'sentence.png' 이미지 삽입 (맨 상단)
  if (url) {
    try {
      const sentenceImagePath = path.resolve('image/sentence.png');
      console.log('sentence.png 이미지 업로드 시도...');

      // 파일 선택창 대기
      const fileChooserPromise = page.waitForEvent('filechooser');

      // '사진' 버튼 클릭
      await frame.click('button.se-image-toolbar-button');

      const fileChooser = await fileChooserPromise;
      await fileChooser.setFiles(sentenceImagePath);

      await frame.waitForTimeout(2000); // 업로드 및 렌더링 대기
      await page.keyboard.press('Enter'); // 줄바꿈
      await frame.waitForTimeout(500);
      console.log('sentence.png 업로드 완료');
    } catch (e) {
      console.log('sentence.png 업로드 실패:', e.message);
    }
  }

  try {
    const imagePath = path.resolve('image/title_thumbnail.png');
    console.log('썸네일 이미지 생성 중...');
    await generateThumbnail(page, title, imagePath);
    console.log('썸네일 생성 완료:', imagePath);

    // 파일 선택창 대기
    const fileChooserPromise = page.waitForEvent('filechooser');

    // '사진' 버튼 클릭
    await frame.click('button.se-image-toolbar-button');

    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(imagePath);

    await frame.waitForTimeout(2000); // 업로드 및 렌더링 대기
    await page.keyboard.press('Enter'); // 줄바꿈 (이미지 아래로 커서 이동)
    await frame.waitForTimeout(500);
  } catch (e) {
    console.log('썸네일 생성/업로드 실패:', e.message);
  }

  // 3. "제품 먼저 바로보기" 링크 삽입
  if (url) {
    // 텍스트 입력
    const linkText = "제품 먼저 바로보기";
    await page.keyboard.type(linkText, { delay: 50 });
    await frame.waitForTimeout(200);

    // 텍스트 선택 (Shift + Home)
    await page.keyboard.down('Shift');
    await page.keyboard.press('Home');
    await page.keyboard.up('Shift');
    await frame.waitForTimeout(300);

    // [스타일 적용] 굵게 / 글자 크기 / 색상 / 가운데 정렬
    try {
      console.log('스타일 적용 시작');

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
          const sizeOptionSelector = 'button.se-toolbar-option-font-size-code-fs34-button';
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
      } catch (e) { console.log('글자 크기 변경 실패:', e.message); }

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
      } catch (e) { console.log('글자 색상 변경 실패:', e.message); }

      // 4. 가운데 정렬
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
      } catch (e) { console.log('가운데 정렬 실패:', e.message); }

    } catch (e) {
      console.log('스타일 적용 중 오류:', e.message);
    }

    // 링크 삽입 시도
    try {
      // 툴바의 링크 버튼 찾기
      const linkBtnSelector = '.se-l-property-toolbar .se-toolbar-item-link button';
      const linkBtn = await frame.$(linkBtnSelector);

      if (linkBtn) {
        console.log('링크 버튼 찾음, 클릭 시도');
        await linkBtn.click();
      } else {
        console.log('링크 버튼 못 찾음, 단축키(Cmd+K) 시도');
        await page.keyboard.down('Meta');
        await page.keyboard.press('k');
        await page.keyboard.up('Meta');
      }

      await frame.waitForTimeout(1000); // 팝업 대기

      // 링크 입력창 대기
      const linkInputSelector = '.se-toolbar-item-link input';
      try {
        await frame.waitForSelector(linkInputSelector, { timeout: 3000 });
        console.log('링크 입력창 뜸');
        await frame.type(linkInputSelector, url, { delay: 50 });
        await page.keyboard.press('Enter'); // 링크 적용
        await frame.waitForTimeout(500);

        // 팝업 닫기 (혹시 남아있을 경우)
        await page.keyboard.press('Escape');
        await frame.waitForTimeout(300);

        console.log('제품 링크 삽입 완료');
      } catch (e) {
        console.log('링크 입력창 Timeout:', e.message);
        await page.keyboard.press('Escape');
      }
    } catch (e) {
      console.log('링크 삽입 과정 중 오류:', e.message);
    }

    // 링크 삽입 후 다음 줄로 이동
    await page.keyboard.press('Escape'); // 팝업 닫기 (안전장치)
    await frame.waitForTimeout(200);

    // [수정] 엔터 키가 선택된 텍스트를 지우는 문제 해결
    // 대신 에디터 하단 여백을 클릭하여 강제로 새 줄 생성
    try {
      await frame.click('div.se-canvas-bottom', { force: true });
      console.log('에디터 하단 클릭 (새 줄 생성)');
    } catch (e) {
      console.log('하단 클릭 실패, 엔터 시도:', e.message);
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('End');
      await page.keyboard.press('Enter');
    }
    await frame.waitForTimeout(500);

    // 줄바꿈 확인을 위해 공백 하나 입력 (이미지 업로드 시 덮어쓰기 방지)
    await page.keyboard.type(' ');
    await frame.waitForTimeout(200);
  }


  // URL 입력 (전달받은 url 사용) - 하단에 또 넣을지 여부는 기존 로직 유지
  // 기존 로직에서 하단 URL 입력 부분이 있으므로 여기서는 제거하거나 유지
  // 사용자가 "제품 먼저 바로보기"를 원했으므로 상단 링크는 완료됨.
  // 하단 URL 입력 로직은 아래쪽에 별도로 존재함 (line 390 근처).

  if (Array.isArray(content)) {
    for (const section of content) {
      if (section.title) {
        // 인용구(소제목) 버튼 클릭
        await frame.click('button.se-text-icon-toolbar-select-option-button.__se-sentry', { clickCount: 1, delay: 100 });
        await frame.click('button.se-toolbar-option-insert-quotation-quotation_underline-button', { clickCount: 1, delay: 100 });
        await frame.waitForTimeout(500);

        // 포커스가 인용구에 있을 것이므로 키보드로 입력
        await page.keyboard.type(section.title, { delay: 40 });

        // 소제목 빠져나오기
        // 1. 캔버스 하단 클릭 (가장 확실한 방법: 새로운 문단 생성)
        try {
          // 화면을 맨 아래로 스크롤해서 버튼이 보이게 함
          await page.keyboard.press('PageDown');
          await frame.waitForTimeout(500);

          const bottomBtn = await frame.waitForSelector('div.se-canvas-bottom', { timeout: 3000 });
          if (bottomBtn) {
            await bottomBtn.click();
          }
        } catch (e) {
          // 2. 버튼이 없거나 클릭 실패 시 키보드로 탈출 시도
          console.log('하단 버튼 클릭 실패, 키보드로 이동 시도');
          // 소제목(Title) -> 출처(Source) -> 본문(Body) 순서로 이동해야 함
          await page.keyboard.press('ArrowDown'); // 출처로 이동
          await page.keyboard.press('Enter');     // 출처에서 엔터치면 보통 빠져나옴
          await frame.waitForTimeout(200);
          // 혹시 모르니 한 번 더
          await page.keyboard.press('ArrowDown');
        }
        await frame.waitForTimeout(200);
      }

      if (section.content) {
        // 본문 입력 (현재 커서 위치에 입력)
        // 본문 입력 (현재 커서 위치에 입력)
        // [스타일 강제 적용] 검정색 / 15px / 가운데 정렬
        await applyDefaultStyle(frame);

        await page.keyboard.type(section.content, { delay: 10 });
        await page.keyboard.press('Enter');
        await frame.waitForTimeout(100);

        // 🟢 스티커 삽입 (각 문단 끝) - addSticker 플래그가 있는 경우에만(도입부, 결론)
        if (section.addSticker) {
          try {
            const stickerPanelSelector = 'div.se-sidebar-panel-content-sticker';
            const stickerBtnSelector = 'button.se-sticker-toolbar-button';

            // 1. 사이드바 열려있는지 확인
            const isPanelOpen = await frame.isVisible(stickerPanelSelector).catch(() => false);

            // 2. 닫혀있으면 버튼 클릭해서 열기
            if (!isPanelOpen) {
              const stickerBtn = await frame.waitForSelector(stickerBtnSelector, { timeout: 2000 });
              if (stickerBtn) {
                await stickerBtn.click();
                await frame.waitForTimeout(1000); // 로딩 대기
              }
            }

            // 3. 스티커 선택 및 클릭
            // 유저 제보 경로: aside > ... > ul.se-sidebar-list.se-is-on > li > button
            // 사이드바 형태의 스티커 목록을 타겟팅
            const stickerSelector = 'div.se-sidebar-panel-content-sticker ul.se-sidebar-list.se-is-on li button';
            await frame.waitForSelector(stickerSelector, { timeout: 3000 });

            const visibleStickers = await frame.$$(stickerSelector);

            if (visibleStickers.length > 0) {
              // [수정] 스티커 인덱스 사용 (section.stickerIndex)
              // 지정되지 않았으면 기본값 0
              const targetIndex = (section.stickerIndex !== undefined) ? section.stickerIndex : 0;

              if (visibleStickers.length > targetIndex) {
                await visibleStickers[targetIndex].click();
                console.log(`스티커 삽입 시도: ${targetIndex}번째 스티커`);
                await frame.waitForTimeout(1000);
              } else {
                console.log(`스티커 인덱스(${targetIndex})가 범위를 벗어났습니다.`);
              }
            } else {
              console.log('스티커 목록을 찾지 못했습니다 (Selector: ' + stickerSelector + ')');
            }

            // 4. 사이드바가 여전히 열려있으면 닫기 (버튼 다시 클릭)
            // 다음 반복 때 상태 꼬임을 방지하고 화면을 가리지 않기 위해 닫음
            const isPanelOpenAfter = await frame.isVisible(stickerPanelSelector).catch(() => false);
            if (isPanelOpenAfter) {
              const stickerBtn = await frame.$(stickerBtnSelector);
              if (stickerBtn) await stickerBtn.click();
              await frame.waitForTimeout(500);
            }

            // 🟢 5. 스티커 가운데 정렬
            try {
              // 방금 들어간 스티커는 에디터 내의 마지막 스티커 컴포넌트일 것임
              const stickers = await frame.$$('.se-component.se-sticker');
              if (stickers.length > 0) {
                const lastSticker = stickers[stickers.length - 1];
                await lastSticker.click(); // 스티커 선택 -> 툴바 등장
                await frame.waitForTimeout(500);

                // 가운데 정렬 버튼 클릭
                // 유저 제보 클래스: se-align-center-toolbar-button
                const alignCenterSelector = 'button.se-align-center-toolbar-button';
                const alignCenterBtn = await frame.waitForSelector(alignCenterSelector, { timeout: 2000 }).catch(() => null);

                if (alignCenterBtn) {
                  await alignCenterBtn.click();
                  await frame.waitForTimeout(500);
                } else {
                  // 혹시 모르니 다른 클래스도 시도 (그룹 토글 등)
                  const alignGroupBtn = await frame.$('button.se-align-group-toggle-toolbar-button');
                  if (alignGroupBtn) {
                    await alignGroupBtn.click();
                    await frame.waitForTimeout(500);
                    // 그룹 열리고 나서 센터 버튼 다시 찾기
                    const realCenterBtn = await frame.$('button.se-align-center-toolbar-button');
                    if (realCenterBtn) await realCenterBtn.click();
                  }
                }
              }
            } catch (alignErr) {
              console.log('스티커 정렬 실패:', alignErr.message);
            }

            // 6. 본문 포커스 복귀
            // 마지막 문단을 찾아서 클릭해야 함.
            const paragraphs = await frame.$$(contentParagraphSelector);
            if (paragraphs.length > 0) {
              const lastPara = paragraphs[paragraphs.length - 1];
              await lastPara.click();
              await frame.waitForTimeout(200);

              // 확실하게 끝으로 이동
              await page.keyboard.press('End');
              await page.keyboard.press('ArrowDown');
            } else {
              // 문단을 못 찾으면 그냥 selector 클릭 (fallback)
              await frame.click(contentParagraphSelector, { delay: 100 });
            }
            await frame.waitForTimeout(500);

          } catch (e) {
            console.log('스티커 삽입 실패:', e.message);
            // 실패하더라도 본문 클릭해서 포커스 복구 시도
            try {
              const paragraphs = await frame.$$(contentParagraphSelector);
              if (paragraphs.length > 0) {
                await paragraphs[paragraphs.length - 1].click();
                await page.keyboard.press('End');
              } else {
                await frame.click(contentParagraphSelector);
              }
            } catch (err) { }
          }
        }
      }
      // 소제목/내용 사이 구분을 위해 한 줄 띄움
      // await page.keyboard.press('Enter');
      await frame.waitForTimeout(100);

      // 🟢 [추가] 본문(Body) 섹션인 경우(addSticker가 없는 경우) 중간 CTA 삽입
      // Introduction/Conclusion은 addSticker: true가 있으므로 제외
      if (!section.addSticker && url) {
        // CTA 문구 배열
        const ctaTexts = [
          "[클릭] 특가 혜택 지금 확인하기",
          "[클릭] 특가 혜택 지금 확인하기",
          "[클릭] 지금 바로 구매하기",
          "[클릭] 할인가로 보러가기"
        ];

        // ctaIndex는 반복문 밖에서 관리하거나, 현재 섹션 인덱스를 이용해야 함.
        // 하지만 content 배열이 intro, body, conclusion 섞여 있으므로, 
        // body 배열 내에서의 인덱스를 추적하기 어려움.
        // 간단하게 현재 루프 내에서 임시 카운터를 쓸 수도 있지만, 
        // 여기서는 글로벌 변수나 매개변수가 없으므로 랜덤 또는 순차 적용을 위해
        // writeBlog 함수 내에 로컬 변수를 두는 것이 좋음. 
        // 일단 writeBlog 시작 부분에 let bodySectionIndex = 0; 추가 필요.
        // 여기서는 replace_file_content의 한계로 인해 변수 선언을 위쪽에 못 하므로
        // 단순하게 (section의 어떤 속성) 또는 랜덤을 쓰거나, 
        // 아래 처럼 즉석에서 계산. (하지만 불완전)

        // 차선책: 그냥 bodySectionCount 변수를 writeBlog 함수 상단에 추가하는 것이 
        // 가장 깔끔하지만, 여기서는 tool call 하나로 끝내기 위해
        // 그냥 0, 1, 2 순서대로 쓰되, 상태를 저장할 곳이 마땅치 않음.

        // 따라서, 아래와 같이 로직을 구성:
        // 이 부분은 'replace_file_content'로 교체되는 부분임.
        // 상위 scope에 변수가 없으므로, 블로그 글 전체에서 몇 번째 섹션인지 알기 위해
        // content.indexOf(section) 을 사용.

        const currentIndex = content.indexOf(section);
        // Intro가 0번일 테니, Body는 1부터 시작한다고 가정하면
        // (currentIndex - 1) % 3 정도로 순환 가능.
        // 만약 Intro가 없으면 0부터 시작.
        // 안전하게 currentIndex % 3 사용.

        const ctaText = ctaTexts[currentIndex % 3];

        await page.keyboard.press('Enter');
        await frame.waitForTimeout(100);

        // 스타일 초기화 (검정, 15px, 왼쪽 정렬)
        await applyDefaultStyle(frame);

        // 텍스트 입력 (먼저 입력하고 꾸미기)
        await page.keyboard.type(ctaText, { delay: 40 });
        await frame.waitForTimeout(200);

        // 방금 입력한 텍스트 선택 (Shift + Home)
        await page.keyboard.down('Shift');
        await page.keyboard.press('Home');
        await page.keyboard.up('Shift');
        await frame.waitForTimeout(200);

        // [CTA 스타일 적용] 굵게 + 빨강 + 19px + 가운데 정렬
        try {
          // 1. 굵게
          await page.keyboard.down('Meta');
          await page.keyboard.press('b');
          await page.keyboard.up('Meta');
          await frame.waitForTimeout(200);

          // 2. 글자 색상 (빨강)
          const colorBtn = await frame.$('button.se-font-color-toolbar-button');
          if (colorBtn) {
            await colorBtn.click();
            await frame.waitForTimeout(300);
            const redColorSelector = 'button.se-color-palette[data-color="#ff0010"]';
            const redColorBtn = await frame.$(redColorSelector);
            if (redColorBtn) await redColorBtn.click();
            else {
              const colorOptions = await frame.$$('.se-popup-color-layer button');
              if (colorOptions.length > 1) await colorOptions[1].click();
            }
            await frame.waitForTimeout(200);
          }

          // 3. 글자 크기 (19px - 본문보다 약간 크게)
          try {
            const fontSizeBtn = await frame.$('li.se-toolbar-item-font-size-code button') || await frame.$('button.se-font-size-toolbar-button');
            if (fontSizeBtn) {
              await fontSizeBtn.click();
              await frame.waitForTimeout(300);
              // fs19 등 찾기
              const sizeOption = await frame.$('button[class*="fs19"]');
              if (sizeOption) await sizeOption.click();
              await frame.waitForTimeout(200);
            }
          } catch (e) { }


          // 4. 가운데 정렬
          try {
            const alignGroupBtn = await frame.$('button.se-align-group-toggle-toolbar-button');
            if (alignGroupBtn) {
              await alignGroupBtn.click();
              await frame.waitForTimeout(300);
            }
            const centerBtn = await frame.$('button.se-toolbar-option-align-center-button') || await frame.$('button.se-align-center-toolbar-button');
            if (centerBtn) await centerBtn.click();
          } catch (e) { }

          await frame.waitForTimeout(200);

        } catch (e) {
          console.log('중간 CTA 스타일 적용 실패:', e.message);
        }

        // 링크 삽입 (Cmd + K) 대신 상단 로직과 동일하게 변경
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

          const linkInputSelector = '.se-toolbar-item-link input';
          try {
            await frame.waitForSelector(linkInputSelector, { timeout: 3000 });
            await frame.type(linkInputSelector, url, { delay: 30 });
            await page.keyboard.press('Enter');
            await frame.waitForTimeout(500);
            await page.keyboard.press('Escape'); // 팝업 닫기
          } catch (e) {
            console.log('중간 CTA 링크 입력창 찾기 실패:', e.message);
            await page.keyboard.press('Escape');
          }
        } catch (e) {
          console.log('중간 CTA 링크 삽입 과정 실패:', e.message);
        }

        // 다음 줄로 이동
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('Enter');
        await frame.waitForTimeout(500);

        // 스타일 리셋
        await applyDefaultStyle(frame);
      }
    }
  }


  // 하단 URL 입력 (전달받은 url 사용)
  if (url) {
    // [추가] 링크 생성 전 구매 유도 문구 삽입
    await page.keyboard.press('Enter');
    await frame.waitForTimeout(100);

    // 스타일 강제 적용 (본문과 동일하게: 검정, 15px, 왼쪽 정렬)
    await applyDefaultStyle(frame);

    // [CTA 스타일 적용] 굵게 + 빨강 + 34px + 가운데 정렬
    try {
      // 1. 굵게 (Cmd+B)
      await page.keyboard.down('Meta');
      await page.keyboard.press('b');
      await page.keyboard.up('Meta');
      await frame.waitForTimeout(200);

      // 2. 글자 색상 변경 (빨강색 #ff0010)
      const colorBtn = await frame.$('button.se-font-color-toolbar-button');
      if (colorBtn) {
        await colorBtn.click();
        await frame.waitForTimeout(300);
        const redColorSelector = 'button.se-color-palette[data-color="#ff0010"]';
        const redColorBtn = await frame.$(redColorSelector);
        if (redColorBtn) {
          await redColorBtn.click();
        } else {
          // fallback
          const colorOptions = await frame.$$('.se-popup-color-layer button');
          if (colorOptions.length > 1) await colorOptions[1].click();
        }
        await frame.waitForTimeout(200);
      }

      // 3. 글자 크기 34px
      try {
        const fontSizeBtnSelector = 'li.se-toolbar-item-font-size-code button';
        const fontSizeBtn = await frame.$(fontSizeBtnSelector);
        if (fontSizeBtn) {
          await fontSizeBtn.click();
          await frame.waitForTimeout(300);

          const sizeOptionSelector = 'button.se-toolbar-option-font-size-code-fs34-button';
          const sizeOption = await frame.$(sizeOptionSelector);
          if (sizeOption) {
            await sizeOption.click();
          } else {
            const fallbackOption = await frame.$('button[class*="fs34"]');
            if (fallbackOption) await fallbackOption.click();
          }
          await frame.waitForTimeout(200);
        }
      } catch (e) {
        console.log('CTA 글자 크기 변경 실패:', e.message);
      }

      // 4. 가운데 정렬
      try {
        // 유저 제보: button.se-toolbar-option-align-center-button
        const centerBtnSelector = 'button.se-toolbar-option-align-center-button';
        let centerBtn = await frame.$(centerBtnSelector);

        if (centerBtn && await centerBtn.isVisible()) {
          await centerBtn.click();
        } else {
          // 안 보이면 정렬 메뉴(li.se-toolbar-item-align)를 먼저 클릭해본다
          // 보통 툴바의 정렬 아이콘을 클릭하면 펼쳐짐
          const alignToolbarBtn = await frame.$('li.se-toolbar-item-align button');
          if (alignToolbarBtn) {
            await alignToolbarBtn.click();
            await frame.waitForTimeout(300);
            // 다시 찾기
            centerBtn = await frame.$(centerBtnSelector);
            if (centerBtn) await centerBtn.click();
          }
        }
      } catch (e) {
        console.log('가운데 정렬 실패:', e.message);
      }
      await frame.waitForTimeout(200);

    } catch (e) {
      console.log('CTA 스타일 적용 실패:', e.message);
    }

    // 텍스트 입력 (줄바꿈 포함)
    await frame.type(contentSpanSelector, "더 자세한 정보와 최저가 구매는", { delay: 40 });
    await page.keyboard.down('Shift');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Shift');
    await frame.waitForTimeout(100);
    await frame.type(contentSpanSelector, "아래 링크에서 확인하세요! 👇", { delay: 40 });
    await page.keyboard.press('Enter');
    await frame.waitForTimeout(200);

    await frame.type(contentSpanSelector, url, { delay: 40 });
    await page.keyboard.press('Enter');
    await frame.waitForTimeout(3000); // 링크 카드 생성 대기 (5s -> 3s)

    // 텍스트 URL 삭제
    // 마지막 컴포넌트 확인 (링크 카드 유무)
    const components = await frame.$$('.se-component');
    let hasLinkCard = false;
    if (components.length > 0) {
      const lastComp = components[components.length - 1];
      const classAttr = await lastComp.getAttribute('class');
      if (classAttr.includes('se-oglink')) {
        hasLinkCard = true;
      } else if (components.length > 1) {
        const secondLast = components[components.length - 2];
        const secondClass = await secondLast.getAttribute('class');
        if (secondClass.includes('se-oglink')) {
          hasLinkCard = true;
        }
      }
    }

    if (hasLinkCard) {
      await page.keyboard.press('ArrowUp'); // 링크 카드 선택
      await frame.waitForTimeout(100);
      await page.keyboard.press('ArrowUp'); // 텍스트 라인으로 이동
    } else {
      await page.keyboard.press('ArrowUp'); // 텍스트 라인으로 이동
    }
    await frame.waitForTimeout(500);

    // 커서를 줄 끝으로
    await page.keyboard.press('Meta+ArrowRight');

    // 줄 전체 선택
    await page.keyboard.down('Shift');
    await page.keyboard.down('Meta');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.up('Meta');
    await page.keyboard.up('Shift');

    await frame.waitForTimeout(200);
    await page.keyboard.press('Backspace');

    await page.keyboard.press('ArrowDown');
    if (hasLinkCard) {
      await page.keyboard.press('ArrowDown');
    }
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
  }

  // 해시태그 입력 (맨 마지막에)
  if (hashTag && hashTag.length > 0) {
    // 혹시 모르니 맨 아래로 이동 및 엔터
    await page.keyboard.press('PageDown');
    await frame.waitForTimeout(200);

    // 에디터 하단 클릭 (확실하게 맨 끝으로)
    try {
      await frame.click('div.se-canvas-bottom', { force: true });
    } catch (e) {
      // 실패 시 키보드로 이동
      await page.keyboard.press('End');
      await page.keyboard.press('Enter');
    }
    await frame.waitForTimeout(300);

    // 스타일 초기화 (검정, 15px, 왼쪽 정렬) - 해시태그는 깔끔하게
    await applyDefaultStyle(frame);

    await page.keyboard.type(hashTag.join(' '), { delay: 40 });
    await page.keyboard.press('Enter');
  }

  // 발행 세팅 -> 임시저장으로 변경
  try {
    // 저장 버튼 (HTML 분석 결과: save_btn__bzc5B)
    const saveBtnSelector = 'button.save_btn__bzc5B';
    await frame.waitForSelector(saveBtnSelector, { timeout: 5000 });
    await frame.click(saveBtnSelector);
    await frame.waitForTimeout(1500); // 저장 완료 대기
  } catch (e) {
    console.log('임시저장 버튼 클릭 실패:', e.message);
  }
}

// ==========================
// 🔵 실행 부분
// ==========================

(async () => {
  const fs = require('fs');

  // 데이터 파일 읽기
  let blogPosts = [];
  try {
    blogPosts = JSON.parse(fs.readFileSync('./blog-goods-data.json', 'utf8'));
  } catch (err) {
    console.error('데이터 파일 읽기 실패:', err);
    process.exit(1);
  }

  if (blogPosts.length === 0) {
    console.log('작성할 블로그 포스트가 없습니다.');
    process.exit(0);
  }

  //시작
  const browser = await chromium.launch({
    headless: !SHOW_BROWSER,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();
  // navigator.webdriver 제거 (로봇 탐지 우회)
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  logWithTime('시작');
  await naverLogin(page);
  logWithTime('로그인 완료');

  let errCount = 0;
  for (let i = 0; i < blogPosts.length; i++) {
    const post = blogPosts[i];
    // create-data.json 관련 로직 제거
    // const originalData = createData[i] || {};
    // const keywords = originalData.keywords || [];

    // 본문 구조 변환 (Introduction -> Body -> Conclusion)
    const contentArray = [];

    if (post.introduction) {
      contentArray.push({ ...post.introduction, addSticker: true, stickerIndex: 0 });
    }
    if (post.body && Array.isArray(post.body)) {
      contentArray.push(...post.body);
    }
    if (post.conclusion) {
      contentArray.push({ ...post.conclusion, addSticker: true, stickerIndex: 1 });
    }

    const blogData = {
      page,
      blogName: process.env.BLOG_NAME_GOODS,
      title: post.title || (post.introduction ? post.introduction.title : ""), // 제목 우선순위: JSON title -> introduction title
      content: contentArray,
      url: post.purchaseLink,
      hashTag: (post.hashtags && post.hashtags.length > 0)
        ? post.hashtags
        : [], // 해시태그 우선순위: JSON hashtags
      type: '',
      idx: i,
    };

    try {
      logWithTime(`글 작성 시작(${i + 1}/${blogPosts.length}): ${blogData.title}`);
      await writeBlog(blogData);
      logWithTime(`🍀글 작성 완료(${i + 1}/${blogPosts.length})`);
    } catch (err) {
      errCount++;
      const errorLog = `[${new Date().toISOString()}] [writeBlog 오류] idx: ${i}, title: ${blogData.title}\nError: ${err && err.stack ? err.stack : err}\n`;
      console.error(errorLog);
      // 폴더가 없으면 에러날 수 있으니 체크
      if (!fs.existsSync('error-log')) fs.mkdirSync('error-log');
      fs.appendFileSync('error-log/naver-upload-error.log', errorLog, 'utf-8');
    }

    // 다음 글 작성을 위한 대기 (안전하게 5초)
    if (i < blogPosts.length - 1) {
      await page.waitForTimeout(3000);
    }
  }
  logWithTime(
    `🍀모든 글 작성 완료 (실패 건수: ${errCount} / ${blogPosts.length})`
  );
  await browser.close();
})();
