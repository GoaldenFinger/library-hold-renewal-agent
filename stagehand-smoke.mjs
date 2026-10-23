import dotenv from "dotenv";
import { browserbase, Stagehand } from "@browserbasehq/stagehand";

dotenv.config({ path: ".env" });

let browser;
let stagehand;

try {
  browser = await browserbase.launch({
    apiKey: process.env.BROWSERBASE_API_KEY
  });
  stagehand = await Stagehand.create({ browser });

  const page = await stagehand.browser.context.newPage();
  await page.goto("https://opacdemo.kohasupport.com/");

  const links = await page.evaluate(() =>
    Array.from(document.querySelectorAll("a"))
      .filter(a => /my account|my loans|catalogue/i.test(a.innerText))
      .map(a => ({
        text: a.innerText.trim(),
        href: a.href,
        visible: a.getClientRects().length > 0
      }))
  );

  console.log(JSON.stringify(links, null, 2));
} catch (error) {
  console.error("Inspection failed:", error.message);
  process.exitCode = 1;
} finally {
  if (stagehand) await stagehand.close().catch(() => {});
  else if (browser) await browser.close().catch(() => {});
}
