const axios = require('axios');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const path = require('path');
const xml2js = require('xml2js');
const express = require('express');
const WebSocket = require('ws');

const app = express();
const port = 3000;

app.use(express.static('public'));
app.use(express.json());

const wss = new WebSocket.Server({ noServer: true });

// New function to clear the screenshots folder
async function clearScreenshotsFolder() {
  const directory = 'public/screenshots';
  try {
    const files = await fs.readdir(directory);
    for (const file of files) {
      await fs.unlink(path.join(directory, file));
    }
    console.log('Screenshots folder cleared.');
  } catch (err) {
    console.error('Error clearing screenshots folder:', err);
  }
}

async function parseSitemap(sitemapUrl) {
  console.log(`Parsing sitemap: ${sitemapUrl}`);
  const response = await axios.get(sitemapUrl);
  const parser = new xml2js.Parser();
  const result = await parser.parseStringPromise(response.data);
  console.log(`Sitemap parsed. Found ${result.urlset.url.length} URLs.`);
  return result.urlset.url.map(url => url.loc[0]);
}

async function captureScreenshot(url, outputPath) {
  console.log(`Capturing screenshot for: ${url}`);
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900 });
  await page.goto(url, { waitUntil: 'networkidle0' });
  await page.screenshot({ path: outputPath, fullPage: true });
  await browser.close();
  console.log(`Screenshot captured for: ${url}`);
}

async function extractSEOData(url) {
  console.log(`Extracting SEO data for: ${url}`);
  const response = await axios.get(url);
  const $ = cheerio.load(response.data);
  
  const seoData = {
    url: url,
    title: $('title').text(),
    description: $('meta[name="description"]').attr('content'),
    keywords: $('meta[name="keywords"]').attr('content'),
    h1: $('h1').first().text(),
    canonicalUrl: $('link[rel="canonical"]').attr('href'),
    ogTitle: $('meta[property="og:title"]').attr('content'),
    ogDescription: $('meta[property="og:description"]').attr('content'),
    ogImage: $('meta[property="og:image"]').attr('content'),
    twitterCard: $('meta[name="twitter:card"]').attr('content'),
    twitterTitle: $('meta[name="twitter:title"]').attr('content'),
    twitterDescription: $('meta[name="twitter:description"]').attr('content'),
    twitterImage: $('meta[name="twitter:image"]').attr('content'),
  };

  console.log(`SEO data extracted for: ${url}`);
  return seoData;
}

async function processUrl(url, index, total) {
  const screenshotPath = `public/screenshots/${encodeURIComponent(url)}.png`;
  await captureScreenshot(url, screenshotPath);
  const seoData = await extractSEOData(url);
  
  return { 
    ...seoData, 
    screenshotPath: screenshotPath.replace('public/', '') 
  };
}

app.post('/process-sitemap', async (req, res) => {
  const { sitemapUrl } = req.body;
  res.json({ message: 'Processing started' });

  console.log('Clearing screenshots folder...');
  await clearScreenshotsFolder();

  const urls = await parseSitemap(sitemapUrl);
  const results = [];
  const concurrency = 3; // Process 3 pages at a time

  for (let i = 0; i < urls.length; i += concurrency) {
    const batch = urls.slice(i, i + concurrency);
    console.log(`Processing batch ${i / concurrency + 1} of ${Math.ceil(urls.length / concurrency)}`);
    
    const batchResults = await Promise.all(
      batch.map(url => processUrl(url, i + batch.indexOf(url), urls.length))
    );

    results.push(...batchResults);

    // Send progress update
    const progress = Math.round(((i + batch.length) / urls.length) * 100);
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'progress', progress }));
      }
    });
  }

  console.log('All URLs processed. Saving results...');
  await fs.writeFile('public/results.json', JSON.stringify(results, null, 2));
  console.log('Results saved.');

  // Send completion message
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({
        type: 'complete',
        resultsUrl: '/results.html'
      }));
    }
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/results', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'results.html'));
});

const server = app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});

server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, socket => {
    wss.emit('connection', socket, request);
  });
});