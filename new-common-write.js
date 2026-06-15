require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { generateThumbnail } = require('./image-generator');

// NOTE: This module provides a reusable writeNaverPost function.
// It assumes login/browser/context/page are handled by the caller.

async function writeNaverPost({
  page,
  blogName,
  title,
  content,
  url,
  hashTag,
  type,
  idx = 0,
  dryRun = true,
  options = {},
}) {
  if (!page) throw new Error('page is required');
  const thumbnailPath = path.resolve(`image/thumbnail_${Date.now()}.png`);
  try {
    await generateThumbnail(page, title, thumbnailPath);
  } catch (e) {
    console.warn('generateThumbnail failed', e && e.message);
  }

  await page.goto(`https://blog.naver.com/${blogName}?Redirect=Write`);
  await page.waitForSelector('iframe#mainFrame', { timeout: 15000 });
  const frame = await page.frame({ name: 'mainFrame' });
  if (!frame) throw new Error('mainFrame not found');

  // close potential popup help/cancel
  const cancelBtn = await frame.waitForSelector('button.se-popup-button.se-popup-button-cancel', { timeout: 3000 }).catch(()=>null);
  if (cancelBtn) await cancelBtn.click().catch(()=>null);
  const helpBtn = await frame.waitForSelector('article > div > header > button', { timeout: 3000 }).catch(()=>null);
  if (helpBtn) await helpBtn.click().catch(()=>null);

  const titleSelector = 'div.se-component.se-documentTitle .se-title-text p.se-text-paragraph';
  const contentParagraphSelector = 'div.se-component.se-text .se-component-content p.se-text-paragraph';
  const contentSpanSelector = 'div.se-component.se-text .se-component-content p.se-text-paragraph span.__se-node';

  await frame.click(titleSelector, { clickCount: 1, delay: 100 }).catch(()=>null);
  await frame.waitForTimeout(200);
  await frame.type(titleSelector, title || '', { delay: 60 }).catch(()=>null);

  await frame.click(contentParagraphSelector, { clickCount: 1, delay: 100 }).catch(()=>null);
  await frame.waitForTimeout(200);

  // ── 전체 본문 가운데 정렬 설정 (모바일 최적화) ─────────────────────────
  // 모바일 미리보기로 전환하면 툴바가 가려지거나 사라지므로, PC 화면 상태에서 먼저 가운데 정렬을 켜줍니다.
  try {
    const alreadyCentered = await frame.evaluate(() => {
      const activeBtn = document.querySelector('button.se-align-center-toolbar-button.se-is-selected')
                     || document.querySelector('button.se-align-center-toolbar-button');
      if (activeBtn && activeBtn.classList.contains('se-is-selected')) return true;
      return false;
    });

    if (!alreadyCentered) {
      // 1) 정렬 메뉴 열기 (프로그래밍 클릭으로 포커스 유실 방지)
      const menuOpened = await frame.evaluate(() => {
        const dropdownBtn = document.querySelector('button.se-align-left-toolbar-button')
                         || document.querySelector('button.se-align-center-toolbar-button')
                         || document.querySelector('button.se-align-right-toolbar-button')
                         || document.querySelector('button[class*="se-align-"]');
        if (dropdownBtn) {
          dropdownBtn.click();
          return true;
        }
        return false;
      });

      if (menuOpened) {
        await frame.waitForTimeout(300);
        // 2) 가운데 정렬 항목 클릭 (프로그래밍 클릭)
        const centerApplied = await frame.evaluate(() => {
          const centerBtn = document.querySelector('button.se-toolbar-option-align-center-button')
                         || document.querySelector('button.se-align-center-toolbar-button');
          if (centerBtn) {
            centerBtn.click();
            return true;
          }
          return false;
        });

        if (!centerApplied) {
          await page.keyboard.press('Escape');
        }
        await frame.waitForTimeout(200);
      }
    }
  } catch (e) {
    console.warn('Center alignment setup failed:', e && e.message);
  }

  // ── 모바일 화면 미리보기 토글 ────────────────────────────────────────
  // 가운데 정렬 적용 후 모바일 화면 모드로 토글
  try {
    const desktopModeBtn = await frame.$('button.se-util-button-device-desktop');
    if (desktopModeBtn) {
      await desktopModeBtn.click({ force: true });
      await frame.waitForTimeout(500);
    }
  } catch (e) { /* 무시 */ }

  // try to upload the generated thumbnail (skip if dryRun)
  if (!dryRun) {
    try {
      const fileChooserPromise = page.waitForEvent('filechooser');
      await frame.click('button.se-image-toolbar-button');
      const fileChooser = await fileChooserPromise;
      await fileChooser.setFiles(thumbnailPath);
      await frame.waitForTimeout(1500);
      if (fs.existsSync(thumbnailPath)) fs.unlinkSync(thumbnailPath);
    } catch (e) {
      console.warn('thumbnail upload skipped/failed', e && e.message);
    }
  }

  // ── 소제목 서식 적용 헬퍼 ──────────────────────────────────────────
  // 분석 기반: naver-editor-complete.md 참조
  async function formatSectionTitle(frame, page) {
    await frame.waitForTimeout(200);

    // 1) 소제목 줄 전체 선택 (Mac 호환)
    await page.keyboard.press('Meta+ArrowRight'); // 줄 끝으로 이동
    await frame.waitForTimeout(50);
    await page.keyboard.down('Shift');
    await page.keyboard.down('Meta');
    await page.keyboard.press('ArrowLeft'); // 시작까지 드래그 선택
    await page.keyboard.up('Meta');
    await page.keyboard.up('Shift');
    await frame.waitForTimeout(150);

    // Bold 적용 (Cmd+B)
    await page.keyboard.press('Meta+b');
    await frame.waitForTimeout(200);

    // 2) 색상 적용을 위해 다시 소제목 줄 선택 (Mac 호환)
    await page.keyboard.press('Meta+ArrowRight');
    await frame.waitForTimeout(50);
    await page.keyboard.down('Shift');
    await page.keyboard.down('Meta');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.up('Meta');
    await page.keyboard.up('Shift');
    await frame.waitForTimeout(150);

    // 3) 글자색 (#1e6fff 파란색) 적용
    try {
      const colorBtn = await frame.$('button.se-font-color-toolbar-button');
      if (colorBtn) {
        await colorBtn.click();
        await frame.waitForTimeout(500);

        // 팔레트 내 파란색(#1e6fff) 직접 클릭 시도 (선택 유실 방지 및 고속 적용)
        const blueColorBtn = await frame.$('button.se-color-palette[data-color="#1e6fff"]')
                          || await frame.$('button.se-color-palette[data-color="#1E6FFF"]');
        
        if (blueColorBtn) {
          await blueColorBtn.click({ force: true });
          await frame.waitForTimeout(300);
        } else {
          // Fallback: 더보기 클릭 및 input 주입 방식
          const moreBtn = await frame.locator('button').filter({ hasText: '더보기' }).first();
          if (await moreBtn.count() > 0) {
            await moreBtn.click({ force: true });
            await frame.waitForTimeout(400);

            const colorApplied = await frame.evaluate((color) => {
              const input = document.querySelector('input.se-selected-color-hex');
              if (!input) return false;
              const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
              nativeInputValueSetter.call(input, color);
              input.dispatchEvent(new Event('input', { bubbles: true }));
              input.dispatchEvent(new Event('change', { bubbles: true }));
              return true;
            }, '1e6fff');

            if (colorApplied) {
              await page.keyboard.press('Enter');
              await frame.waitForTimeout(300);
            } else {
              await page.keyboard.press('Escape');
            }
          } else {
            await page.keyboard.press('Escape');
          }
        }
      }
    } catch (e) {
      console.warn('Failed to apply title color:', e && e.message);
    }

    // 커서를 End로 이동 (선택 해제)
    await page.keyboard.press('Meta+ArrowRight');
    await frame.waitForTimeout(80);
  }

  // ── 인용구 삽입 헬퍼 ────────────────────────────────────────────────
  async function insertQuotation(frame, page, titleText, contentText, style = 'line') {
    try {
      // 1) 인용구 화살표 버튼을 클릭해 드롭다운을 엽니다. (실패 시 메인 버튼으로 대체)
      let arrowBtn = await frame.$('div[data-name="insert-quotation"] button.se-document-toolbar-select-option-button');
      if (!arrowBtn) {
        arrowBtn = await frame.$('button.se-insert-quotation-default-toolbar-button');
      }
      
      if (arrowBtn) {
        await arrowBtn.click({ force: true });
        await frame.waitForTimeout(500);

        let styleSelector = `button.se-toolbar-option-insert-quotation-quotation_${style}-button`;
        let styleBtn = await frame.$(styleSelector);
        if (!styleBtn) {
          styleSelector = `button.se-insert-menu-sub-panel-button-quotation-quotation_${style}`;
          styleBtn = await frame.$(styleSelector);
        }
        
        if (styleBtn) {
          await styleBtn.click({ force: true });
          await frame.waitForTimeout(600);

          if (titleText) {
            await page.keyboard.type(titleText, { delay: 20 });
            await frame.waitForTimeout(100);
            
            // 제목 굵게 만들기 (Mac 호환)
            await page.keyboard.down('Shift');
            await page.keyboard.down('Meta');
            await page.keyboard.press('ArrowLeft');
            await page.keyboard.up('Meta');
            await page.keyboard.up('Shift');
            await frame.waitForTimeout(100);
            await page.keyboard.press('Meta+b');
            await frame.waitForTimeout(100);
            await page.keyboard.press('Meta+ArrowRight');
            await frame.waitForTimeout(50);

            await page.keyboard.press('Enter');
            await frame.waitForTimeout(100);
          }
          if (contentText) {
            const qLines = contentText.split('\n');
            for (let qli = 0; qli < qLines.length; qli++) {
              const qLine = qLines[qli].trim();
              if (qLine) {
                await page.keyboard.type(qLine, { delay: 6 });
                await frame.waitForTimeout(100);
              }
              if (qli < qLines.length - 1) {
                await page.keyboard.down('Shift');
                await page.keyboard.press('Enter');
                await page.keyboard.up('Shift');
                await frame.waitForTimeout(100);
              }
            }
          }

          // 인용구 컴포넌트 밖으로 이동
          await page.keyboard.press('ArrowDown');
          await frame.waitForTimeout(100);
          await page.keyboard.press('ArrowDown');
          await frame.waitForTimeout(100);
          
          await frame.click('div.se-canvas-bottom').catch(() => null);
          await frame.waitForTimeout(200);
        }
      }
    } catch (e) {
      console.warn('insertQuotation failed', e);
    }
  }

  // ── 스티커 삽입 헬퍼 ────────────────────────────────────────────────
  async function insertSticker(frame, page) {
    try {
      const stickerBtn = await frame.$('button.se-sticker-toolbar-button');
      if (stickerBtn) {
        await stickerBtn.click({ force: true });
        await frame.waitForTimeout(600);

        // 첫 번째 스티커 아이템 클릭
        const stickerItem = await frame.$('div.se-sidebar-panel-content-sticker ul.se-sidebar-list.se-is-on li button');
        if (stickerItem) {
          await stickerItem.click({ force: true });
          await frame.waitForTimeout(600);
        }

        // ESC 키로 스티커 사이드바 닫기
        await page.keyboard.press('Escape');
        await frame.waitForTimeout(300);

        // 커서를 아래로 이동하고 줄바꿈
        await page.keyboard.press('ArrowDown');
        await frame.waitForTimeout(100);
        await page.keyboard.press('Enter');
        await frame.waitForTimeout(100);
      }
    } catch (e) {
      console.warn('insertSticker failed', e);
    }
  }

  // ── 구분선 삽입 헬퍼 ────────────────────────────────────────────────
  // 확인된 클래스: se-insert-horizontal-line-default-toolbar-button (insertionWorked: true)
  async function insertDivider(frame, page) {
    try {
      const dividerBtn = await frame.$('button[class*="se-insert-horizontal-line"]');
      if (dividerBtn) {
        await dividerBtn.click();
        await frame.waitForTimeout(400);
      }
    } catch (e) { /* 무시 */ }
  }

  // write content: support array of sections or string
  if (Array.isArray(content)) {
    for (let si = 0; si < content.length; si++) {
      const section = content[si];
      
      const fancy = options.fancyStyle !== false;
      
      // 섹션 수가 3개 이상이고 fancyStyle이 활성화되어 있을 때 첫 섹션은 line 인용구, 마지막 섹션은 postit 인용구로 처리
      if (fancy && content.length >= 3 && si === 0) {
        await insertQuotation(frame, page, section.title, section.content, 'line');
        // 다음 섹션을 위해 한 번 더 구분선 삽입
        await insertDivider(frame, page);
        await frame.waitForTimeout(200);
      } else if (fancy && content.length >= 3 && si === content.length - 1) {
        // 마지막 아웃트로 전에 귀여운 스티커 삽입
        await insertSticker(frame, page);
        await frame.waitForTimeout(200);
        await insertQuotation(frame, page, section.title, section.content, 'postit');
      } else {
        // 일반 섹션 처리
        if (section.title) {
          // 소제목 입력
          await page.keyboard.type(section.title, { delay: 30 });
          await frame.waitForTimeout(100);
          // 서식 적용 (Bold + 16pt + 파란색)
          await formatSectionTitle(frame, page);
          await frame.waitForTimeout(100);
          // 줄바꿈
          await page.keyboard.press('Enter');
          await frame.waitForTimeout(80);
        }
        if (section.content) {
          const lines = section.content.split('\n');
          for (let li = 0; li < lines.length; li++) {
            const line = lines[li].trim();
            if (line) {
              await page.keyboard.type(line, { delay: 6 });
              await frame.waitForTimeout(80);
            }
            if (li < lines.length - 1) {
              await page.keyboard.press('Enter');
              await frame.waitForTimeout(80);
            }
          }
          await page.keyboard.press('Enter');
          await frame.waitForTimeout(80);
        }
        // 다음 일반 섹션으로 넘어가기 전 구분선 삽입
        if (si < content.length - 1) {
          // fancy 스타일일 때 다음 섹션이 마지막 섹션이면 인용구로 처리되므로 구분선 생략
          if (fancy && content.length >= 3 && si === content.length - 2) {
            // 생략
          } else {
            await insertDivider(frame, page);
            await frame.waitForTimeout(200);
          }
        }
      }
    }
  } else if (typeof content === 'string') {
    const lines = content.split('\n');
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li].trim();
      if (line) {
        await page.keyboard.type(line, { delay: 6 });
        await frame.waitForTimeout(80);
      }
      if (li < lines.length - 1) {
        await page.keyboard.press('Enter');
        await frame.waitForTimeout(80);
      }
    }
  }


  // hashtag
  if (hashTag && Array.isArray(hashTag) && hashTag.length) {
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type(hashTag.join(' '), { delay: 40 });
    await page.keyboard.press('Enter');
  }

  // character image upload (optional)
  try {
    const charImagePath = path.resolve(`image/${blogName}/${new Date().getDay()}.png`);
    if (!dryRun && fs.existsSync(charImagePath)) {
      const fileChooserPromise = page.waitForEvent('filechooser');
      await frame.click('button.se-image-toolbar-button');
      const fileChooser = await fileChooserPromise;
      await fileChooser.setFiles(charImagePath);
      await frame.waitForTimeout(1500);
      // attempt to set representative image (best-effort)
      const images = await frame.$$('.se-module-image');
      if (images && images.length) {
        await images[0].click().catch(()=>null);
        await frame.waitForTimeout(500);
        const repBtn = await frame.$('button.se-toolbar-option-visible-representative-button');
        if (repBtn) await repBtn.click().catch(()=>null);
      }
    }
  } catch (e) {
    // ignore
  }

  // publish flow: open publish modal, choose reservation, set time, category, then final publish
  try {
    const publishBtnSelector = 'div.header__Ceaap > div > div.publish_btn_area__KjA2i > div:nth-child(2) > button';
    await frame.waitForSelector(publishBtnSelector, { timeout: 10000 });
    await frame.click(publishBtnSelector).catch(()=>null);
  } catch (e) {
    // best-effort
  }

  // reservation
  try {
    const reservationLabel = frame.locator('label', { hasText: '예약' }).last();
    await reservationLabel.click().catch(()=>null);
  } catch (e) {
    await frame.click('#radio_time2').catch(()=>null);
  }
  await frame.waitForTimeout(500);

  // time calculation
  const group = Math.floor(idx / 2);
  const baseTime = new Date();
  baseTime.setMinutes(baseTime.getMinutes() + 10 + group * 10);
  let hour = baseTime.getHours();
  let minute = baseTime.getMinutes();
  minute = Math.ceil(minute / 10) * 10;
  if (minute === 60) { minute = 0; hour += 1; }
  if (hour === 24) hour = 0;
  const hourStr = hour.toString().padStart(2, '0');
  const minuteStr = minute.toString().padStart(2, '0');
  await frame.selectOption('select.hour_option__J_heO', hourStr).catch(()=>null);
  await frame.selectOption('select.minute_option__Vb3xB', minuteStr).catch(()=>null);

  // category selection (caller may pass typeMap in options)
  try {
    const typeMap = options.typeMap || {};
    const categoryName = typeMap[type] || type;
    if (categoryName) {
      await frame.click('button[aria-label="카테고리 목록 버튼"]').catch(()=>null);
      await frame.click(`span[data-testid^="categoryItemText_"]:text("${categoryName}")`).catch(()=>null);
    }
  } catch (e) {
    // ignore
  }

  const finalPublishBtnSelector = 'div.layer_btn_area__UzyKH > div > button';
  if (!dryRun) {
    await frame.waitForSelector(finalPublishBtnSelector, { timeout: 10000 }).catch(()=>null);
    await frame.click(finalPublishBtnSelector).catch(()=>null);
  } else {
    console.log('dry-run: skipped final publish for', title);
  }
}

module.exports = {
  writeNaverPost,
};
