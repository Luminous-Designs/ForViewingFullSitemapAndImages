const axios = require('axios');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const xml2js = require('xml2js');
const express = require('express');
const WebSocket = require('ws');
const crypto = require('crypto');

const app = express();
const port = 3000;

app.use(express.static('public'));
app.use(express.json());

const wss = new WebSocket.Server({ noServer: true });

function generateSafeFilename(url) {
  return crypto.createHash('md5').update(url).digest('hex') + '.png';
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
  try {
    await page.setViewport({ width: 1600, height: 900 });
    await page.goto(url, { 
      waitUntil: 'networkidle0',
      timeout: 60000 // Increase timeout to 60 seconds
    });
    await page.screenshot({ path: outputPath, fullPage: true });
    console.log(`Screenshot captured for: ${url}`);
  } catch (error) {
    console.error(`Error capturing screenshot for ${url}:`, error.message);
    // Create a simple error image
    await page.setContent(`<html><body><h1>Error loading page</h1><p>${error.message}</p></body></html>`);
    await page.screenshot({ path: outputPath, fullPage: true });
  } finally {
    await browser.close();
  }
}

async function extractSEOData(url) {
  console.log(`Extracting SEO data for: ${url}`);
  try {
    const response = await axios.get(url, { timeout: 30000 });
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
  } catch (error) {
    console.error(`Error extracting SEO data for ${url}:`, error.message);
    return {
      url: url,
      title: 'Error extracting SEO data',
      description: error.message
    };
  }
}

async function processUrl(url, index, total, crawlId, retries = 3) {
  const filename = generateSafeFilename(url);
  const screenshotPath = path.join(__dirname, 'public', 'screenshots', crawlId, filename);
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await captureScreenshot(url, screenshotPath);
      const seoData = await extractSEOData(url);
      return { 
        ...seoData, 
        screenshotPath: `/screenshots/${crawlId}/${filename}` 
      };
    } catch (error) {
      console.error(`Error processing ${url} (attempt ${attempt}/${retries}):`, error.message);
      if (attempt === retries) {
        return {
          url,
          title: 'Error processing page',
          description: `Failed after ${retries} attempts: ${error.message}`,
          screenshotPath: `/screenshots/${crawlId}/${filename}`
        };
      }
      // Wait for a short time before retrying
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}

app.post('/process-sitemap', async (req, res) => {
  const { sitemapUrl, concurrency = 5 } = req.body;
  const crawlId = Date.now().toString();
  res.json({ message: 'Processing started', crawlId });

  const urls = await parseSitemap(sitemapUrl);
  const results = [];

  // Create necessary directories
  const screenshotsDir = path.join(__dirname, 'public', 'screenshots', crawlId);
  const resultsDir = path.join(__dirname, 'public', 'results');
  await fs.mkdir(screenshotsDir, { recursive: true });
  await fs.mkdir(resultsDir, { recursive: true });

  for (let i = 0; i < urls.length; i += concurrency) {
    const batch = urls.slice(i, i + concurrency);
    console.log(`Processing batch ${i / concurrency + 1} of ${Math.ceil(urls.length / concurrency)}`);
    
    const batchResults = await Promise.all(
      batch.map(url => processUrl(url, i + batch.indexOf(url), urls.length, crawlId))
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
  const resultsPath = path.join(resultsDir, `${crawlId}.json`);
  await fs.writeFile(resultsPath, JSON.stringify(results, null, 2));
  console.log('Results saved.');

  // Send completion message
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({
        type: 'complete',
        resultsUrl: `/results.html?crawlId=${crawlId}`
      }));
    }
  });
});

app.get('/results/:crawlId', (req, res) => {
  const crawlId = req.params.crawlId;
  const resultsPath = path.join(__dirname, 'public', 'results', `${crawlId}.json`);
  
  if (fsSync.existsSync(resultsPath)) {
    res.sendFile(resultsPath);
  } else {
    res.status(404).json({ error: 'Crawl results not found' });
  }
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