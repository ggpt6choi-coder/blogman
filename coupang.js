require('dotenv').config();
const axios = require('axios');
const crypto = require('crypto');

const ACCESS_KEY = process.env.COUPANG_ACCESS_KEY || '';
const SECRET_KEY = process.env.COUPANG_SECRET_KEY || '';
const DOMAIN = 'https://api-gateway.coupang.com';

/**
 * Coupang API 권한 인증 헤더 생성 함수
 * @param {string} method - 'GET' or 'POST'
 * @param {string} url - API Endpoint
 * @returns {string} Authorization Header value
 */
function generateAuthorization(method, url) {
    // 1. 현재 시간 생성 (YYMMDDTHHMMSSZ 포맷)
    const now = new Date();
    const year = now.getUTCFullYear().toString().slice(-2); // 2자리 연도
    const month = (now.getUTCMonth() + 1).toString().padStart(2, '0');
    const day = now.getUTCDate().toString().padStart(2, '0');
    const hour = now.getUTCHours().toString().padStart(2, '0');
    const minute = now.getUTCMinutes().toString().padStart(2, '0');
    const second = now.getUTCSeconds().toString().padStart(2, '0');
    const datetime = `${year}${month}${day}T${hour}${minute}${second}Z`;

    // 2. Signature Message 생성
    const message = datetime + method + url;

    // 3. HMAC 서명 생성
    const signature = crypto.createHmac('sha256', SECRET_KEY)
        .update(message)
        .digest('hex');

    // 4. Authorization 헤더 반환
    return `CEA algorithm=HmacSHA256, access-key=${ACCESS_KEY}, signed-date=${datetime}, signature=${signature}`;
}

/**
 * 골드박스 상품 리스트 조회
 */
async function getGoldboxProducts() {
    const URL = '/v2/providers/affiliate_open_api/apis/openapi/v1/products/goldbox';
    const method = 'GET';

    try {
        if (!ACCESS_KEY || !SECRET_KEY) throw new Error('Coupang Keys missing');

        const authorization = generateAuthorization(method, URL);

        console.log(`Requesting Goldbox Products...`);
        const response = await axios.get(`${DOMAIN}${URL}`, {
            headers: {
                'Content-Type': 'application/json;charset=UTF-8',
                'Authorization': authorization
            }
        });

        if (response.data && response.data.data) {
            console.log(`Successfully fetched ${response.data.data.length} items.`);
            response.data.data.slice(0, 5).forEach((item, index) => { // 상위 5개만 출력
                console.log(`[${index + 1}] ${item.productName}`);
                console.log(`    Price: ${item.productPrice}`);
                console.log(`    Link: ${item.productUrl}`);
                console.log('---');
            });
        }
    } catch (error) {
        handleError(error);
    }
}

const fs = require('fs');
const path = require('path');
const moment = require('moment');

// ... existing code ...

/**
 * 딥링크(Deep Link) 생성 함수
 * @param {string[]} urls - 변환할 일반 쿠팡 URL 배열
 */
async function generateDeepLink(urls) {
    const URL = '/v2/providers/affiliate_open_api/apis/openapi/v1/deeplink';
    const method = 'POST';

    try {
        if (!ACCESS_KEY || !SECRET_KEY) throw new Error('Coupang Keys missing');

        const authorization = generateAuthorization(method, URL);

        console.log(`Requesting Deep Link for URLs: ${urls}`);
        const response = await axios.post(`${DOMAIN}${URL}`, {
            coupangUrls: urls
        }, {
            headers: {
                'Content-Type': 'application/json;charset=UTF-8',
                'Authorization': authorization
            }
        });

        if (response.data && response.data.data) {
            console.log('Successfully generated Deep Links:');

            const resultsToSave = [];
            const timestamp = moment().format('YYYY-MM-DD HH:mm:ss');

            response.data.data.forEach((item) => {
                console.log(`Original: ${item.originalUrl}`);
                console.log(`Shorten: ${item.shortenUrl}`);
                console.log(`Landing: ${item.landingUrl}`);
                console.log('---');

                resultsToSave.push({
                    shortenUrl: item.shortenUrl,
                    originalUrl: item.originalUrl, // 원본 URL도 같이 저장하면 유용할 듯
                    executedAt: timestamp
                });
            });

            // 파일 저장 로직
            saveToJSON(resultsToSave);

        } else {
            console.log('No data found:', response.data);
        }

    } catch (error) {
        handleError(error);
    }
}

/**
 * 결과를 data/coupang.json 파일에 저장
 * @param {Array} newItems 
 */
function saveToJSON(newItems) {
    const dirPath = path.join(__dirname, 'data');
    const filePath = path.join(dirPath, 'coupang.json');

    try {
        // data 폴더 확인 및 생성
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
        }

        // 기존 파일 읽기 로직 제거: 항상 덮어쓰기

        // 파일 쓰기
        fs.writeFileSync(filePath, JSON.stringify(newItems, null, 2), 'utf8');
        console.log(`Saved ${newItems.length} items to ${filePath} (Overwritten)`);

    } catch (error) {
        console.error('Failed to save data to file:', error.message);
    }
}

function handleError(error) {
    if (error.response) {
        console.error('API Error:', error.response.status, error.response.data);
    } else {
        console.error('Error:', error.message);
    }
}

// --- 실행 예제 ---
(async () => {
    // 1. 골드박스 상품 조회
    // await getGoldboxProducts();

    // 2. 딥링크 생성 테스트 (예제 URL)
    const testUrl = "https://www.coupang.com/np/goldbox"; // 테스트용 더미 URL or 실제 상품 URL
    // 실제 존재하는 상품 URL이어야 정확히 동작하므로, 
    // 실제로는 검색이나 기존 상품 URL을 넣어야 함.
    // 여기서는 골드박스 리스트에서 하나 가져와서 변환해보는 흐름으로 작성하거나
    // 사용자가 요청한대로 "URL을 입력하면" 함수를 제공.

    // 사용 예시:
    // await generateDeepLink(['https://www.coupang.com/vp/products/7335526685?itemId=18844464872']);

    // 명령어 인자로 URL이 들어오면 그걸 변환, 아니면 골드박스 실행
    // const args = process.argv.slice(2);
    // if (args.length > 0) {
    //     await generateDeepLink(args);
    // } else {
    //     console.log('Usage: node coupang.js [Coupang_Product_URL]');
    //     await getGoldboxProducts();
    // }
    await generateDeepLink([testUrl]);
})();
