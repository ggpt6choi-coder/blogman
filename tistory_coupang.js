import axios from 'axios';
import moment from 'moment';
import crypto from 'crypto';
import dotenv from 'dotenv';
import fs from 'fs';
import { chromium } from 'playwright';
dotenv.config();

const ACCESS_KEY = process.env.ACCESS_KEY;
const SECRET_KEY = process.env.SECRET_KEY;

function generateHmac(method, url, secretKey, accessKey) {
  const parts = url.split('?');
  const [path, query = ''] = parts;

  const datetime = moment.utc().format('YYMMDD[T]HHmmss[Z]');
  const message = datetime + method.toUpperCase() + path + query;

  const signature = crypto
    .createHmac('sha256', secretKey)
    .update(message)
    .digest('hex');

  return `CEA algorithm=HmacSHA256, access-key=${accessKey}, signed-date=${datetime}, signature=${signature}`;
}

// 파트너스 URL로 변경 함수
const changeUrl = async (url) => {
  const URL_REQUEST_METHOD = 'POST';
  const URL_DOMAIN = 'https://api-gateway.coupang.com';
  const URL_URL = '/v2/providers/affiliate_open_api/apis/openapi/v1/deeplink';
  try {
    const authorization = generateHmac(
      URL_REQUEST_METHOD,
      URL_URL,
      SECRET_KEY,
      ACCESS_KEY
    );

    const response = await axios({
      method: URL_REQUEST_METHOD,
      url: `${URL_DOMAIN}${URL_URL}`,
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
      },
      data: { coupangUrls: [url] },
    });
    return response.data.data[0].shortenUrl;
  } catch (err) {
    console.error('❌ Error:', err.response ? err.response.data : err.message);
  }
};

const createHtml = (items) => {
  // 상품카드 HTML 생성
  function formatPrice(n) {
    return n.toLocaleString('ko-KR') + '원';
  }

  const cardsHtml = items
    .map(
      (item) => `
        <div class="card" style="cursor:pointer" onclick="if(event.target.classList.contains('btn-buy')) return; window.open('${
          item.productUrl
        }', '_blank')">
          <img src="${item.productImage}" alt="${item.productName}">
          <div class="title">${item.productName}</div>
          <div class="price">${formatPrice(item.productPrice)}</div>
          <a href="${
            item.productUrl
          }" target="_blank" class="btn-buy">구매하러 가기</a>
        </div>
      `
    )
    .join('\n');

  // 전체 HTML 반환 (view.html 구조)
  const today = new Date().toLocaleDateString();
  return `<!-- GOLD BOX SALE -->
  <style>
    body {
      font-family: 'Noto Sans KR', sans-serif;
      background: #fafafa;
      margin: 0;
      padding: 0;
    }
    .goldbox-container {
      max-width: 1000px;
      margin: 0 auto;
      padding: 20px;
    }
    .goldbox-header {
      text-align: center;
      margin-bottom: 40px;
      padding: 40px 20px;
      background: linear-gradient(90deg, #ff9f00, #ff3c00);
      color: #fff;
      border-radius: 14px;
    }
    .goldbox-header h1 {
      font-size: 2.2rem;
      font-weight: 800;
      margin: 0;
    }
    .goldbox-header p {
      margin-top: 10px;
      font-size: 1.2rem;
      font-weight: 500;
      opacity: 0.95;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 25px;
    }
    .card {
      background: #fff;
      border-radius: 16px;
      box-shadow: 0 6px 14px rgba(0, 0, 0, 0.08);
      padding: 18px;
      text-align: center;
      transition: transform 0.2s ease, box-shadow 0.2s ease;
    }
    .card:hover {
      transform: translateY(-6px);
      box-shadow: 0 10px 20px rgba(0, 0, 0, 0.15);
    }
    .card img {
      width: 100%;
      border-radius: 12px;
      margin-bottom: 15px;
      height: 220px;
      object-fit: cover;
    }
    .card .title {
      font-size: 1.2rem;
      font-weight: 600;
      color: #333;
      margin-bottom: 12px;
      height: 52px;
      overflow: hidden;
      line-height: 1.4em;
    }
    .card .price {
      font-size: 1.4rem;
      font-weight: 700;
      color: #e63946;
      margin-bottom: 20px;
    }
    .card .btn-buy {
      display: inline-block;
      padding: 12px 24px;
      background: #ff3c00;
      color: #fff;
      border-radius: 12px;
      text-decoration: none;
      font-weight: 700;
      transition: background 0.2s ease;
    }
    .card .btn-buy:hover {
      background: #cc3200;
    }
    @media (max-width: 768px) {
      .grid {
        grid-template-columns: 1fr;
      }
      .goldbox-header h1 {
        font-size: 1.7rem;
      }
      .goldbox-header p {
        font-size: 1rem;
      }
      .card img {
        height: 180px;
      }
    }
  </style>
  <div class="goldbox-container">
    <div class="goldbox-header">
  <h1>🌟${today}🌟특가 SALE 상품<br/><span style="display:inline-block;background:#d32f2f;color:#fff;padding:8px 18px;border-radius:10px;font-size:2rem;font-weight:900;box-shadow:0 2px 8px rgba(211,47,47,0.18);margin-top:10px;text-shadow:0 2px 8px rgba(0,0,0,0.18);">쿠팡 오늘 하루만!!✨</span></h1>
      <p>단 하루, 역대급 할인! 품절 전에 서두르세요!</p>
      <div style="margin-top: 10px; font-size: 0.9rem; opacity: 0.8">
        이 포스팅은 쿠팡 파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다.
      </div>
    </div>
    <div class="grid">
      ${cardsHtml}
    </div>
  </div>`;
};

