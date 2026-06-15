# 네이버 블로그 Smart Editor ONE - 완전 분석 가이드

> **분석 일시**: 2026-06-12  
> **에디터 버전**: Smart Editor ONE (React 기반)  
> **분석 방법**: Playwright 자동화 + DOM 완전 탐색  
> **iframe**: `#mainFrame` (name="mainFrame")

---

## ⚠️ 핵심 주의사항

1. **aria-label 없음** - 네이버 에디터 버튼은 aria-label이 없음 → 클래스 기반 셀렉터 사용
2. **모든 상호작용은 frame 컨텍스트** - `frame.$()`, `frame.type()` 등 사용
3. **키보드 이벤트는 `page.keyboard`** - `frame.keyboard` 없음, `page.keyboard`가 포커스된 frame 대상으로 작동
4. **Property Toolbar(하단 서식 툴바)** - 텍스트 커서가 있으면 항상 표시됨
5. **Bold 버튼 클릭 시 selection 해제** - `Ctrl+B` 키보드 단축키가 더 안정적

---

## 1. 주요 컨텐츠 영역 셀렉터 (확인 완료)

```js
// 제목 입력 필드
const titleSelector = 'div.se-component.se-documentTitle .se-title-text p.se-text-paragraph';

// 본문 단락 (클릭으로 포커스)
const contentParagraphSelector = 'div.se-component.se-text .se-component-content p.se-text-paragraph';

// 본문 텍스트 타이핑 대상 (frame.type() 사용)
const contentSpanSelector = 'div.se-component.se-text .se-component-content p.se-text-paragraph span.__se-node';

// 새 단락 추가 (클릭하면 커서가 맨 아래로 이동)
const canvasBottom = 'div.se-canvas-bottom';
```

---

## 2. 상단 문서 툴바 (Document Toolbar) - 삽입 기능

| 셀렉터 | 기능 |
|--------|------|
| `button.se-image-toolbar-button` | 사진 추가 |
| `button.se-social-media-image-toolbar-button` | MYBOX 추가 |
| `button.se-video-toolbar-button` | 동영상 추가 |
| `button.se-sticker-toolbar-button` | 스티커 추가 (토글) |
| `button.se-insert-quotation-default-toolbar-button` | 인용구 추가 |
| `button.se-insert-horizontal-line-default-toolbar-button` | **구분선 추가** ✅ |
| `button[class*="se-insert-horizontal-line"]` | 구분선 추가 (패턴 매칭) |
| `button.se-oglink-toolbar-button` | 링크(OG) 추가 |
| `button.se-file-toolbar-button` | 파일 추가 |
| `button.se-schedule-toolbar-button` | 일정 추가 |
| `button.se-code-toolbar-button` | 소스코드 추가 |
| `button.se-table-toolbar-button` | 표 추가 |
| `button.se-formula-toolbar-button` | 수식 추가 |
| `button.se-map-toolbar-button` | 장소 추가 |
| `button.se-not-sponsored-button-toolbar-button` | 내돈내산 추가 |
| `button.se-search-toolbar-button` | 글감 검색 |
| `button.se-library-toolbar-button` | 라이브러리 |
| `button.se-template-toolbar-button` | 템플릿 |

---

## 3. 하단 서식 툴바 (Property Toolbar)

컨테이너: `.se-header-inbox.se-l-property-toolbar`  
텍스트에 커서가 있으면 항상 표시됨.

