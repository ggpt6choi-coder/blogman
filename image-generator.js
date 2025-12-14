const path = require('path');
const fs = require('fs');

/**
 * Generates a thumbnail image with the given text using Playwright.
 * @param {import('playwright').Page} page - The Playwright page instance.
 * @param {string} text - The text to display on the thumbnail.
 * @param {string} outputPath - The file path to save the generated image.
 */
async function generateThumbnail(page, text, outputPath) {
  // Ensure the directory exists
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Random vibrant background colors
  const colors = [
    'linear-gradient(135deg, #FF6B6B 0%, #556270 100%)', // Red to Grey
    'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)', // Blue gradient
    'linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)', // Green gradient
    'linear-gradient(135deg, #fa709a 0%, #fee140 100%)', // Pink to Yellow
    'linear-gradient(135deg, #667eea 0%, #764ba2 100%)', // Purple gradient
    'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)', // Pink Red
    'linear-gradient(135deg, #89f7fe 0%, #66a6ff 100%)', // Light Blue
    'linear-gradient(135deg, #13547a 0%, #80d0c7 100%)', // Teal
  ];
  const randomColor = colors[Math.floor(Math.random() * colors.length)];

  // HTML content for the thumbnail
  const htmlContent = `
    <html>
      <head>
        <style>
          body {
            margin: 0;
            padding: 0;
            width: 800px;
            height: 800px;
            display: flex;
            justify-content: center;
            align-items: center;
            background: ${randomColor};
            font-family: 'Apple SD Gothic Neo', 'Malgun Gothic', sans-serif;
            overflow: hidden;
          }
          .container {
            width: 700px;
            height: 700px;
            display: flex;
            justify-content: center;
            align-items: center;
            text-align: center;
            border: 10px solid rgba(255, 255, 255, 0.3);
            border-radius: 30px;
            background: rgba(0, 0, 0, 0.1);
            backdrop-filter: blur(5px);
            padding: 40px;
            box-sizing: border-box;
          }
          .text {
            color: white;
            font-size: 60px;
            font-weight: 800;
            line-height: 1.3;
            text-shadow: 2px 2px 10px rgba(0, 0, 0, 0.3);
            word-break: keep-all;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="text">${text}</div>
        </div>
      </body>
    </html>
  `;

  // Use a new page to avoid messing with the current page's state (e.g. onbeforeunload dialogs)
  const context = page.context();
  const tempPage = await context.newPage();

  try {
    await tempPage.setContent(htmlContent);

    // Wait for fonts to load if necessary (standard fonts usually fine)
    // await tempPage.waitForTimeout(100); 

    const element = await tempPage.$('body');
    await element.screenshot({ path: outputPath });
  } finally {
    await tempPage.close();
  }
}

module.exports = { generateThumbnail };
