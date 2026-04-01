import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(__dirname, "..", "deals");
const BASE_URL = "https://onlineshopping.flysas.com";
const LOCALE = "en-SE";
const ALL_SHOPS_URL = `${BASE_URL}/${LOCALE}/all-shops`;

async function scrapeAllShops() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    locale: "en-SE",
  });
  const page = await context.newPage();

  const allDeals = [];
  let pageNum = 1;
  let hasNextPage = true;

  console.log("Starting SAS Online Shopping scraper...");

  while (hasNextPage) {
    const url = `${ALL_SHOPS_URL}/${pageNum}`;
    console.log(`Fetching page ${pageNum}: ${url}`);

    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
    } catch (err) {
      console.log(`Page ${pageNum} failed to load: ${err.message}`);
      break;
    }

    // Wait for shop cards to appear
    try {
      await page.waitForSelector(
        'a[href*="/shops/"], .shop-card, .store-card, [class*="shop"], [class*="store"], [class*="merchant"]',
        { timeout: 10000 }
      );
    } catch {
      console.log(`No shop elements found on page ${pageNum}, trying broader selectors...`);
    }

    // Extract deals from the page using multiple selector strategies
    const pageDeals = await page.evaluate((baseUrl) => {
      const deals = [];

      // Strategy 1: Find all links that point to /shops/ detail pages
      const shopLinks = document.querySelectorAll('a[href*="/shops/"]');
      const seenHrefs = new Set();

      for (const link of shopLinks) {
        const href = link.getAttribute("href");
        if (!href || seenHrefs.has(href)) continue;
        seenHrefs.add(href);

        // Get the card/container element (walk up the DOM)
        let card = link.closest(
          '[class*="card"], [class*="shop"], [class*="store"], [class*="merchant"], [class*="item"], li, article'
        ) || link;

        // Extract store name
        const nameEl =
          card.querySelector("h2, h3, h4, [class*='name'], [class*='title'], strong") ||
          link.querySelector("h2, h3, h4, [class*='name'], [class*='title'], strong");
        let name = nameEl ? nameEl.textContent.trim() : "";

        // If no name found, try the link text or image alt
        if (!name) {
          const img = card.querySelector("img");
          name = img ? img.alt || "" : link.textContent.trim();
        }

        // Extract points info
        const allText = card.textContent || "";
        const pointsMatch = allText.match(
          /(\d+[\s,.]?\d*)\s*(points?|poäng|bonus\s*points?|EuroBonus\s*points?|p\/\d+|pts?)/i
        );
        const ptsPerKrMatch = allText.match(
          /(\d+[\s,.]?\d*)\s*(points?|poäng|pts?)\s*(?:per|\/|for\s+every)\s*(\d+)\s*(kr|SEK|NOK|DKK)/i
        );
        const percentMatch = allText.match(/(\d+[\s,.]?\d*)\s*%/);
        const memberPointsMatch = allText.match(
          /(\d+[\s,.]?\d*)\s*(member\s*points?|level\s*points?|kvalificerings)/i
        );

        let pointsText = "";
        let bonusPoints = "";
        let memberPoints = "";

        if (ptsPerKrMatch) {
          pointsText = `${ptsPerKrMatch[1]} points per ${ptsPerKrMatch[3]} ${ptsPerKrMatch[4]}`;
          bonusPoints = ptsPerKrMatch[1];
        } else if (pointsMatch) {
          pointsText = pointsMatch[0];
          bonusPoints = pointsMatch[1];
        } else if (percentMatch) {
          pointsText = `${percentMatch[1]}%`;
        }

        if (memberPointsMatch) {
          memberPoints = memberPointsMatch[1];
        }

        // Extract category
        const categoryEl = card.querySelector(
          '[class*="category"], [class*="tag"], [class*="label"], .badge, [class*="segment"]'
        );
        const category = categoryEl ? categoryEl.textContent.trim() : "";

        // Build full URL
        const fullHref = href.startsWith("http") ? href : `${baseUrl}${href}`;

        if (name) {
          deals.push({
            name,
            pointsText,
            bonusPoints,
            memberPoints,
            category,
            url: fullHref,
            rawText: allText.substring(0, 500).replace(/\s+/g, " ").trim(),
          });
        }
      }

      // Strategy 2: If no links found, try to get data from any visible card-like elements
      if (deals.length === 0) {
        const cards = document.querySelectorAll(
          '[class*="card"], [class*="shop"], [class*="store"], [class*="merchant"]'
        );
        for (const card of cards) {
          const name =
            card.querySelector("h2, h3, h4, [class*='name'], [class*='title']")?.textContent?.trim() || "";
          const allText = card.textContent || "";
          const link = card.querySelector("a");
          const href = link ? link.getAttribute("href") || "" : "";

          if (name) {
            deals.push({
              name,
              pointsText: allText.substring(0, 200).replace(/\s+/g, " ").trim(),
              bonusPoints: "",
              memberPoints: "",
              category: "",
              url: href.startsWith("http") ? href : href ? `${baseUrl}${href}` : "",
              rawText: allText.substring(0, 500).replace(/\s+/g, " ").trim(),
            });
          }
        }
      }

      return deals;
    }, BASE_URL);

    console.log(`  Found ${pageDeals.length} deals on page ${pageNum}`);
    allDeals.push(...pageDeals);

    // Check if there's a next page
    hasNextPage = await page.evaluate((currentPage) => {
      // Look for pagination links
      const nextLink = document.querySelector(
        'a[href*="all-shops/' + (currentPage + 1) + '"], [class*="next"], [aria-label="Next"], a[rel="next"]'
      );
      // Also check if current page had no results
      return !!nextLink;
    }, pageNum);

    if (hasNextPage) {
      pageNum++;
      // Be polite - wait between requests
      await new Promise((r) => setTimeout(r, 2000));
    }

    // Safety limit
    if (pageNum > 30) {
      console.log("Reached page limit (30), stopping.");
      break;
    }
  }

  await browser.close();
  return allDeals;
}

