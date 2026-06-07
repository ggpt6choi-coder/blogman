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

  // write content: support array of sections or string
  if (Array.isArray(content)) {
    for (const section of content) {
      if (section.title) {
        await frame.type(contentSpanSelector, section.title + '\n', { delay: 40 }).catch(()=>null);
        await frame.waitForTimeout(80);
      }
      if (section.content) {
        await frame.type(contentSpanSelector, section.content + '\n', { delay: 6 }).catch(()=>null);
        await frame.waitForTimeout(80);
      }
    }
  } else if (typeof content === 'string') {
    // if very long, type in two chunks
    const half = Math.floor(content.length / 2);
    await frame.type(contentSpanSelector, content.slice(0, half), { delay: 6 }).catch(()=>null);
    await frame.waitForTimeout(200);
    await frame.type(contentSpanSelector, content.slice(half), { delay: 6 }).catch(()=>null);
  }

  // hashtag
  if (hashTag && Array.isArray(hashTag) && hashTag.length) {
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await frame.type(contentSpanSelector, hashTag.join(' '), { delay: 40 }).catch(()=>null);
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
