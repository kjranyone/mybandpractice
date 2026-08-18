import puppeteer from "puppeteer-core";
const browser = await puppeteer.launch({
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  headless: "new",
  args: ["--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
await page.goto("http://localhost:5173/", { waitUntil: "networkidle2" });
await page.waitForSelector(".song-row", { timeout: 10000 });
const rows = await page.$$(".song-row");
for (const r of rows) {
  const t = await r.evaluate((el) => el.textContent);
  if (t.includes("Tiger Punch")) { await r.click(); break; }
}
await new Promise((r) => setTimeout(r, 600));
await page.click(".mixer-toggle");
await page.waitForSelector(".mixer-card", { timeout: 5000 });
const m = await page.evaluate(() => {
  const q = (s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  };
  return {
    speedSlider: q(".speed-slider"),
    pitchSlider: q(".pitch-slider"),
    stemTrack: q(".mx-fader-track"),
  };
});
console.log(JSON.stringify(m));
// slider still interactive
const sl = await page.$(".pitch-slider");
await sl.evaluate((el) => {
  const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  s.call(el, "3");
  el.dispatchEvent(new Event("input", { bubbles: true }));
});
await new Promise((r) => setTimeout(r, 400));
const chip = await page.$eval(".mixer-toggle", (e) => e.textContent);
console.log("chip:", JSON.stringify(chip));
await page.screenshot({ path: "thick.png" });
await browser.close();