| 셀렉터 | 기능 |
|--------|------|
| `button.se-text-format-toolbar-button` | 문단 서식 (본문/제목 등) |
| `button.se-font-family-toolbar-button` | 서체 변경 |
| `button.se-font-size-code-toolbar-button` | 글자 크기 (현재값 표시) |
| `button.se-bold-toolbar-button` | **굵게** |
| `button.se-italic-toolbar-button` | 기울이기 |
| `button.se-underline-toolbar-button` | 밑줄 |
| `button.se-strikethrough-toolbar-button` | 취소선 |
| `button.se-font-color-toolbar-button` | **글자색** |
| `button.se-background-color-toolbar-button` | 글자 배경색 |
| `button.se-align-left-toolbar-button` | 정렬 (드롭다운) |
| `button.se-line-height-toolbar-button` | 줄간격 (드롭다운) |
| `button.se-list-bullet-toolbar-button` | 목록 (드롭다운) |
| `button.se-drop-cap-toolbar-button` | 머리글자 |
| `button.se-superscript-toolbar-button` | 위첨자 |
| `button.se-subscript-toolbar-button` | 아래첨자 |
| `button.se-special-letter-toolbar-button` | 특수문자 |
| `button.se-link-toolbar-button` | 링크 입력 |
| `button.se-translation-toolbar-button` | 번역 |
| `button.se-speller-toolbar-button` | 맞춤법 |

---

## 4. 텍스트 선택 패턴 (현재 줄 전체)

```js
// frame.type() 후 현재 줄 전체 선택
// End → Shift+Home (역방향 선택, 가장 안정적)
await page.keyboard.press('End');
await frame.waitForTimeout(80);
await page.keyboard.down('Shift');
await page.keyboard.press('Home');
await page.keyboard.up('Shift');
await frame.waitForTimeout(200);
// 이제 현재 줄 전체가 선택됨
```

---

## 5. Bold (굵게) 적용

```js
// ✅ 권장: 키보드 단축키 (selection 유지됨)
await page.keyboard.press('Control+b');

// ⚠️ 주의: 버튼 클릭 방식은 selection이 해제될 수 있음
// const boldBtn = await frame.$('button.se-bold-toolbar-button');
// await boldBtn.click();
```

---

## 6. 글자색 변경

```js
// 색상 버튼 클릭
const colorBtn = await frame.$('button.se-font-color-toolbar-button');
await colorBtn.click();
await frame.waitForTimeout(600);

// input.se-selected-color-hex 는 DOM에 존재하지만 viewport 밖에 있을 수 있음
// React controlled input이므로 native setter + Event dispatch 방식으로 값 주입
const colorApplied = await frame.evaluate((color) => {
  const input = document.querySelector('input.se-selected-color-hex');
  if (!input) return false;
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype, 'value'
  ).set;
  nativeInputValueSetter.call(input, color);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}, '1e6fff'); // hex 색상 (#없이)

if (colorApplied) {
  await page.keyboard.press('Enter'); // 색상 적용 확인
  await frame.waitForTimeout(300);
} else {
  await page.keyboard.press('Escape'); // 닫기
}
```

**색상 picker 구조:**
- 컨테이너: `.se-property-color-picker-container.__select-container`
- 팔레트 버튼: `button.se-color-palette`
- 색상 없음 버튼: `button.se-color-palette.se-color-palette-no-color`
- Hex 입력 필드: `input.se-selected-color-hex` (DOM에 존재, visibility 여부 무관)

---

## 7. 구분선 삽입 ✅ (insertionWorked: true 확인)

```js
// 풀 클래스: se-document-toolbar-icon-select-button 
//            se-insert-horizontal-line-default-toolbar-button
//            se-text-icon-toolbar-button __se-sentry
const dividerBtn = await frame.$('button[class*="se-insert-horizontal-line"]');
if (dividerBtn) {
  await dividerBtn.click();
  await frame.waitForTimeout(400);
}
```

---

## 8. 인용구 삽입 (6가지 스타일)

```js
// 인용구 버튼 클릭 (스타일 선택 드롭다운)
const quoteBtn = await frame.$('button.se-insert-quotation-default-toolbar-button');
await quoteBtn.click();
await frame.waitForTimeout(400);

// 스타일 선택
const styles = {
  default: 'button.se-insert-menu-sub-panel-button-quotation-default',      // 기본
  line:    'button.se-insert-menu-sub-panel-button-quotation-quotation_line',    // 줄
  bubble:  'button.se-insert-menu-sub-panel-button-quotation-quotation_bubble',  // 말풍선
  underline: 'button.se-insert-menu-sub-panel-button-quotation-quotation_underline', // 밑줄
  postit:  'button.se-insert-menu-sub-panel-button-quotation-quotation_postit',  // 포스트잇
  corner:  'button.se-insert-menu-sub-panel-button-quotation-quotation_corner',  // 모서리
};
await frame.click(styles.line); // 예: 줄 스타일 선택
await frame.waitForTimeout(300);
```

