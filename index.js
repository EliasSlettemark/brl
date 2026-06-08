const puppeteerCore = require("puppeteer-core");
const { addExtra } = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const puppeteer = addExtra(puppeteerCore);
puppeteer.use(StealthPlugin());

const launchOptions = {
  executablePath: process.env.CHROME_EXECUTABLE_PATH,
  headless: process.env.HEADLESS !== "false",
  args: ["--lang=nb-NO", "--no-sandbox", "--disable-setuid-sandbox"],
  defaultViewport: { width: 1280, height: 800 },
};

const scrape = async (searchQuery, options = {}) => {
  const quiet = options.quiet === true;
  const companyLabel = options.companyLabel || searchQuery;
  const log = quiet ? () => {} : (line) => console.log(line);
  const logErr = quiet ? () => {} : (line) => console.error(line);

  const ownsBrowser = !options.browser;
  const browser =
    options.browser ||
    (await puppeteer.launch(launchOptions));

  const page = options.page || (await browser.newPage());
  await page.setExtraHTTPHeaders({
    "Accept-Language": "nb-NO,nb;q=0.9,en;q=0.8",
  });
  await page.setDefaultNavigationTimeout(90000);
  await page.setDefaultTimeout(60000);

  const results = [];
  const seen = new Set();
  const paths = new Set();

  try {
    for (
      let n = 1;
      n <=
      (parseInt(process.env.MAX_REGNSKAP_SEARCH_PAGES || "2", 10) || 2);
      n += 1
    ) {
      await page.goto(
        `https://www.regnskapstall.no/?query=${encodeURIComponent(searchQuery)}&page=${n}`,
        { waitUntil: "networkidle2" }
      );
      if ((await page.$$eval("div.listing__body", (el) => el.length)) === 0)
        break;

      for (const path of await page.evaluate(() => {
        const out = new Set();
        for (const a of document.querySelectorAll(
          "div.listing__body a[href], p.listing__rel a[href]"
        )) {
          let path = "";
          try {
            path = new URL(a.getAttribute("href") || "", "https://www.regnskapstall.no")
              .pathname;
          } catch {
            path = ((a.getAttribute("href") || "").split("?")[0] || "").trim();
          }
          if (path.includes("/roller-og-eiere")) out.add(path);
          else if (path.startsWith("/informasjon-om-")) {
            const slug = path.slice("/informasjon-om-".length);
            if (slug) out.add(`/roller-og-eiere-av-${slug}`);
          }
        }
        return [...out];
      })) {
        paths.add(path);
      }
    }

    const words = searchQuery.toLowerCase().split(/\s+/).filter((w) => w.length > 1);

    const maxRollerPages =
      parseInt(process.env.MAX_ROLLER_PAGES || "1", 10) || 1;

    for (const path of [...paths]
      .sort((a, b) => {
        const score = (p) =>
          words.reduce((n, w) => n + (p.toLowerCase().includes(w) ? 1 : 0), 0);
        return score(b) - score(a) || a.localeCompare(b);
      })
      .slice(0, maxRollerPages)) {
      const url = `https://www.regnskapstall.no${path.startsWith("/") ? path : "/" + path}`;
      const org = (path.match(/(\d+S\d+)$/i) || [])[1] || path;

      await page.goto(url, { waitUntil: "networkidle2" });
      await page
        .evaluate(() => {
          const btn = [...document.querySelectorAll("button")].find((b) =>
            /accept|godta|agree|alle/i.test(b.textContent || "")
          );
          if (btn) btn.click();
        })
        .catch(() => {});
      await page
        .waitForSelector("div.panel-body table.table-infopage tbody tr", {
          timeout: 30000,
        })
        .catch(() => {});

      log("");
      log(companyLabel);
      log(`Phone numbers (${org})`);
      log("Role\tName\tPhone");

      for (const row of await page.$$eval(
        "div.panel-body table.table-infopage tbody tr",
        (trs) =>
          trs
            .map((tr) => {
              const tds = tr.querySelectorAll("td");
              if (tds.length < 2) return null;
              return {
                role: (tds[0].textContent || "").trim(),
                links: [...tds[1].querySelectorAll("a[href]")].map((a) => ({
                  href: a.getAttribute("href") || "",
                  text: (a.textContent || "").trim(),
                })),
              };
            })
            .filter(Boolean)
      )) {
        for (const link of row.links) {
          const href = link.href.split("?")[0];
          let person = null;
          const m = href.match(/^\/roller-(.+)_(\d+)$/i);
          if (m) {
            person = {
              role: row.role,
              linkLabel: link.text,
              matchKey: `${m[1]}_${m[2]}`,
              searchTerms: m[1].replace(/-/g, " "),
              sourceHref: href,
              companyRollerUrl: url,
            };
          } else if (href.startsWith("/informasjon-om-")) {
            const slug = href.replace(/^\/informasjon-om-/, "");
            const tail = (slug.match(/(\d+)([A-Z]\d+)?$/i) || [])[0] || "";
            person = {
              role: row.role,
              linkLabel: link.text,
              matchKey: tail || slug.toLowerCase(),
              searchTerms: (tail ? slug.slice(0, -(tail.length + 1)) : slug)
                .replace(/-/g, " ")
                .trim(),
              sourceHref: href,
              companyRollerUrl: url,
            };
          }
          if (!person) continue;
          if (seen.has(`${person.companyRollerUrl}|${person.matchKey}|${person.sourceHref}`))
            continue;
          seen.add(`${person.companyRollerUrl}|${person.matchKey}|${person.sourceHref}`);

          person.name = (person.linkLabel || "").trim()
            ? person.linkLabel.replace(/\s*\(f\s*\d{4}\)\s*$/i, "").trim()
            : person.searchTerms
                .split(/\s+/)
                .map((w) =>
                  w.length <= 2 && w === w.toLowerCase()
                    ? w.toUpperCase()
                    : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
                )
                .join(" ");

          await page.goto(
            `https://www.1881.no/?query=${encodeURIComponent(person.searchTerms)}`,
            { waitUntil: "networkidle2" }
          );
          await page
            .waitForSelector(
              ".listing__main, .listing-name a, a[href*='/person/']",
              { timeout: 45000 }
            )
            .catch(() => {});

          try {
            const href1881 = await page.evaluate((key) => {
              const links = [...document.querySelectorAll("a[href]")].filter((el) => {
                const href = el.getAttribute("href") || "";
                return (
                  href.includes(key) &&
                  !/vCard/i.test(href) &&
                  !/\.vcf/i.test(href)
                );
              });
              const a =
                links.find((el) => /\/person\//i.test(el.getAttribute("href") || "")) ||
                links[0];
              return a ? a.getAttribute("href") : null;
            }, person.matchKey);

            if (!href1881) {
              log(`${person.role}\t${person.name}\t(no 1881 match)`);
              results.push({ ...person, phone: null, detailUrl: null });
              continue;
            }

            person.detailUrl = href1881.startsWith("http")
              ? href1881
              : `https://www.1881.no${href1881.startsWith("/") ? href1881 : "/" + href1881}`;

            if (/vCard|\.vcf/i.test(person.detailUrl)) {
              log(`${person.role}\t${person.name}\t(skip vCard)`);
              results.push({ ...person, phone: null, detailUrl: null });
              continue;
            }

            await page.goto(person.detailUrl, {
              waitUntil: "networkidle2",
            }).catch(() =>
              page.goto(person.detailUrl, { waitUntil: "domcontentloaded" })
            );

            person.phone = await page.evaluate(() => {
              const a = document.querySelector('a[href^="tel:"]');
              if (!a) return null;
              const span = a.querySelector(".listing-main-buttons__phone-number");
              return (
                (span && span.textContent.trim()) ||
                (a.getAttribute("href") || "").replace(/^tel:/i, "").replace(/\D/g, "") ||
                a.getAttribute("href")
              );
            });

            if (!person.phone) {
              log(`${person.role}\t${person.name}\t(no phone)`);
              results.push({ ...person });
              continue;
            }

            log(`${person.role}\t${person.name}\t${person.phone}`);
            results.push({ ...person });
          } catch (personErr) {
            logErr(`${person.role}\t${person.name}\t(${personErr.message})`);
            results.push({ ...person, phone: null, detailUrl: null });
          }
        }
      }
    }

    return results;
  } catch (error) {
    logErr(error);
    return results;
  } finally {
    if (ownsBrowser) await browser.close();
  }
};

if (require.main === module) {
  scrape(process.argv[2] || "Sameiet Badebakken")
    .then((results) => console.log(JSON.stringify(results, null, 2)))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

const createBrowser = () => puppeteer.launch(launchOptions);

module.exports = { scrape, scrapePhonesFromRegnskapSearch: scrape, createBrowser };