const uploadToTistory = async (html) => {
  try {
    const browser = await chromium.launch({
      headless: false,
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
    await page.goto(
      'https://accounts.kakao.com/login/?continue=https%3A%2F%2Fkauth.kakao.com%2Foauth%2Fauthorize%3Fclient_id%3D3e6ddd834b023f24221217e370daed18%26state%3DaHR0cHM6Ly93d3cudGlzdG9yeS5jb20v%26redirect_uri%3Dhttps%253A%252F%252Fwww.tistory.com%252Fauth%252Fkakao%252Fredirect%26response_type%3Dcode%26auth_tran_id%3DD_6h.j6MRcBx1hgddDsXrxr4j4ozRTZX8n2utnvJnOEspBQoIKM4Wltt6vCp%26ka%3Dsdk%252F2.7.3%2520os%252Fjavascript%2520sdk_type%252Fjavascript%2520lang%252Fko-KR%2520device%252FMacIntel%2520origin%252Fhttps%25253A%25252F%25252Fwww.tistory.com%26is_popup%3Dfalse%26through_account%3Dtrue&talk_login=hidden#login'
    );

    await page.fill('#loginId--1', process.env.TISTORY_ID);
    await page.fill('#password--2', process.env.TISTORY_PW.replace(/"/g, ''));
    await page.click(
      '#mainContent > div > div > form > div.confirm_btn > button.btn_g.highlight.submit'
    );
    await page.waitForNavigation();

    logWithTime('로그인 완료');

    // 글쓰기 페이지 이동
    await page.goto(`https://deeev-choi.tistory.com/manage/newpost`);

    // dialog 이벤트 핸들러 설정
    page.on('dialog', async (dialog) => {
      const msg = dialog.message();
      if (msg.includes('작성 모드')) {
        await dialog.accept(); // HTML모드 변경 시 '확인'
      } else {
        await dialog.dismiss(); // 기존 글썼다는 confirm창 처리에서는 '취소'
      }
    });

    // HTML모드로 변경 (이때만 '확인' 버튼 누름)
    await page.click('#editor-mode-layer-btn-open');
    await page.click('#editor-mode-html');

    // '제목' 입력
    const titleParagraphSelector = '#post-title-inp';
    await page.click(titleParagraphSelector, { clickCount: 1, delay: 100 });
    await page.waitForTimeout(300);
    await page.type(titleParagraphSelector, 'test title', { delay: 50 });

    // '본문' 입력
    await page.click('.CodeMirror');
    // html을 10등분
    const htmlParts = [];
    const partLen = Math.floor(html.length / 10);
    for (let i = 0; i < 10; i++) {
      const start = i * partLen;
      const end = i === 9 ? html.length : (i + 1) * partLen;
      htmlParts.push(html.slice(start, end));
    }

    for (const part of htmlParts) {
      await page.type('.CodeMirror textarea', part, { delay: 10 });
      await page.waitForTimeout(200);
    }

    // 발행
    await page.click('#publish-layer-btn');
    await page.waitForTimeout(1000);
    await page.click('#publish-btn');
  } catch (err) {
    console.error(
      '❌ Tistory Error:',
      err.response ? err.response.data : err.message
    );
  }

  await browser.close();
  logWithTime('글 작성 완료', '🎉');

  // tistory 글 파라미터 관리용
  // deeev-choi.tistory.com/${count}
  const countFile = 'coupang.count.json';
  let count = 0;

  // 파일이 이미 있으면 기존 값 읽기
  if (fs.existsSync(countFile)) {
    const data = fs.readFileSync(countFile, 'utf-8');
    try {
      count = JSON.parse(data).count || 0;
    } catch (e) {
      count = 0;
    }
  }

  // count 증가 후 파일에 저장
  count += 1;
  fs.writeFileSync(countFile, JSON.stringify({ count }), 'utf-8');
};

// 메인함수 실행
(async () => {
  // 골드박스 API 호출
  const DOMAIN = 'https://api-gateway.coupang.com';
  const URL =
    '/v2/providers/affiliate_open_api/apis/openapi/v1/products/goldbox';
  const REQUEST_METHOD = 'GET';
  const params = new URLSearchParams({
    subId: process.env.COUPANG_SUBID || 'your_channel_id',
    imageSize: '212x212',
  }).toString();
  try {
    const fullUrl = URL + '?' + params;
    const authorization = generateHmac(
      REQUEST_METHOD,
      fullUrl,
      SECRET_KEY,
      ACCESS_KEY
    );

    const response = await axios.get(`${DOMAIN}${fullUrl}`, {
      headers: { Authorization: authorization },
    });

    // 각 상품의 URL을 파트너스 URL로 변경
    const goldboxItems = await Promise.all(
      response.data.data.map(async (item) => {
        const productUrl = await changeUrl(
          `https://www.coupang.com/vp/products/${item.productId}`
        );
        return { ...item, productUrl };
      })
    );

    // TISOTORY 글작성
    const html = createHtml(goldboxItems);

    // TISOTORY 업로드
    uploadToTistory(html);
  } catch (err) {
    console.error('❌ Error:', err.response ? err.response.data : err.message);
  }
})();