---

## 9. 발행 플로우

```js
// 발행 버튼 (우측 상단)
const publishBtnSelector = 'div.header__Ceaap > div > div.publish_btn_area__KjA2i > div:nth-child(2) > button';

// 예약 발행 설정
const reservationLabel = frame.locator('label', { hasText: '예약' }).last();
await reservationLabel.click();

// 시간 설정
await frame.selectOption('select.hour_option__J_heO', hourStr);    // '09'
await frame.selectOption('select.minute_option__Vb3xB', minuteStr); // '30'

// 카테고리 설정
await frame.click('button[aria-label="카테고리 목록 버튼"]');
await frame.click(`span[data-testid^="categoryItemText_"]:text("카테고리명")`);

// 최종 발행 버튼
await frame.click('div.layer_btn_area__UzyKH > div > button');
```

**발행 버튼 클래스:**
- 예약발행건수: `button.reserve_btn__Km5Xh`
- 발행: `button.publish_btn__m9KHH`

---

## 10. 팝업 닫기 / 초기화

```js
// 에디터 로드 시 나타날 수 있는 팝업
const cancelBtn = await frame.waitForSelector(
  'button.se-popup-button.se-popup-button-cancel', { timeout: 3000 }
).catch(() => null);
if (cancelBtn) await cancelBtn.click().catch(() => null);

const helpBtn = await frame.waitForSelector(
  'article > div > header > button', { timeout: 3000 }
).catch(() => null);
if (helpBtn) await helpBtn.click().catch(() => null);
```

---

## 11. 완성된 소제목 서식 적용 함수

```js
async function formatSectionTitle(frame, page) {
  await frame.waitForTimeout(200);

  // 현재 줄 전체 선택
  await page.keyboard.press('End');
  await frame.waitForTimeout(80);
  await page.keyboard.down('Shift');
  await page.keyboard.press('Home');
  await page.keyboard.up('Shift');
  await frame.waitForTimeout(200);

  // Bold (키보드 단축키로 selection 유지)
  await page.keyboard.press('Control+b');
  await frame.waitForTimeout(200);

  // 색상 적용 (다시 선택 후)
  try {
    await page.keyboard.press('End');
    await frame.waitForTimeout(50);
    await page.keyboard.down('Shift');
    await page.keyboard.press('Home');
    await page.keyboard.up('Shift');
    await frame.waitForTimeout(150);

    const colorBtn = await frame.$('button.se-font-color-toolbar-button');
    if (colorBtn) {
      await colorBtn.click();
      await frame.waitForTimeout(600);

      const colorApplied = await frame.evaluate((color) => {
        const input = document.querySelector('input.se-selected-color-hex');
        if (!input) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, color);
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
    }
  } catch (e) { /* 무시 */ }

  await page.keyboard.press('End');
  await frame.waitForTimeout(80);
}

async function insertDivider(frame, page) {
  try {
    const btn = await frame.$('button[class*="se-insert-horizontal-line"]');
    if (btn) {
      await btn.click();
      await frame.waitForTimeout(400);
    }
  } catch (e) { /* 무시 */ }
}
```

---

## 12. 기타 참조

### 이미지 업로드
```js
// 파일 선택 이벤트를 기다린 후 이미지 버튼 클릭
const fileChooserPromise = page.waitForEvent('filechooser');
await frame.click('button.se-image-toolbar-button');
const fileChooser = await fileChooserPromise;
await fileChooser.setFiles('/path/to/image.png');
await frame.waitForTimeout(1500);
```

### 대표 이미지 설정
```js
const images = await frame.$$('.se-module-image');
if (images.length) {
  await images[0].click();
  await frame.waitForTimeout(500);
  const repBtn = await frame.$('button.se-toolbar-option-visible-representative-button');
  if (repBtn) await repBtn.click();
}
```
