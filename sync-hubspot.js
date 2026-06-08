const fs = require("fs");
const path = require("path");
const { Client } = require("@hubspot/api-client");
const { scrape, createBrowser } = require("./index.js");

const hubspot = new Client({ accessToken: process.env.HUBSPOT_ACCESS_TOKEN.trim() });
const listId = process.env.HUBSPOT_SEGMENT_ID || "395";
const limit = parseInt(process.env.LIMIT || process.argv[2] || "0", 10) || 0;
const progressPath = path.join(__dirname, "progress.json");

const enheter = JSON.parse(
  fs.readFileSync(path.join(__dirname, "enheter_sokeresultat.json"), "utf8"),
);

function loadStartIndex() {
  if (process.env.RESET_PROGRESS === "1") return 0;
  if (process.env.OFFSET) return parseInt(process.env.OFFSET, 10) || 0;
  try {
    return JSON.parse(fs.readFileSync(progressPath)).nextIndex || 0;
  } catch {
    return 0;
  }
}

function saveProgress(nextIndex) {
  fs.writeFileSync(
    progressPath,
    JSON.stringify({ nextIndex, total: enheter.length, updatedAt: new Date().toISOString() }, null, 2),
  );
}

const startIndex = loadStartIndex();
const endIndex = limit ? Math.min(startIndex + limit, enheter.length) : enheter.length;
const batch = enheter.slice(startIndex, endIndex);

function companyProps(enhet) {
  const addr = enhet.forretningsadresse || enhet.postadresse || {};
  return {
    name: enhet.navn,
    organisasjonsnummer: enhet.organisasjonsnummer,
    address: (addr.adresse || []).join(", "),
    city: addr.poststed || "",
    zip: addr.postnummer || "",
    country: addr.land || "Norge",
  };
}

async function findCompany(name) {
  const result = await hubspot.crm.companies.searchApi.doSearch({
    filterGroups: [{ filters: [{ propertyName: "name", operator: "EQ", value: name }] }],
    properties: ["name"],
    limit: 1,
  });
  return result.results?.[0] || null;
}

async function saveCompany(enhet, existing, props) {
  if (existing) {
    await hubspot.crm.companies.basicApi.update(existing.id, { properties: props });
    return { id: existing.id, action: "updated" };
  }
  const created = await hubspot.crm.companies.basicApi.create({ properties: props });
  return { id: created.id, action: "created" };
}

async function upsertCompany(enhet) {
  const props = companyProps(enhet);
  const existing = await findCompany(enhet.navn);
  try {
    return await saveCompany(enhet, existing, props);
  } catch (error) {
    if (error.code !== 400 || !props.organisasjonsnummer) throw error;
    console.log("  company: retry without organisasjonsnummer (create property in HubSpot)");
    delete props.organisasjonsnummer;
    return await saveCompany(enhet, existing, props);
  }
}

async function addToList(companyId) {
  try {
    await hubspot.crm.lists.membershipsApi.add(listId, [companyId]);
    return "added to segment";
  } catch (error) {
    const message = error.body?.message || error.message || String(error);
    if (/already|member|duplicate/i.test(message)) return "already in segment";
    return `segment failed: ${message}`;
  }
}

async function createContact(companyId, companyName, person) {
  if (!person.name?.trim()) return "skipped (no name)";
  const parts = person.name.trim().split(/\s+/);
  let digits = String(person.phone || "").replace(/\D/g, "");
  if (digits.startsWith("47")) digits = digits.slice(2);
  const phone = digits ? `+47${digits}` : undefined;
  const props = {
    firstname: parts[0] || "Kontakt",
    lastname: parts.slice(1).join(" ") || ".",
    jobtitle: person.role || "",
    company: companyName,
    ...(phone ? { phone } : {}),
  };
  try {
    const contact = await hubspot.crm.contacts.basicApi.create({ properties: props });
    await hubspot.crm.associations.v4.basicApi.createDefault(
      "contacts",
      contact.id,
      "companies",
      companyId,
    );
    return `created ${person.name}${phone ? ` ${phone}` : ""}`;
  } catch (error) {
    if (phone && /INVALID_PHONE_NUMBER/i.test(JSON.stringify(error.body || error.message))) {
      try {
        delete props.phone;
        const contact = await hubspot.crm.contacts.basicApi.create({ properties: props });
        await hubspot.crm.associations.v4.basicApi.createDefault(
          "contacts",
          contact.id,
          "companies",
          companyId,
        );
        return `created ${person.name} (no phone, invalid number)`;
      } catch (retryError) {
        return `failed ${person.name}: ${retryError.body?.message || retryError.message || retryError}`;
      }
    }
    return `failed ${person.name}: ${error.body?.message || error.message || error}`;
  }
}

async function processEnhet(enhet, browser, page) {
  const addr = enhet.forretningsadresse || enhet.postadresse || {};
  console.log(`\n=== ${enhet.navn} (${enhet.organisasjonsnummer}) ===`);
  console.log(
    `  address: ${(addr.adresse || []).join(", ")}, ${addr.postnummer || ""} ${addr.poststed || ""}`,
  );

  console.log("  company: searching HubSpot...");
  const company = await upsertCompany(enhet);
  console.log(`  company: ${company.action} id ${company.id}`);

  console.log(`  segment: adding to list ${listId}...`);
  console.log(`  segment: ${await addToList(company.id)}`);

  console.log("  scrape: starting...");
  const scrapeStart = Date.now();
  const tick = setInterval(
    () => console.log(`  scrape: still working... ${Math.round((Date.now() - scrapeStart) / 1000)}s`),
    15000,
  );
  const people = await scrape(enhet.navn, {
    browser,
    page,
    quiet: true,
    companyLabel: enhet.navn,
  });
  clearInterval(tick);
  console.log(`  scrape: found ${people.length} roles in ${Math.round((Date.now() - scrapeStart) / 1000)}s`);

  let contactsCreated = 0;
  let contactsFailed = 0;
  for (const person of people) {
    const result = await createContact(company.id, enhet.navn, person);
    console.log(`  contact: ${result}`);
    if (result.startsWith("created")) contactsCreated++;
    else if (result.startsWith("failed")) contactsFailed++;
  }

  console.log(
    `  done: company ${company.action}, ${contactsCreated} contacts created, ${contactsFailed} failed, ${people.length} roles scraped`,
  );
}

async function main() {
  if (startIndex >= enheter.length) {
    console.log(`All ${enheter.length} enheter done. Run: pm2 stop brl-sync`);
    await new Promise(() => {});
  }
  if (!batch.length) {
    console.log("Nothing to sync in this batch.");
    return;
  }

  console.log(
    `Sync ${batch.length} enheter (index ${startIndex}-${endIndex - 1} of ${enheter.length}, segment ${listId})`,
  );

  let browser = await createBrowser();
  let page = await browser.newPage();

  for (let i = 0; i < batch.length; i++) {
    const index = startIndex + i;
    try {
      await processEnhet(batch[i], browser, page);
      saveProgress(index + 1);
    } catch (error) {
      console.error(`  ERROR on ${batch[i].navn}: ${error.message || error}`);
      try {
        await browser.close();
      } catch {}
      browser = await createBrowser();
      page = await browser.newPage();
      saveProgress(index + 1);
    }
  }

  await browser.close();
  if (loadStartIndex() >= enheter.length || endIndex >= enheter.length) {
    console.log("\nAll enheter synced.");
  } else {
    console.log(`\nBatch finished. Resume from index ${endIndex}.`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
