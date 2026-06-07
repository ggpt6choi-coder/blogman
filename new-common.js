const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

function parseArgs() {
  const args = {};
  process.argv.slice(2).forEach(a => {
    if (a.startsWith('--')) {
      const [k, v] = a.replace(/^--/, '').split('=');
      args[k] = v === undefined ? true : v;
    }
  });
  return args;
}

async function loadNewsList({ localPath, remoteUrl } = {}) {
  if (localPath) {
    const p = path.resolve(localPath);
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf-8'));
    }
  }
  if (remoteUrl) {
    const res = await fetch(remoteUrl);
    return await res.json();
  }
  throw new Error('No localPath or remoteUrl provided to loadNewsList');
}

function appendErrorLog(text, file = 'error-log/naver-upload-error.log') {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, text + '\n', 'utf-8');
  } catch (e) {
    console.error('appendErrorLog failed', e);
  }
}

module.exports = {
  parseArgs,
  loadNewsList,
  appendErrorLog,
};