async function scrapeShopDetails(deals) {
  if (deals.length === 0) return deals;

  // For deals missing category or points, scrape individual shop pages
  const needsDetail = deals.filter((d) => !d.category || !d.bonusPoints);
  if (needsDetail.length === 0) return deals;

  console.log(`\nScraping details for ${needsDetail.length} shops...`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    locale: "en-SE",
  });

  for (let i = 0; i < needsDetail.length; i++) {
    const deal = needsDetail[i];
    if (!deal.url) continue;

    console.log(`  [${i + 1}/${needsDetail.length}] ${deal.name}`);

    const page = await context.newPage();
    try {
      await page.goto(deal.url, { waitUntil: "networkidle", timeout: 15000 });

      const details = await page.evaluate(() => {
        const text = document.body?.textContent || "";
        const pointsMatch = text.match(
          /(\d+[\s,.]?\d*)\s*(points?|poäng|bonus\s*points?)\s*(?:per|\/|for\s+every)\s*(\d+)\s*(kr|SEK|NOK|DKK)/i
        );
        const fixedPointsMatch = text.match(/(\d+[\s,.]?\d*)\s*(bonus\s*points?|EuroBonus\s*points?)/i);
        const memberPtsMatch = text.match(/(\d+[\s,.]?\d*)\s*(member\s*points?|level\s*points?)/i);
        const categoryEl = document.querySelector(
          '[class*="category"], [class*="tag"], .breadcrumb, [class*="segment"]'
        );

        return {
          bonusPoints: pointsMatch
            ? pointsMatch[1]
            : fixedPointsMatch
              ? fixedPointsMatch[1]
              : "",
          memberPoints: memberPtsMatch ? memberPtsMatch[1] : "",
          category: categoryEl ? categoryEl.textContent.trim() : "",
          pointsText: pointsMatch
            ? `${pointsMatch[1]} points per ${pointsMatch[3]} ${pointsMatch[4]}`
            : fixedPointsMatch
              ? `${fixedPointsMatch[1]} bonus points`
              : "",
        };
      });

      if (details.bonusPoints && !deal.bonusPoints) deal.bonusPoints = details.bonusPoints;
      if (details.memberPoints && !deal.memberPoints) deal.memberPoints = details.memberPoints;
      if (details.category && !deal.category) deal.category = details.category;
      if (details.pointsText && !deal.pointsText) deal.pointsText = details.pointsText;
    } catch (err) {
      console.log(`    Failed: ${err.message}`);
    } finally {
      await page.close();
    }

    // Be polite
    await new Promise((r) => setTimeout(r, 1500));
  }

  await browser.close();
  return deals;
}

async function main() {
  try {
    let deals = await scrapeAllShops();
    console.log(`\nTotal deals found: ${deals.length}`);

    if (deals.length > 0) {
      deals = await scrapeShopDetails(deals);
    }

    // Deduplicate by name
    const seen = new Set();
    const unique = [];
    for (const deal of deals) {
      const key = deal.name.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(deal);
      }
    }

    // Clean up - remove rawText from output
    const output = unique.map((d) => ({
      name: d.name,
      bonusPoints: d.bonusPoints,
      memberPoints: d.memberPoints,
      pointsText: d.pointsText,
      category: d.category,
      url: d.url,
    }));

    const result = {
      fetchedAt: new Date().toISOString(),
      source: "https://onlineshopping.flysas.com",
      totalDeals: output.length,
      deals: output,
    };

    mkdirSync(OUTPUT_DIR, { recursive: true });
    const outPath = join(OUTPUT_DIR, "data.json");
    writeFileSync(outPath, JSON.stringify(result, null, 2));
    console.log(`\nWrote ${output.length} deals to ${outPath}`);
  } catch (err) {
    console.error("Scraper failed:", err);
    process.exit(1);
  }
}

main();
