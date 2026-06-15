require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');
const feedsConfig = require('./new-feeds-config');

/**
 * 네이버 블로그 에디터 완전 분석 스크립트
 * 
 * 실행: node analyze-editor.js
 * 결과: naver-editor-complete.md 파일에 저장
 */
(async () => {
  const cfg = feedsConfig.k1;
  const blogName = process.env[cfg.blogEnv];

  const browser = await chromium.launch({ headless: false, slowMo: 50 });
  const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' });
  const page = await context.newPage();

  await page.goto('https://nid.naver.com/nidlogin.login');
  console.log('⏳ 로그인해주세요...');
  await page.waitForURL(url => !url.href.includes('nidlogin'), { timeout: 120000 });
  console.log('✅ 로그인 완료!');

  await page.goto(`https://blog.naver.com/${blogName}?Redirect=Write`);
  await page.waitForSelector('iframe#mainFrame', { timeout: 20000 });
  const frame = await page.frame({ name: 'mainFrame' });
  await frame.waitForTimeout(2000);

  const cancelBtn = await frame.$('button.se-popup-button.se-popup-button-cancel');
  if (cancelBtn) await cancelBtn.click().catch(() => null);
  await frame.waitForTimeout(500);

  const result = { sections: {} };

  // ──────────────────────────────────────────────────────────────────
  // 1. 상단 문서 툴바 (Document Toolbar) 버튼 목록
  // ──────────────────────────────────────────────────────────────────
  console.log('\n📌 [1] 상단 문서 툴바 분석...');
  result.sections.documentToolbar = await frame.evaluate(() => {
    return [...document.querySelectorAll('button[class*="toolbar-button"]')]
      .filter(b => !b.className.includes('property'))
      .map(b => ({
        text: b.textContent.trim().replace(/(.+)\1/, '$1'), // 중복 텍스트 제거
        classList: [...b.classList].filter(c => c.includes('toolbar') || c.includes('button')),
        selector: (() => {
          const cls = [...b.classList].find(c => c.startsWith('se-') && c.endsWith('-button'));
          return cls ? `button.${cls}` : null;
        })(),
      }));
  });

  // ──────────────────────────────────────────────────────────────────
  // 2. 본문 텍스트 입력 후 하단 Property Toolbar 분석
  // ──────────────────────────────────────────────────────────────────
  console.log('📌 [2] 본문 입력 후 Property Toolbar 분석...');
  const spanSel = 'div.se-component.se-text .se-component-content p.se-text-paragraph span.__se-node';
  await frame.click('div.se-component.se-text .se-component-content p.se-text-paragraph').catch(() => null);
  await frame.waitForTimeout(300);
  await frame.type(spanSel, '분석용 텍스트입니다', { delay: 30 });
  await frame.waitForTimeout(300);

  // 텍스트 선택
  await page.keyboard.press('End');
  await page.keyboard.down('Shift');
  await page.keyboard.press('Home');
  await page.keyboard.up('Shift');
  await frame.waitForTimeout(300);

  result.sections.propertyToolbar = await frame.evaluate(() => {
    const toolbar = document.querySelector('.se-l-property-toolbar');
    if (!toolbar) return { found: false };
    return {
      found: true,
      containerClass: toolbar.className,
      buttons: [...toolbar.querySelectorAll('button')].map(b => ({
        text: b.textContent.trim().replace(/(.+)\1/, '$1'),
        classList: [...b.classList],
        specificClass: [...b.classList].find(c => c.startsWith('se-') && !c.includes('property') && !c.includes('sentry')),
      })),
    };
  });

  // ──────────────────────────────────────────────────────────────────
  // 3. Bold 버튼 클릭 → 동작 확인
  // ──────────────────────────────────────────────────────────────────
  console.log('📌 [3] Bold 버튼 동작 테스트...');
  const boldBtn = await frame.$('button.se-bold-toolbar-button');
  result.sections.bold = { found: !!boldBtn, selector: 'button.se-bold-toolbar-button' };
  if (boldBtn) {
    await boldBtn.click();
    await frame.waitForTimeout(300);
    const isApplied = await frame.evaluate(() => {
      const span = document.querySelector('span.__se-node');
      if (!span) return null;
      return { fontWeight: getComputedStyle(span).fontWeight, hasBoldClass: span.className.includes('bold') };
    });
    result.sections.bold.appliedEffect = isApplied;
  }

  // ──────────────────────────────────────────────────────────────────
  // 4. 폰트 크기 버튼 팝업 분석
  // ──────────────────────────────────────────────────────────────────
  console.log('📌 [4] 폰트 크기 팝업 분석...');
  // 다시 선택
  await page.keyboard.press('End');
  await page.keyboard.down('Shift');
  await page.keyboard.press('Home');
  await page.keyboard.up('Shift');
  await frame.waitForTimeout(200);

  const sizeBtn = await frame.$('button.se-font-size-code-toolbar-button');
  if (sizeBtn) {
    await sizeBtn.click();
    await frame.waitForTimeout(600);
    result.sections.fontSizePopup = await frame.evaluate(() => {
      // 현재 보이는 팝업/레이어 전체 구조
      const popup = document.querySelector('.se-property-toolbar-custom-layer-container');
      if (!popup) return { found: false };
      const items = [...popup.querySelectorAll('li, button, a')].map(el => ({
        tag: el.tagName,
        text: el.textContent.trim(),
        classList: [...el.classList],
        dataAttrs: [...el.attributes].filter(a => a.name.startsWith('data')).map(a => `${a.name}="${a.value}"`),
      }));
      return {
        found: true,
        popupClass: popup.className,
        itemCount: items.length,
        items: items.slice(0, 30),
        inputs: [...popup.querySelectorAll('input')].map(i => ({
          cls: i.className,
          placeholder: i.placeholder,
          value: i.value,
        })),
      };
    });
    await page.keyboard.press('Escape');
    await frame.waitForTimeout(300);
  } else {
    result.sections.fontSizePopup = { found: false, reason: 'button.se-font-size-code-toolbar-button not found' };
  }

  // ──────────────────────────────────────────────────────────────────
  // 5. 색상 버튼 팝업 분석 (더보기 포함)
  // ──────────────────────────────────────────────────────────────────
  console.log('📌 [5] 색상 팝업 완전 분석...');
  await page.keyboard.press('End');
  await page.keyboard.down('Shift');
  await page.keyboard.press('Home');
  await page.keyboard.up('Shift');
  await frame.waitForTimeout(200);

  const colorBtn = await frame.$('button.se-font-color-toolbar-button');
  if (colorBtn) {
    await colorBtn.click();
    await frame.waitForTimeout(600);

    result.sections.colorPickerInitial = await frame.evaluate(() => {
      const picker = document.querySelector('.se-property-color-picker-container, [class*="color-picker"]');
      return {
        pickerClass: picker ? picker.className : null,
        inputs: [...document.querySelectorAll('input')].filter(i => i.offsetParent !== null).map(i => ({
          cls: i.className, placeholder: i.placeholder, value: i.value,
        })),
        buttons: [...document.querySelectorAll('button')].filter(b => b.offsetParent !== null && (
          b.className.includes('more') || b.textContent.includes('더보기') || b.textContent.includes('more')
        )).map(b => ({ text: b.textContent.trim(), cls: b.className })),
        visibleLayers: [...document.querySelectorAll('[class*="color"]')].filter(el => el.offsetParent !== null).map(el => ({
          tag: el.tagName, cls: el.className.slice(0, 80),
        })).slice(0, 15),
      };
    });

    // 더보기 버튼 클릭
    const moreBtn = await frame.locator('button').filter({ hasText: '더보기' }).first();
    const moreBtnCount = await moreBtn.count();
    if (moreBtnCount > 0) {
      await moreBtn.click();
      await frame.waitForTimeout(600);
      result.sections.colorPickerExpanded = await frame.evaluate(() => {
        return {
          inputs: [...document.querySelectorAll('input')].filter(i => i.offsetParent !== null).map(i => ({
            cls: i.className, placeholder: i.placeholder, value: i.value, type: i.type,
          })),
          confirmButtons: [...document.querySelectorAll('button')].filter(b => b.offsetParent !== null && (
            b.className.includes('confirm') || b.className.includes('apply') || b.textContent.trim() === '확인'
          )).map(b => ({ text: b.textContent.trim(), cls: b.className })),
          allVisibleButtons: [...document.querySelectorAll('button')].filter(b => b.offsetParent !== null && b.className.includes('color')).map(b => ({
            text: b.textContent.trim().slice(0, 20), cls: b.className.slice(0, 80),
          })).slice(0, 10),
        };
      });
    }
    await page.keyboard.press('Escape');
    await frame.waitForTimeout(300);
  }

  // ──────────────────────────────────────────────────────────────────
  // 6. 구분선 버튼 찾기
  // ──────────────────────────────────────────────────────────────────
  console.log('📌 [6] 구분선 버튼 분석...');
  const dividerBtn = await frame.$('button[class*="se-insert-horizontal-line"]');
  result.sections.divider = {
    found: !!dividerBtn,
    selector: 'button[class*="se-insert-horizontal-line"]',
  };
  if (dividerBtn) {
    const cls = await dividerBtn.getAttribute('class');
    result.sections.divider.fullClass = cls;
    // 클릭해서 구분선 삽입 테스트
    await dividerBtn.click();
    await frame.waitForTimeout(400);
    const inserted = await frame.evaluate(() => {
      return !!document.querySelector('.se-component.se-horizontalLine, .se-horizontal-rule, [class*="horizontal"]');
    });
    result.sections.divider.insertionWorked = inserted;
  }

  // ──────────────────────────────────────────────────────────────────
  // 7. 인용구 버튼 분석
  // ──────────────────────────────────────────────────────────────────
  console.log('📌 [7] 인용구 버튼 분석...');
  const quoteBtns = await frame.evaluate(() => {
    return [...document.querySelectorAll('button[class*="quotation"], button[class*="quote"]')].map(b => ({
      text: b.textContent.trim().replace(/(.+)\1/, '$1'),
      cls: b.className.slice(0, 100),
    }));
  });
  result.sections.quotation = quoteBtns;

  // ──────────────────────────────────────────────────────────────────
  // 8. 컨텐츠 영역 셀렉터 확인
  // ──────────────────────────────────────────────────────────────────
  console.log('📌 [8] 컨텐츠 영역 셀렉터 확인...');
  result.sections.contentSelectors = await frame.evaluate(() => {
    const checks = {
      titleArea: !!document.querySelector('div.se-component.se-documentTitle .se-title-text p.se-text-paragraph'),
      contentParagraph: !!document.querySelector('div.se-component.se-text .se-component-content p.se-text-paragraph'),
      contentSpan: !!document.querySelector('div.se-component.se-text .se-component-content p.se-text-paragraph span.__se-node'),
      canvasBottom: !!document.querySelector('div.se-canvas-bottom'),
      mainFrame: document.title,
    };
    // 발행 버튼
    const publishBtns = [...document.querySelectorAll('button')].filter(b =>
      b.textContent.includes('발행') || b.textContent.includes('발표') || b.className.includes('publish')
    ).map(b => ({ text: b.textContent.trim().slice(0, 20), cls: b.className.slice(0, 80) }));
    checks.publishButtons = publishBtns;
    return checks;
  });

  // ──────────────────────────────────────────────────────────────────
  // 마크다운 문서 생성
  // ──────────────────────────────────────────────────────────────────
  console.log('\n📝 분석 결과를 마크다운으로 저장 중...');

  const docToolbarRows = (result.sections.documentToolbar || []).map(b =>
    `| \`${b.selector || '(selector 없음)'}\` | ${b.text} |`
  ).join('\n');

  const propToolbarRows = result.sections.propertyToolbar?.buttons?.map(b =>
    `| \`button.${b.specificClass}\` | ${b.text} |`
  ).join('\n') || '';

  const sizePopupInfo = result.sections.fontSizePopup?.found
    ? `팝업 컨테이너: \`.se-property-toolbar-custom-layer-container\`\n\n**아이템 목록:**\n${
        result.sections.fontSizePopup.items?.map(i =>
          `- \`${[...i.classList].join('.')}\` text="${i.text}" data=[${i.dataAttrs.join(', ')}]`
        ).join('\n') || '없음'
      }\n\n**입력 필드:**\n${
        result.sections.fontSizePopup.inputs?.map(i => `- class="${i.cls}" placeholder="${i.placeholder}"`).join('\n') || '없음'
      }`
    : '❌ 팝업 못 찾음';

  const colorInfo = `
