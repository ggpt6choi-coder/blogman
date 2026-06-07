const fs = require('fs');
const { logWithTime } = require('./common');

const monitorPath = 'blog-ji3-monitor.json';

try {
    fs.writeFileSync(monitorPath, JSON.stringify([], null, 2), 'utf-8');
    logWithTime(`blog-ji3-monitor.json 초기화 완료 (빈 배열로 리셋)`, '🔄');
} catch (e) {
    logWithTime(`blog-ji3-monitor.json 초기화 실패: ${e.message}`, '❌');
    process.exit(1);
}
