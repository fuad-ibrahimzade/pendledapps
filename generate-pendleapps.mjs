#!/usr/bin/env node
/**
 * Collects the website of every token listed on the Pendle markets page
 * (https://app.pendle.finance/trade/markets?sort=highestYtLeverage) and saves it
 * to pendleapps-YYYY-MM-DD.md next to this script.
 *
 * - First run of a day: creates the file with one URL per listed token.
 * - Later runs that day: appends only URLs not already in that file.
 *
 * Data comes from the same endpoints the Pendle app uses:
 *   /bff/v2/app-init           -> which tokens (market groups) are listed
 *   /core/v2/markets/all       -> each market's "built on" protocol website
 *
 * Usage: node generate-pendleapps.mjs
 */

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const API = "https://api-v2.pendle.finance";
const HEADERS = {
  accept: "application/json, text/plain, */*",
  origin: "https://app.pendle.finance",
  referer: "https://app.pendle.finance/",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36",
  "x-sdk-ui-version": "4.4.13",
};

// Product/app subdomains are collapsed to the protocol's main site.
const STRIP_SUBDOMAINS = new Set(["www", "app", "stake", "quest", "yaps"]);

// Tokens that have no "built on" link in the API, or where the linked site is a
// product page rather than the issuer's own site. Values are used verbatim.
const URL_OVERRIDES = {
  "savUSD (Avant Protocol)": "https://avantprotocol.com",
  "tmvUSDC (Term Finance)": "https://term.finance",
  "sthUSD": "https://theo.xyz",
  "RoyAPYUSD (Royco)": "https://royco.org",
  "nOPAL (Nest)": "https://nest.credit",
  "AVLT (Altura Trade)": "https://www.altura.trade",
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getJson(url, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, {
        headers: HEADERS,
        signal: AbortSignal.timeout(45_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.json();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(1_000 * attempt);
    }
  }
  throw lastError;
}

function normalizeWebsite(rawUrl) {
  const url = new URL(rawUrl);
  let host = url.hostname.toLowerCase();
  const labels = host.split(".");
  if (labels.length > 2 && STRIP_SUBDOMAINS.has(labels[0])) {
    host = labels.slice(1).join(".");
  }
  return `https://${host}`;
}

function todayLocal() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

async function fetchAllMarkets() {
  const pageSize = 100;
  const first = await getJson(`${API}/core/v2/markets/all?limit=${pageSize}&skip=0`);
  const results = [...(first.results ?? [])];
  const total = first.total ?? results.length;

  for (let skip = pageSize; skip < total; skip += pageSize) {
    const page = await getJson(`${API}/core/v2/markets/all?limit=${pageSize}&skip=${skip}`);
    results.push(...(page.results ?? []));
  }
  return results;
}

/** Tokens currently listed on the markets page, in page order. */
async function fetchListedGroups() {
  const appInit = await getJson(`${API}/bff/v2/app-init?chainStatus=active`);
  const groups = appInit?.marketData?.groups ?? [];
  const markets = appInit?.markets;
  if (!groups.length || !markets?.chainIdList) {
    throw new Error("Unexpected app-init response: no market groups found");
  }

  const active = markets.chainIdList
    .map((chainId, index) => ({
      chainId,
      address: markets.addressList[index],
      groupId: markets.groupIdList[index],
      underlyingAsset: markets.underlyingAssetList[index],
      isActive: markets.isActiveList[index],
    }))
    .filter((market) => market.isActive && market.groupId);

  return { groups, active };
}

function websiteForGroup(group, activeMarkets, allMarkets) {
  if (URL_OVERRIDES[group.name]) return URL_OVERRIDES[group.name];

  const entries = activeMarkets.get(group.id) ?? [];
  for (const entry of entries) {
    const candidates = [
      ...(allMarkets.byUnderlying.get(entry.underlyingAsset) ?? []),
      ...(allMarkets.byAddress.get(`${entry.chainId}-${entry.address}`) ?? []),
    ];
    for (const market of candidates) {
      const link = market?.marketInfo?.utilizedProtocols?.find(
        (protocol) => protocol?.url,
      );
      if (link) return normalizeWebsite(link.url);
    }
  }
  return null;
}

async function main() {
  const { groups, active } = await fetchListedGroups();
  const markets = await fetchAllMarkets();

  const allMarkets = { byUnderlying: new Map(), byAddress: new Map() };
  for (const market of markets) {
    const push = (map, key) => {
      if (!key) return;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(market);
    };
    push(allMarkets.byUnderlying, market.underlyingAsset);
    push(allMarkets.byAddress, `${market.chainId}-${market.address}`);
  }

  const activeMarkets = new Map();
  for (const market of active) {
    if (!activeMarkets.has(market.groupId)) activeMarkets.set(market.groupId, []);
    activeMarkets.get(market.groupId).push(market);
  }

  const urls = [];
  const unresolved = [];
  for (const group of groups) {
    const website = websiteForGroup(group, activeMarkets, allMarkets);
    if (website) urls.push(website);
    else unresolved.push(group.name);
  }

  if (!urls.length) throw new Error("No websites resolved; aborting");

  const fileName = `pendleapps-${todayLocal()}.md`;
  const filePath = path.join(import.meta.dirname, fileName);

  if (!existsSync(filePath)) {
    await writeFile(filePath, `${urls.join("\n")}\n`, "utf8");
    console.log(`Created ${fileName} with ${urls.length} websites.`);
  } else {
    const current = await readFile(filePath, "utf8");
    const existing = new Set(
      current
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    );
    const newUrls = urls.filter((url) => !existing.has(url));

    if (!newUrls.length) {
      console.log(`No new websites for ${fileName}.`);
    } else {
      const separator = current.length && !current.endsWith("\n") ? "\n" : "";
      await writeFile(
        filePath,
        `${current}${separator}${newUrls.join("\n")}\n`,
        "utf8",
      );
      console.log(`Added ${newUrls.length} new websites to ${fileName}.`);
    }
  }

  if (unresolved.length) {
    console.warn(
      `Skipped ${unresolved.length} token(s) with no website: ${unresolved.join(", ")}`,
    );
  }
}

main().catch((error) => {
  console.error(`Failed: ${error.message}`);
  process.exitCode = 1;
});