**초기 팝업:**
- picker 컨테이너: \`${result.sections.colorPickerInitial?.pickerClass || '못 찾음'}\`
- 입력 필드: ${result.sections.colorPickerInitial?.inputs?.map(i => `\`input.${i.cls}\` (placeholder="${i.placeholder}")`).join(', ') || '없음'}
- 더보기 버튼: ${result.sections.colorPickerInitial?.buttons?.map(b => `"${b.text}" cls="${b.cls}"`).join(', ') || '없음'}

**더보기 클릭 후:**
${result.sections.colorPickerExpanded ? `
- 입력 필드: ${result.sections.colorPickerExpanded.inputs?.map(i => `\`input.${i.cls}\` placeholder="${i.placeholder}" type="${i.type}"`).join(', ') || '없음'}
- 확인 버튼: ${result.sections.colorPickerExpanded.confirmButtons?.map(b => `"${b.text}" cls="${b.cls}"`).join(', ') || '없음'}
` : '더보기 버튼 없거나 클릭 실패'}
`;

  const markdown = `# 네이버 블로그 Smart Editor ONE - 완전 분석 가이드

> **분석 일시**: ${new Date().toLocaleString('ko-KR')}  
> **에디터 버전**: Smart Editor ONE (React 기반)  
> **iframe**: \`#mainFrame\` (name="mainFrame")

---

## ⚠️ 중요 사항

- **aria-label 없음**: 네이버 에디터 버튼들은 aria-label이 설정되어 있지 않음
- **클래스 기반 셀렉터** 사용해야 함
- 모든 상호작용은 **iframe frame 컨텍스트** 안에서 실행
- Property Toolbar(하단 서식 툴바)는 텍스트에 커서가 있을 때 항상 표시됨

---

## 1. 컨텐츠 영역 셀렉터

\`\`\`js
// 제목 입력
const titleSelector = 'div.se-component.se-documentTitle .se-title-text p.se-text-paragraph';

// 본문 단락 클릭용 (포커스)
const contentParagraphSelector = 'div.se-component.se-text .se-component-content p.se-text-paragraph';

// 본문 텍스트 타이핑 대상
const contentSpanSelector = 'div.se-component.se-text .se-component-content p.se-text-paragraph span.__se-node';

// 새 단락 추가 (클릭하면 커서가 이동)
const canvasBottom = 'div.se-canvas-bottom';
\`\`\`

검증 결과: ${JSON.stringify(result.sections.contentSelectors, null, 2).replace(/\n/g, '\n> ')}

---

## 2. 상단 문서 툴바 (Document Toolbar)

삽입 기능 버튼들 - iframe 안에서 \`frame.$('selector')\`로 찾음

| 셀렉터 | 설명 |
|--------|------|
${docToolbarRows}

---

## 3. 하단 서식 툴바 (Property Toolbar)

텍스트 커서가 있을 때 항상 표시됨. 컨테이너: \`.se-l-property-toolbar\`

| 셀렉터 | 설명 |
|--------|------|
${propToolbarRows}

---

## 4. Bold (굵게) 적용

\`\`\`js
// 텍스트 선택 후
const boldBtn = await frame.$('button.se-bold-toolbar-button');
await boldBtn.click();
// 또는 키보드: await page.keyboard.press('Control+b');
\`\`\`

Bold 동작 확인: ${JSON.stringify(result.sections.bold)}

---

## 5. 폰트 크기 변경

\`\`\`js
const sizeBtn = await frame.$('button.se-font-size-code-toolbar-button');
await sizeBtn.click();
await frame.waitForTimeout(500);
// 드롭다운 리스트에서 원하는 크기 클릭
const targetSize = frame.locator('.se-property-toolbar-custom-layer-container li, .se-property-toolbar-custom-layer-container button')
  .filter({ hasText: /^17$/ }).first();
await targetSize.click();
\`\`\`

${sizePopupInfo}

---

## 6. 글자색 변경

${colorInfo}

\`\`\`js
// 완전한 색상 적용 플로우
const colorBtn = await frame.$('button.se-font-color-toolbar-button');
await colorBtn.click();
await frame.waitForTimeout(500);

// 방법 1: 더보기 클릭 후 hex 입력
const moreBtn = frame.locator('button').filter({ hasText: '더보기' }).first();
if (await moreBtn.count() > 0) {
  await moreBtn.click();
  await frame.waitForTimeout(400);
  const hexInput = await frame.$('input.se-selected-color-hex');
  if (hexInput) {
    await hexInput.click({ clickCount: 3 });
    await hexInput.fill('1e6fff');
    // 확인 버튼 찾기
    const confirmBtn = frame.locator('button').filter({ hasText: '확인' }).first();
    if (await confirmBtn.count() > 0) await confirmBtn.click();
    else await page.keyboard.press('Enter');
  }
}
\`\`\`

---

## 7. 구분선 (Horizontal Line) 삽입

\`\`\`js
const dividerBtn = await frame.$('button[class*="se-insert-horizontal-line"]');
await dividerBtn.click();
\`\`\`

구분선 버튼 전체 클래스: \`${result.sections.divider?.fullClass || '미확인'}\`  
삽입 동작 확인: ${result.sections.divider?.insertionWorked}

---

## 8. 인용구 (Quotation) 삽입

\`\`\`js
// 인용구 버튼 (드롭다운으로 스타일 선택)
// 버튼들:
${(result.sections.quotation || []).map(b => `// ${b.text}: button.${b.cls.split(' ').find(c => c.startsWith('se-'))}`).join('\n')}
\`\`\`

---

## 9. 텍스트 선택 패턴

\`\`\`js
// frame.type() 후 현재 줄 전체 선택하는 패턴
// End로 이동 후 Shift+Home으로 역방향 선택 (가장 안정적)
await page.keyboard.press('End');
await frame.waitForTimeout(80);
await page.keyboard.down('Shift');
await page.keyboard.press('Home');
await page.keyboard.up('Shift');
await frame.waitForTimeout(200);
// 이 시점에서 boldBtn.click() 또는 keyboard 단축키 사용
\`\`\`

---

## 10. 발행 플로우

\`\`\`js
// 발행 버튼 (우측 상단)
const publishBtnSelector = 'div.header__Ceaap > div > div.publish_btn_area__KjA2i > div:nth-child(2) > button';

// 예약 발행 설정
const reservationLabel = frame.locator('label', { hasText: '예약' }).last();
await reservationLabel.click();

// 시간 설정
await frame.selectOption('select.hour_option__J_heO', hourStr);
await frame.selectOption('select.minute_option__Vb3xB', minuteStr);

// 카테고리 설정
await frame.click('button[aria-label="카테고리 목록 버튼"]');
await frame.click(\`span[data-testid^="categoryItemText_"]:text("카테고리명")\`);

// 최종 발행
const finalPublishBtnSelector = 'div.layer_btn_area__UzyKH > div > button';
await frame.click(finalPublishBtnSelector);
\`\`\`

---

## 11. 팝업 닫기 / 초기화

\`\`\`js
// 에디터 로드 시 나타날 수 있는 팝업들
const cancelBtn = await frame.waitForSelector('button.se-popup-button.se-popup-button-cancel', { timeout: 3000 }).catch(() => null);
if (cancelBtn) await cancelBtn.click().catch(() => null);

const helpBtn = await frame.waitForSelector('article > div > header > button', { timeout: 3000 }).catch(() => null);
if (helpBtn) await helpBtn.click().catch(() => null);
\`\`\`

---

## 12. 전체 raw 분석 데이터

\`\`\`json
${JSON.stringify(result, null, 2)}
\`\`\`
`;

  const outputPath = './naver-editor-complete.md';
  fs.writeFileSync(outputPath, markdown, 'utf-8');
  console.log(`\n✅ 분석 완료! 결과 저장: ${outputPath}`);
  console.log('\n30초 후 종료됩니다.');
  await page.waitForTimeout(30000);
  await browser.close();
})();
