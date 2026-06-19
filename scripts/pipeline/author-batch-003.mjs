#!/usr/bin/env node
/**
 * author-batch-003.mjs — ~105 free-to-wrap starred endpoints for the
 * first 100/day run. All single-hop GET no-auth (fits the engine). Heavy
 * on rock-solid families (World Bank indicators, NLM clinical tables,
 * OpenLibrary, openFDA, TheMealDB) so CDP indexing clears the 95% bar.
 * probe-batch.mjs trims any upstream that does not 200 before seeding.
 */
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const UA = { "User-Agent": "SuVersePay data@suverse.io" };
const rows = [];
const mk = (o) => rows.push({
  slug: o.slug, category: o.category, source: o.source,
  title: o.title, description: o.desc, descriptionBazaar: (o.bz ?? o.desc).slice(0, 320),
  tags: o.tags, priceUsdcAtomic: o.price ?? 2000,
  upstream: { url: o.url, timeoutMs: o.timeout ?? 10000, ...(o.sq ? { staticQuery: o.sq } : {}), ...(o.h ? { headers: o.h } : {}) },
  params: o.p ?? {}, sampleRequest: o.req ?? {}, sampleResponse: o.res ?? { source: o.source, data: {} },
  ...(o.pick ? { pick: o.pick } : {}),
});
const qreq = (d, e, x = {}) => ({ in: "query", required: true, type: "string", description: d, example: e, ...x });
const num = (d, e) => ({ in: "query", required: true, type: "number", description: d, example: e });
const pathp = (d, e, x = {}) => ({ in: "path", required: true, type: "string", description: d, example: e, ...x });
const ISO = { pattern: "^[A-Za-z]{2,3}$", transform: "upper" };

// ── World Bank indicators (24) — same proven country-path pattern ──
const WB = [
  ["pop-density","EN.POP.DNST","Population Density"],
  ["life-expectancy","SP.DYN.LE00.IN","Life Expectancy"],
  ["gdp-per-capita","NY.GDP.PCAP.CD","GDP Per Capita"],
  ["gni-per-capita","NY.GNP.PCAP.CD","GNI Per Capita"],
  ["poverty-headcount","SI.POV.DDAY","Poverty Headcount Ratio"],
  ["gdp-growth","NY.GDP.MKTP.KD.ZG","GDP Growth Rate"],
  ["exports-share","NE.EXP.GNFS.ZS","Exports Share Of GDP"],
  ["imports-share","NE.IMP.GNFS.ZS","Imports Share Of GDP"],
  ["fdi-inflows","BX.KLT.DINV.CD.WD","Foreign Direct Investment Inflows"],
  ["co2-per-capita","EN.ATM.CO2E.PC","CO2 Emissions Per Capita"],
  ["internet-users","IT.NET.USER.ZS","Internet Users Share"],
  ["mobile-subscriptions","IT.CEL.SETS.P2","Mobile Subscriptions Per 100"],
  ["urban-population","SP.URB.TOTL.IN.ZS","Urban Population Share"],
  ["gov-debt","GC.DOD.TOTL.GD.ZS","Central Government Debt Share Of GDP"],
  ["labor-force","SL.TLF.TOTL.IN","Total Labor Force"],
  ["health-expenditure","SH.XPD.CHEX.GD.ZS","Health Expenditure Share Of GDP"],
  ["military-expenditure","MS.MIL.XPND.GD.ZS","Military Expenditure Share Of GDP"],
  ["electricity-access","EG.ELC.ACCS.ZS","Access To Electricity Share"],
  ["renewable-energy","EG.FEC.RNEW.ZS","Renewable Energy Share"],
  ["tertiary-enrollment","SE.TER.ENRR","Tertiary School Enrollment"],
  ["agriculture-value","NV.AGR.TOTL.ZS","Agriculture Value Added Share"],
  ["manufacturing-value","NV.IND.MANF.ZS","Manufacturing Value Added Share"],
  ["services-value","NV.SRV.TOTL.ZS","Services Value Added Share"],
  ["tax-revenue","GC.TAX.TOTL.GD.ZS","Tax Revenue Share Of GDP"],
  ["birth-rate","SP.DYN.CBRT.IN","Birth Rate Per 1000"],
  ["death-rate","SP.DYN.CDRT.IN","Death Rate Per 1000"],
  ["fertility-rate","SP.DYN.TFRT.IN","Fertility Rate"],
  ["population-growth","SP.POP.GROW","Population Growth Rate"],
  ["real-interest-rate","FR.INR.RINR","Real Interest Rate"],
  ["youth-unemployment","SL.UEM.1524.ZS","Youth Unemployment Rate"],
];
for (const [s, code, label] of WB) mk({
  slug: `suverse-wb-${s}`, category: "macro", source: "worldbank",
  title: `Country ${label}`, price: 2000,
  desc: `${label} for any country by ISO code as a yearly World Bank Open Data time series, no key. Returns country, year, and value. For AI agents doing macro, demographic, and cross country analysis.`,
  tags: ["macro", "worldbank", "economic-indicators", s.split("-")[0], "country"],
  url: `https://api.worldbank.org/v2/country/{country}/indicator/${code}`, sq: { format: "json", per_page: "30" },
  p: { country: pathp("ISO 2 or 3 letter country code", "US", ISO) },
  req: { country: "US" }, res: { source: "worldbank", data: [{ page: 1 }, [{ date: "2023", value: 123 }]] },
});

// ── NLM clinical tables (7) ──
const CT = [
  ["icd10cm","icd10cm","ICD-10-CM Diagnosis Codes","diabetes"],
  ["conditions","conditions","Medical Conditions","asthma"],
  ["rxterms","rxterms","Prescribable Drug Names","metformin"],
  ["npi-individual","npi_idv","Individual Healthcare Providers (NPI)","john smith"],
  ["npi-organization","npi_org","Healthcare Organizations (NPI)","mayo clinic"],
  ["hcpcs","hcpcs","HCPCS Procedure And Supply Codes","wheelchair"],
];
for (const [s, table, label, ex] of CT) mk({
  slug: `suverse-nlm-${s}`, category: "health", source: "nlm-clinicaltables", price: 3000,
  title: `${label} Search`,
  desc: `Search ${label} from the NIH NLM Clinical Tables service by terms, no key. Returns matching codes and display names. For AI agents in health, coding, and clinical workflows.`,
  tags: ["health", "nlm", "clinical", "codes", s],
  url: `https://clinicaltables.nlm.nih.gov/api/${table}/v3/search`, sq: { maxList: "10" },
  p: { terms: qreq("Search terms", ex) }, req: { terms: ex },
  res: { source: "nlm-clinicaltables", data: [1, ["E11.9"], null, [["E11.9", "Type 2 diabetes mellitus"]]] },
});

// ── openFDA more (6) ──
const FDA = [
  ["drug-ndc","drug/ndc","Drug NDC Directory"],
  ["device-510k","device/510k","Device 510(k) Clearances"],
  ["device-classification","device/classification","Device Classifications"],
  ["food-event","food/event","Food Adverse Events"],
  ["tobacco-problem","tobacco/problem","Tobacco Problem Reports"],
  ["animalvet-event","animalandveterinary/event","Animal And Veterinary Adverse Events"],
];
for (const [s, path, label] of FDA) mk({
  slug: `suverse-openfda-${s}`, category: "health", source: "openfda", price: 4000,
  title: `openFDA ${label}`,
  desc: `Query the openFDA ${label} dataset by search expression, no key, US FDA public data. Returns matching records with structured fields. For AI agents in pharma, device, and safety research.`,
  tags: ["health", "openfda", "fda", "safety", s.split("-")[0]],
  url: `https://api.fda.gov/${path}.json`, sq: { limit: "5" },
  p: { search: { in: "query", required: false, type: "string", description: "openFDA search expression", example: "" } },
  req: {}, res: { source: "openfda", data: { meta: { results: { total: 100 } }, results: [{}] } },
});

// ── RxNorm more (2) ──
mk({ slug: "suverse-rxnorm-approximate", category: "health", source: "rxnorm", price: 3000,
  title: "RxNorm Approximate Match", desc: "Approximate-match a drug name string to RxNorm concepts from NIH RxNav, no key. Returns ranked candidate RxCUIs and names. For AI agents normalizing messy or misspelled medication names.",
  tags: ["health", "rxnorm", "drugs", "match", "nih"], url: "https://rxnav.nlm.nih.gov/REST/approximateTerm.json", sq: { maxEntries: "5" },
  p: { term: qreq("Drug name term", "ibuprofin") }, req: { term: "ibuprofin" }, res: { source: "rxnorm", data: { approximateGroup: { candidate: [{ rxcui: "5640" }] } } } });
mk({ slug: "suverse-rxnorm-spelling", category: "health", source: "rxnorm", price: 2000,
  title: "RxNorm Spelling Suggestions", desc: "Spelling suggestions for a drug name from NIH RxNav, no key. Returns corrected drug name candidates. For AI agents validating and correcting medication name input.",
  tags: ["health", "rxnorm", "spelling", "drugs", "nih"], url: "https://rxnav.nlm.nih.gov/REST/spellingsuggestions.json",
  p: { name: qreq("Drug name", "ibuprofin") }, req: { name: "ibuprofin" }, res: { source: "rxnorm", data: { suggestionGroup: { suggestionList: { suggestion: ["ibuprofen"] } } } } });

// ── disease.sh more (3) ──
mk({ slug: "suverse-disease-covid-global", category: "health", source: "disease.sh", price: 2000,
  title: "COVID Global Totals", desc: "Global COVID-19 totals from the disease.sh aggregator, no key. Returns worldwide cases, deaths, recovered, active, tests, and per million metrics. For AI agents in public health dashboards.",
  tags: ["health", "covid", "global", "disease", "stats"], url: "https://disease.sh/v3/covid-19/all",
  res: { source: "disease.sh", data: { cases: 700000000, deaths: 7000000 } } });
mk({ slug: "suverse-disease-covid-historical", category: "health", source: "disease.sh", price: 3000,
  title: "COVID Historical By Country", desc: "Historical COVID-19 case timeline for a country from disease.sh, no key, last 30 days. Returns daily cases, deaths, and recovered. For AI agents charting pandemic trends.",
  tags: ["health", "covid", "historical", "disease", "timeline"], url: "https://disease.sh/v3/covid-19/historical/{country}", sq: { lastdays: "30" },
  p: { country: pathp("Country name or ISO code", "USA") }, req: { country: "USA" }, res: { source: "disease.sh", data: { timeline: { cases: {} } } } });
mk({ slug: "suverse-disease-vaccine-coverage", category: "health", source: "disease.sh", price: 2000,
  title: "COVID Vaccine Coverage By Country", desc: "COVID-19 vaccine doses administered timeline for a country from disease.sh, no key, last 30 days. Returns daily cumulative doses. For AI agents tracking vaccination progress.",
  tags: ["health", "covid", "vaccine", "coverage", "disease"], url: "https://disease.sh/v3/covid-19/vaccine/coverage/countries/{country}", sq: { lastdays: "30" },
  p: { country: pathp("Country name or ISO code", "USA") }, req: { country: "USA" }, res: { source: "disease.sh", data: { country: "USA", timeline: {} } } });

// ── OpenLibrary (4) ──
mk({ slug: "suverse-openlibrary-search", category: "books", source: "openlibrary", price: 2000,
  title: "Open Library Book Search", desc: "Search Open Library books by title, author, or keyword, no key. Returns matching works with title, author, first publish year, and edition counts. For AI agents in books, research, and library use cases.",
  tags: ["books", "openlibrary", "search", "literature", "reference"], url: "https://openlibrary.org/search.json", sq: { limit: "10" },
  p: { q: qreq("Search query", "the hobbit") }, req: { q: "the hobbit" }, res: { source: "openlibrary", data: { numFound: 100, docs: [{ title: "The Hobbit" }] } } });
mk({ slug: "suverse-openlibrary-isbn", category: "books", source: "openlibrary", price: 2000,
  title: "Open Library ISBN Lookup", desc: "Look up a book by ISBN from Open Library, no key. Returns title, authors, publisher, publish date, and page count. For AI agents resolving ISBNs to book metadata.",
  tags: ["books", "openlibrary", "isbn", "metadata", "reference"], url: "https://openlibrary.org/isbn/{isbn}.json",
  p: { isbn: pathp("ISBN-10 or ISBN-13", "9780261103283", { pattern: "^[0-9Xx-]{10,17}$" }) }, req: { isbn: "9780261103283" }, res: { source: "openlibrary", data: { title: "The Hobbit" } } });
mk({ slug: "suverse-openlibrary-subject", category: "books", source: "openlibrary", price: 2000,
  title: "Open Library Books By Subject", desc: "Books for a subject from Open Library, no key. Returns works tagged with the subject plus counts. For AI agents discovering books by topic.",
  tags: ["books", "openlibrary", "subject", "topic", "reference"], url: "https://openlibrary.org/subjects/{subject}.json", sq: { limit: "10" },
  p: { subject: pathp("Subject keyword", "science_fiction", { transform: "lower", pattern: "^[a-zA-Z_]+$" }) }, req: { subject: "science_fiction" }, res: { source: "openlibrary", data: { name: "science fiction", works: [] } } });
mk({ slug: "suverse-openlibrary-authors", category: "books", source: "openlibrary", price: 2000,
  title: "Open Library Author Search", desc: "Search Open Library authors by name, no key. Returns matching authors with name, birth date, and work counts. For AI agents resolving author identities.",
  tags: ["books", "openlibrary", "authors", "search", "reference"], url: "https://openlibrary.org/search/authors.json",
  p: { q: qreq("Author name", "tolkien") }, req: { q: "tolkien" }, res: { source: "openlibrary", data: { docs: [{ name: "J. R. R. Tolkien" }] } } });

// ── Gutendex (1) ──
mk({ slug: "suverse-gutenberg-books", category: "books", source: "gutendex", price: 2000,
  title: "Project Gutenberg Book Search", desc: "Search free public-domain ebooks from Project Gutenberg via Gutendex, no key. Returns books with title, authors, subjects, and download links. For AI agents sourcing free full-text literature.",
  tags: ["books", "gutenberg", "public-domain", "ebooks", "literature"], url: "https://gutendex.com/books",
  p: { search: qreq("Search query", "shakespeare") }, req: { search: "shakespeare" }, res: { source: "gutendex", data: { count: 100, results: [{ title: "Hamlet" }] } } });

// ── Wikipedia / Wikidata / lexical (5) ──
mk({ slug: "suverse-wiki-random", category: "knowledge", source: "wikipedia", price: 2000,
  title: "Wikipedia Random Article", desc: "A random English Wikipedia article summary via the REST API, no key. Returns title, extract, and URL. For AI agents generating discovery, trivia, and serendipity content.",
  tags: ["knowledge", "wikipedia", "random", "encyclopedia", "trivia"], url: "https://en.wikipedia.org/api/rest_v1/page/random/summary", h: UA,
  res: { source: "wikipedia", data: { title: "Some Article", extract: "..." } } });

mk({ slug: "suverse-wikidata-search", category: "knowledge", source: "wikidata", price: 2000,
  title: "Wikidata Entity Search", desc: "Search Wikidata entities by label, no key. Returns matching entity IDs, labels, and descriptions. For AI agents resolving names to structured knowledge-graph entities.",
  tags: ["knowledge", "wikidata", "entities", "search", "graph"], url: "https://www.wikidata.org/w/api.php", h: UA, sq: { action: "wbsearchentities", language: "en", format: "json" },
  p: { search: qreq("Entity label to search", "Ethereum") }, req: { search: "Ethereum" }, res: { source: "wikidata", data: { search: [{ id: "Q131723" }] } } });
mk({ slug: "suverse-dictionary", category: "language", source: "dictionaryapi", price: 2000,
  title: "English Dictionary Lookup", desc: "Definitions, phonetics, and examples for an English word from the free Dictionary API, no key. Returns meanings, parts of speech, and synonyms. For AI agents in language, education, and writing tools.",
  tags: ["language", "dictionary", "definitions", "english", "lexical"], url: "https://api.dictionaryapi.dev/api/v2/entries/en/{word}",
  p: { word: pathp("English word", "serendipity", { pattern: "^[a-zA-Z-]{1,40}$", transform: "lower" }) }, req: { word: "serendipity" }, res: { source: "dictionaryapi", data: [{ word: "serendipity" }] } });
mk({ slug: "suverse-datamuse-related", category: "language", source: "datamuse", price: 2000,
  title: "Word Association Finder", desc: "Words related in meaning to a given word from the Datamuse API, no key. Returns ranked associated words with scores. For AI agents in writing assistance, search expansion, and word games.",
  tags: ["language", "datamuse", "words", "thesaurus", "nlp"], url: "https://api.datamuse.com/words",
  p: { ml: qreq("Word to find associations for", "ocean") }, req: { ml: "ocean" }, res: { source: "datamuse", data: [{ word: "sea", score: 5000 }] } });

// ── Semantic Scholar (1) ──


// ── OpenAlex sources (1) ──
mk({ slug: "suverse-openalex-sources", category: "academic", source: "openalex", price: 2000,
  title: "OpenAlex Sources Search", desc: "Search OpenAlex sources (journals, conferences, repositories) by name, no key. Returns matching venues with ID, name, and metadata. For AI agents discovering and validating publication venues.",
  tags: ["academic", "openalex", "sources", "journals", "research"], url: "https://api.openalex.org/sources", sq: { "per-page": "10", mailto: "data@suverse.io" },
  p: { search: qreq("Source name", "nature") }, req: { search: "nature" }, res: { source: "openalex", data: { results: [{ display_name: "Nature" }] } } });

// ── TheMealDB (6) ──
const TMDB = "https://www.themealdb.com/api/json/v1/1";
mk({ slug: "suverse-meal-search", category: "food", source: "themealdb", title: "Recipe Search By Name",
  desc: "Search recipes by name from TheMealDB, no key. Returns meals with ingredients, instructions, category, and image. For AI agents in cooking, meal planning, and food apps.",
  tags: ["food", "recipes", "themealdb", "cooking", "meals"], url: `${TMDB}/search.php`,
  p: { s: qreq("Meal name", "arrabiata") }, req: { s: "arrabiata" }, res: { source: "themealdb", data: { meals: [{ strMeal: "Spicy Arrabiata Penne" }] } } });
mk({ slug: "suverse-meal-lookup", category: "food", source: "themealdb", title: "Recipe By ID",
  desc: "Look up a full recipe by its TheMealDB id, no key. Returns the meal with ingredients, measures, and instructions. For AI agents fetching a specific recipe.",
  tags: ["food", "recipes", "themealdb", "lookup", "meals"], url: `${TMDB}/lookup.php`,
  p: { i: qreq("Meal id", "52771", { pattern: "^[0-9]{4,7}$" }) }, req: { i: "52771" }, res: { source: "themealdb", data: { meals: [{ idMeal: "52771" }] } } });
mk({ slug: "suverse-meal-random", category: "food", source: "themealdb", title: "Random Recipe",
  desc: "A random recipe from TheMealDB, no key. Returns one meal with full ingredients and instructions. For AI agents suggesting meals and generating food content.",
  tags: ["food", "recipes", "themealdb", "random", "meals"], url: `${TMDB}/random.php`,
  res: { source: "themealdb", data: { meals: [{ strMeal: "Teriyaki Chicken" }] } } });
mk({ slug: "suverse-meal-by-category", category: "food", source: "themealdb", title: "Recipes By Category",
  desc: "Recipes filtered by category from TheMealDB, no key. Returns meals in the category with thumbnails and ids. For AI agents browsing recipes by type.",
  tags: ["food", "recipes", "themealdb", "category", "meals"], url: `${TMDB}/filter.php`,
  p: { c: qreq("Category, e.g. Seafood, Dessert, Vegetarian", "Seafood", { pattern: "^[A-Za-z ]{3,20}$" }) }, req: { c: "Seafood" }, res: { source: "themealdb", data: { meals: [] } } });
mk({ slug: "suverse-meal-by-ingredient", category: "food", source: "themealdb", title: "Recipes By Ingredient",
  desc: "Recipes that use a main ingredient from TheMealDB, no key. Returns meals containing the ingredient. For AI agents building recipes around what is on hand.",
  tags: ["food", "recipes", "themealdb", "ingredient", "meals"], url: `${TMDB}/filter.php`,
  p: { i: qreq("Main ingredient", "chicken_breast", { pattern: "^[A-Za-z_ ]{3,30}$" }) }, req: { i: "chicken_breast" }, res: { source: "themealdb", data: { meals: [] } } });
mk({ slug: "suverse-meal-categories", category: "food", source: "themealdb", title: "Recipe Categories List",
  desc: "The list of recipe categories from TheMealDB, no key. Returns category names, thumbnails, and descriptions. For AI agents building food navigation.",
  tags: ["food", "recipes", "themealdb", "categories", "reference"], url: `${TMDB}/categories.php`,
  res: { source: "themealdb", data: { categories: [{ strCategory: "Seafood" }] } } });

// ── TheCocktailDB (3) ──
const TCDB = "https://www.thecocktaildb.com/api/json/v1/1";
mk({ slug: "suverse-cocktail-search", category: "food", source: "thecocktaildb", title: "Cocktail Search By Name",
  desc: "Search cocktails by name from TheCocktailDB, no key. Returns drinks with ingredients, measures, glass, and instructions. For AI agents in bartending and beverage apps.",
  tags: ["food", "cocktails", "drinks", "thecocktaildb", "bartending"], url: `${TCDB}/search.php`,
  p: { s: qreq("Cocktail name", "margarita") }, req: { s: "margarita" }, res: { source: "thecocktaildb", data: { drinks: [{ strDrink: "Margarita" }] } } });
mk({ slug: "suverse-cocktail-random", category: "food", source: "thecocktaildb", title: "Random Cocktail",
  desc: "A random cocktail from TheCocktailDB, no key. Returns one drink with full ingredients and instructions. For AI agents suggesting drinks.",
  tags: ["food", "cocktails", "drinks", "random", "thecocktaildb"], url: `${TCDB}/random.php`,
  res: { source: "thecocktaildb", data: { drinks: [{ strDrink: "Mojito" }] } } });
mk({ slug: "suverse-cocktail-by-ingredient", category: "food", source: "thecocktaildb", title: "Cocktails By Ingredient",
  desc: "Cocktails that use an ingredient from TheCocktailDB, no key. Returns drinks containing the ingredient. For AI agents building drinks around available ingredients.",
  tags: ["food", "cocktails", "ingredient", "drinks", "thecocktaildb"], url: `${TCDB}/filter.php`,
  p: { i: qreq("Ingredient", "Gin", { pattern: "^[A-Za-z ]{2,30}$" }) }, req: { i: "Gin" }, res: { source: "thecocktaildb", data: { drinks: [] } } });

// ── OpenFoodFacts (1) ──
mk({ slug: "suverse-food-barcode", category: "food", source: "openfoodfacts", title: "Food Product By Barcode",
  desc: "Look up a food product by barcode from Open Food Facts, no key. Returns product name, brand, ingredients, nutrition grade, and Nutri-Score. For AI agents in nutrition, grocery, and health apps.",
  tags: ["food", "nutrition", "barcode", "openfoodfacts", "grocery"], url: "https://world.openfoodfacts.org/api/v2/product/{barcode}.json",
  p: { barcode: pathp("Product barcode (EAN/UPC)", "737628064502", { pattern: "^[0-9]{8,14}$" }) }, req: { barcode: "737628064502" }, res: { source: "openfoodfacts", data: { product: { product_name: "Rice noodles" } } } });

// ── TheSportsDB more (5) ──
const TSDB = "https://www.thesportsdb.com/api/v1/json/3";
mk({ slug: "suverse-sports-player", category: "sports", source: "thesportsdb", title: "Sports Player Search",
  desc: "Search sports players by name from TheSportsDB, no key. Returns player id, team, sport, nationality, and position. For AI agents enriching sports queries and fantasy tools.",
  tags: ["sports", "players", "thesportsdb", "search", "reference"], url: `${TSDB}/searchplayers.php`,
  p: { p: qreq("Player name", "Messi") }, req: { p: "Messi" }, res: { source: "thesportsdb", data: { player: [{ strPlayer: "Lionel Messi" }] } } });
mk({ slug: "suverse-sports-leagues", category: "sports", source: "thesportsdb", title: "All Sports Leagues",
  desc: "The list of all leagues from TheSportsDB, no key. Returns league id, name, and sport. For AI agents resolving league ids and building sports navigation.",
  tags: ["sports", "leagues", "thesportsdb", "list", "reference"], url: `${TSDB}/all_leagues.php`,
  res: { source: "thesportsdb", data: { leagues: [{ idLeague: "4328", strLeague: "English Premier League" }] } } });
mk({ slug: "suverse-sports-next-events", category: "sports", source: "thesportsdb", title: "Next Team Events",
  desc: "Upcoming events for a team by team id from TheSportsDB, no key. Returns the next fixtures with opponents, date, and venue. For AI agents tracking a team schedule.",
  tags: ["sports", "fixtures", "thesportsdb", "upcoming", "schedule"], url: `${TSDB}/eventsnext.php`,
  p: { id: qreq("Team id", "133604", { pattern: "^[0-9]{5,8}$" }) }, req: { id: "133604" }, res: { source: "thesportsdb", data: { events: [] } } });
mk({ slug: "suverse-sports-last-events", category: "sports", source: "thesportsdb", title: "Last Team Events",
  desc: "Recent past events for a team by team id from TheSportsDB, no key. Returns the last results with scores and dates. For AI agents reviewing team form.",
  tags: ["sports", "results", "thesportsdb", "recent", "form"], url: `${TSDB}/eventslast.php`,
  p: { id: qreq("Team id", "133604", { pattern: "^[0-9]{5,8}$" }) }, req: { id: "133604" }, res: { source: "thesportsdb", data: { results: [] } } });
mk({ slug: "suverse-sports-league-detail", category: "sports", source: "thesportsdb", title: "League Detail",
  desc: "Details for a league by id from TheSportsDB, no key. Returns league name, sport, country, formed year, and description. For AI agents enriching league context.",
  tags: ["sports", "leagues", "thesportsdb", "detail", "reference"], url: `${TSDB}/lookupleague.php`,
  p: { id: qreq("League id", "4328", { pattern: "^[0-9]{3,7}$" }) }, req: { id: "4328" }, res: { source: "thesportsdb", data: { leagues: [{ strLeague: "English Premier League" }] } } });

// ── NHL (2) ──
mk({ slug: "suverse-nhl-standings", category: "sports", source: "nhl", title: "NHL Standings Now",
  desc: "Current NHL standings from the official NHL web API, no key. Returns each team with wins, losses, points, and division. For AI agents answering hockey standings questions.",
  tags: ["sports", "nhl", "hockey", "standings", "stats"], url: "https://api-web.nhle.com/v1/standings/now",
  res: { source: "nhl", data: { standings: [{ teamName: { default: "Bruins" }, points: 90 }] } } });
mk({ slug: "suverse-nhl-scores", category: "sports", source: "nhl", title: "NHL Scores By Date",
  desc: "NHL game scores for a date from the official NHL web API, no key. Returns games with teams, scores, and status. For AI agents building hockey briefings.",
  tags: ["sports", "nhl", "hockey", "scores", "schedule"], url: "https://api-web.nhle.com/v1/score/{date}",
  p: { date: pathp("Date YYYY-MM-DD", "2026-01-15", { pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" }) }, req: { date: "2026-01-15" }, res: { source: "nhl", data: { games: [] } } });

// ── Geo (8) ──
mk({ slug: "suverse-reverse-geocode", category: "geo", source: "bigdatacloud", title: "Reverse Geocode",
  desc: "Reverse geocode a latitude and longitude to a place from BigDataCloud, no key. Returns city, locality, principal subdivision, country, and codes. For AI agents turning coordinates into place names.",
  tags: ["geo", "reverse-geocode", "places", "coordinates", "location"], url: "https://api.bigdatacloud.net/data/reverse-geocode-client", sq: { localityLanguage: "en" },
  p: { latitude: num("Latitude", 48.85), longitude: num("Longitude", 2.35) }, req: { latitude: 48.85, longitude: 2.35 }, res: { source: "bigdatacloud", data: { city: "Paris", countryName: "France" } } });
mk({ slug: "suverse-country-by-name", category: "geo", source: "restcountries", title: "Country By Name",
  desc: "Look up a country by name from REST Countries, no key. Returns capital, region, population, currencies, languages, and flags. For AI agents enriching country context.",
  tags: ["geo", "countries", "restcountries", "reference", "demographics"], url: "https://restcountries.com/v3.1/name/{name}", sq: { fields: "name,capital,region,population,currencies,languages" },
  p: { name: pathp("Country name", "france", { pattern: "^[A-Za-z ]{2,40}$", transform: "lower" }) }, req: { name: "france" }, res: { source: "restcountries", data: [{ name: { common: "France" }, capital: ["Paris"] }] } });
mk({ slug: "suverse-countries-by-region", category: "geo", source: "restcountries", title: "Countries By Region",
  desc: "Countries in a region from REST Countries, no key. Returns each country with capital and population. For AI agents listing and comparing countries by region.",
  tags: ["geo", "countries", "restcountries", "region", "reference"], url: "https://restcountries.com/v3.1/region/{region}", sq: { fields: "name,capital,population" },
  p: { region: pathp("Region, e.g. europe, asia, africa", "europe", { pattern: "^[A-Za-z]{3,15}$", transform: "lower" }) }, req: { region: "europe" }, res: { source: "restcountries", data: [{ name: { common: "France" } }] } });
mk({ slug: "suverse-sunrise-sunset", category: "geo", source: "sunrise-sunset", title: "Sunrise And Sunset Times",
  desc: "Sunrise, sunset, and twilight times for a latitude and longitude from the Sunrise-Sunset API, no key. Returns UTC times for solar events. For AI agents in scheduling, photography, and energy planning.",
  tags: ["geo", "sunrise", "sunset", "solar", "astronomy"], url: "https://api.sunrise-sunset.org/json", sq: { formatted: "0" },
  p: { lat: num("Latitude", 36.72), lng: num("Longitude", -4.42) }, req: { lat: 36.72, lng: -4.42 }, res: { source: "sunrise-sunset", data: { results: { sunrise: "2026-06-19T05:00:00+00:00" } } } });
mk({ slug: "suverse-uk-postcode", category: "geo", source: "postcodes.io", title: "UK Postcode Lookup",
  desc: "Look up a UK postcode from Postcodes.io, no key. Returns the latitude, longitude, district, region, and administrative areas. For AI agents validating and enriching UK addresses.",
  tags: ["geo", "postcode", "uk", "address", "location"], url: "https://api.postcodes.io/postcodes/{postcode}",
  p: { postcode: pathp("UK postcode", "SW1A1AA", { pattern: "^[A-Za-z0-9 ]{5,8}$" }) }, req: { postcode: "SW1A1AA" }, res: { source: "postcodes.io", data: { result: { region: "London" } } } });

mk({ slug: "suverse-us-address-geocode", category: "geo", source: "census", title: "US Address Geocoder",
  desc: "Geocode a US street address via the Census Bureau geocoder, no key. Returns matched address, coordinates, and census geography. For AI agents standardizing and geocoding US addresses.",
  tags: ["geo", "geocoding", "census", "address", "usa"], url: "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress", sq: { benchmark: "Public_AR_Current", format: "json" },
  p: { address: qreq("One-line US street address", "1600 Pennsylvania Ave NW, Washington DC") }, req: { address: "1600 Pennsylvania Ave NW, Washington DC" }, res: { source: "census", data: { result: { addressMatches: [] } } } });
mk({ slug: "suverse-river-discharge", category: "geo", source: "open-meteo", title: "River Discharge Forecast",
  desc: "River discharge (flood) forecast for a latitude and longitude from the Open-Meteo flood API, no key. Returns daily river discharge in cubic meters per second. For AI agents in flood risk, insurance, and water management.",
  tags: ["geo", "flood", "river", "hydrology", "water"], url: "https://flood-api.open-meteo.com/v1/flood", sq: { daily: "river_discharge" },
  p: { latitude: num("Latitude", 52.52), longitude: num("Longitude", 13.41) }, req: { latitude: 52.52, longitude: 13.41 }, res: { source: "open-meteo", data: { daily: { river_discharge: [12.3] } } } });

// ── Civic / gov (6) ──
mk({ slug: "suverse-federal-register-search", category: "government", source: "federalregister", title: "Federal Register Document Search",
  desc: "Search US Federal Register documents (rules, proposed rules, notices, executive orders) by term, no key. Returns documents with title, type, agency, and publication date. For AI agents monitoring US regulatory activity.",
  tags: ["government", "federal-register", "regulations", "policy", "law"], url: "https://www.federalregister.gov/api/v1/documents.json", sq: { per_page: "10", "conditions[term]": "" },
  p: { term: qreq("Search term", "artificial intelligence", { upstreamName: "conditions[term]" }) }, req: { term: "artificial intelligence" }, res: { source: "federalregister", data: { count: 100, results: [] } } });
mk({ slug: "suverse-federal-agencies", category: "government", source: "federalregister", title: "US Federal Agencies List",
  desc: "The list of US federal agencies from the Federal Register API, no key. Returns agency names, ids, and slugs. For AI agents resolving and navigating US agencies.",
  tags: ["government", "agencies", "federal-register", "reference", "usa"], url: "https://www.federalregister.gov/api/v1/agencies",
  res: { source: "federalregister", data: [{ id: 1, name: "Department of State" }] } });
mk({ slug: "suverse-name-age", category: "social", source: "agify", title: "Name To Age Estimate",
  desc: "Estimate the likely age for a first name from Agify, no key. Returns the predicted age and sample size. For AI agents enriching profiles and demographic guessing.",
  tags: ["social", "names", "age", "demographics", "enrichment"], url: "https://api.agify.io",
  p: { name: qreq("First name", "michael") }, req: { name: "michael" }, res: { source: "agify", data: { name: "michael", age: 62 } } });
mk({ slug: "suverse-name-gender", category: "social", source: "genderize", title: "Name To Gender Estimate",
  desc: "Estimate the likely gender for a first name from Genderize, no key. Returns predicted gender and probability. For AI agents enriching profiles.",
  tags: ["social", "names", "gender", "demographics", "enrichment"], url: "https://api.genderize.io",
  p: { name: qreq("First name", "alex") }, req: { name: "alex" }, res: { source: "genderize", data: { name: "alex", gender: "male", probability: 0.9 } } });
mk({ slug: "suverse-name-nationality", category: "social", source: "nationalize", title: "Name To Nationality Estimate",
  desc: "Estimate likely nationalities for a first name from Nationalize, no key. Returns ranked country codes with probabilities. For AI agents enriching profiles and localization.",
  tags: ["social", "names", "nationality", "demographics", "enrichment"], url: "https://api.nationalize.io",
  p: { name: qreq("First name", "wei") }, req: { name: "wei" }, res: { source: "nationalize", data: { name: "wei", country: [{ country_id: "CN", probability: 0.7 }] } } });
mk({ slug: "suverse-bls-series", category: "macro", source: "bls", title: "BLS Time Series Data",
  desc: "US Bureau of Labor Statistics time series data by series id (CPI, employment, wages) from the public v1 API, no key. Returns recent periods and values. For AI agents tracking US labor and price data.",
  tags: ["macro", "bls", "labor", "cpi", "economics"], url: "https://api.bls.gov/publicAPI/v1/timeseries/data/{seriesid}",
  p: { seriesid: pathp("BLS series id, e.g. CUUR0000SA0 (CPI-U)", "CUUR0000SA0", { pattern: "^[A-Za-z0-9]{6,20}$" }) }, req: { seriesid: "CUUR0000SA0" }, res: { source: "bls", data: { Results: { series: [{ data: [{ year: "2026", value: "320" }] }] } } } });

// ── Coinbase fiat/crypto rates (1) ──
mk({ slug: "suverse-coinbase-rates", category: "forex", source: "coinbase", title: "Coinbase Exchange Rates",
  desc: "Exchange rates for a base currency against fiat and crypto from the public Coinbase API, no key. Returns the rate map for the base currency. For AI agents doing multi-currency conversion including crypto.",
  tags: ["forex", "exchange-rate", "coinbase", "crypto", "currency"], url: "https://api.coinbase.com/v2/exchange-rates",
  p: { currency: { in: "query", required: false, type: "string", default: "USD", pattern: "^[A-Za-z]{2,6}$", transform: "upper", description: "Base currency code", example: "USD" } }, req: { currency: "USD" }, res: { source: "coinbase", data: { data: { currency: "USD", rates: { EUR: "0.92" } } } } });

// ── Treasury more (2) ──
mk({ slug: "suverse-treasury-gold-reserves", category: "treasury", source: "treasury.fiscaldata", title: "US Treasury Gold Reserves",
  desc: "US Treasury-owned gold reserves by facility from the official Treasury FiscalData service, no key, latest records. Returns location, fine troy ounces, and book value. For AI agents tracking sovereign gold holdings.",
  tags: ["treasury", "gold", "reserves", "government", "commodities"], url: "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v2/accounting/od/gold_reserve", sq: { sort: "-record_date", "page[size]": "20", format: "json" }, h: UA,
  res: { source: "treasury.fiscaldata", data: { data: [{ facility_description: "Fort Knox", fine_troy_ounce_qty: "147341858.382" }] } } });
mk({ slug: "suverse-treasury-savings-bonds", category: "treasury", source: "treasury.fiscaldata", title: "US Treasury Savings Bonds Issued",
  desc: "US savings bonds issued and redeemed from the official Treasury FiscalData service, no key, latest records. Returns series, issue amounts, and redemptions. For AI agents tracking retail government debt.",
  tags: ["treasury", "savings-bonds", "debt", "government", "fiscal"], url: "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/od/savings_bonds_pcs", sq: { sort: "-record_date", "page[size]": "12", format: "json" }, h: UA,
  res: { source: "treasury.fiscaldata", data: { data: [{ record_date: "2026-05-31" }] } } });

// ── SEC more (2) ──
mk({ slug: "suverse-sec-tickers", category: "sec-filings", source: "sec.edgar", title: "SEC Ticker To CIK Map",
  desc: "The full SEC ticker-to-CIK mapping for all US public companies, no key. Returns ticker, company name, and CIK for every registrant. For AI agents resolving stock tickers to SEC identifiers before fetching filings.",
  tags: ["sec", "edgar", "tickers", "cik", "stocks"], url: "https://www.sec.gov/files/company_tickers.json", h: UA, timeout: 15000,
  res: { source: "sec.edgar", data: { "0": { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." } } } });
mk({ slug: "suverse-sec-frames", category: "sec-filings", source: "sec.edgar", title: "SEC XBRL Frame Across Companies",
  desc: "One XBRL concept reported by ALL US public companies for a single period from SEC EDGAR frames, no key. Returns each company CIK, entity name, and value. For AI agents screening or comparing a financial metric across the market.",
  tags: ["sec", "edgar", "xbrl", "frames", "screening"], url: "https://data.sec.gov/api/xbrl/frames/us-gaap/{tag}/USD/CY{period}.json", h: UA, timeout: 15000,
  p: { tag: pathp("XBRL concept tag", "Assets", { pattern: "^[A-Za-z]{2,60}$" }), period: pathp("Period, e.g. 2023Q4I or 2023", "2023Q4I", { pattern: "^[0-9]{4}(Q[1-4]I?)?$" }) }, req: { tag: "Assets", period: "2023Q4I" }, res: { source: "sec.edgar", data: { tag: "Assets", data: [{ cik: 320193, val: 352755000000 }] } } });

// ── USGS more (2) ──
mk({ slug: "suverse-quakes-week-major", category: "science", source: "usgs", title: "Major Earthquakes Past Week",
  desc: "Earthquakes of magnitude 4.5 and above worldwide in the past week from the USGS feed, no key. Returns magnitude, place, time, and coordinates. For AI agents monitoring significant seismic activity.",
  tags: ["earthquakes", "usgs", "seismic", "weekly", "science"], url: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_week.geojson",
  res: { source: "usgs", data: { metadata: { count: 40 }, features: [] } } });
mk({ slug: "suverse-usgs-streamflow", category: "science", source: "usgs", title: "USGS River Streamflow",
  desc: "Real-time river streamflow for a USGS monitoring site, no key. Returns the latest discharge in cubic feet per second with timestamp. For AI agents in hydrology, flood, and water management.",
  tags: ["science", "usgs", "streamflow", "water", "hydrology"], url: "https://waterservices.usgs.gov/nwis/iv", sq: { format: "json", parameterCd: "00060" },
  p: { sites: qreq("USGS site number", "01646500", { pattern: "^[0-9]{8,15}$" }) }, req: { sites: "01646500" }, res: { source: "usgs", data: { value: { timeSeries: [] } } } });

// ── NASA EONET categories (1) ──
mk({ slug: "suverse-eonet-categories", category: "science", source: "nasa-eonet", title: "NASA EONET Event Categories",
  desc: "The categories of natural events tracked by NASA EONET, no key, such as wildfires, severe storms, and volcanoes. Returns category id, title, and description. For AI agents navigating natural-event data.",
  tags: ["science", "nasa", "eonet", "categories", "hazards"], url: "https://eonet.gsfc.nasa.gov/api/v3/categories",
  res: { source: "nasa-eonet", data: { categories: [{ id: "wildfires", title: "Wildfires" }] } } });

// ── Met Museum + Art Institute (3) ──
mk({ slug: "suverse-met-search", category: "culture", source: "metmuseum", title: "Met Museum Art Search",
  desc: "Search The Metropolitan Museum of Art open collection by keyword, no key. Returns matching object ids and a total count. For AI agents building art discovery and culture content.",
  tags: ["culture", "art", "metmuseum", "search", "museum"], url: "https://collectionapi.metmuseum.org/public/collection/v1/search", sq: { hasImages: "true" },
  p: { q: qreq("Search keyword", "sunflowers") }, req: { q: "sunflowers" }, res: { source: "metmuseum", data: { total: 50, objectIDs: [436524] } } });
mk({ slug: "suverse-met-object", category: "culture", source: "metmuseum", title: "Met Museum Artwork Detail",
  desc: "Details for a Metropolitan Museum of Art object by id, no key. Returns title, artist, date, medium, and image url. For AI agents fetching a specific artwork.",
  tags: ["culture", "art", "metmuseum", "artwork", "museum"], url: "https://collectionapi.metmuseum.org/public/collection/v1/objects/{objectID}",
  p: { objectID: pathp("Met object id", "436524", { pattern: "^[0-9]{1,7}$" }) }, req: { objectID: "436524" }, res: { source: "metmuseum", data: { title: "Wheat Field with Cypresses", artistDisplayName: "Vincent van Gogh" } } });
mk({ slug: "suverse-artic-search", category: "culture", source: "artic", title: "Art Institute Of Chicago Search",
  desc: "Search the Art Institute of Chicago collection by keyword, no key. Returns matching artworks with title, artist, and date. For AI agents building art discovery experiences.",
  tags: ["culture", "art", "artic", "search", "museum"], url: "https://api.artic.edu/api/v1/artworks/search", sq: { limit: "10" },
  p: { q: qreq("Search keyword", "monet") }, req: { q: "monet" }, res: { source: "artic", data: { data: [{ title: "Water Lilies" }] } } });

// ── PokeAPI (1) ──
mk({ slug: "suverse-pokemon", category: "games", source: "pokeapi", title: "Pokemon Data Lookup",
  desc: "Look up a Pokemon by name from PokeAPI, no key. Returns types, stats, abilities, height, and weight. For AI agents in games, trivia, and entertainment apps.",
  tags: ["games", "pokemon", "pokeapi", "entertainment", "reference"], url: "https://pokeapi.co/api/v2/pokemon/{name}",
  p: { name: pathp("Pokemon name", "pikachu", { pattern: "^[a-zA-Z-]{2,30}$", transform: "lower" }) }, req: { name: "pikachu" }, res: { source: "pokeapi", data: { name: "pikachu", types: [{ type: { name: "electric" } }] } } });

// ── NWS station observations (1) ──
mk({ slug: "suverse-nws-station-obs", category: "weather", source: "nws.weather.gov", title: "NWS Station Latest Observation",
  desc: "Latest weather observation from a US National Weather Service station, no key. Returns temperature, wind, humidity, and conditions. For AI agents needing official US ground-truth weather.",
  tags: ["weather", "nws", "observation", "station", "usa"], url: "https://api.weather.gov/stations/{stationId}/observations/latest", h: UA,
  p: { stationId: pathp("NWS station id, e.g. KNYC", "KNYC", { pattern: "^[A-Za-z0-9]{3,6}$", transform: "upper" }) }, req: { stationId: "KNYC" }, res: { source: "nws.weather.gov", data: { properties: { temperature: { value: 21 } } } } });

writeFileSync(resolve(__dirname, "batch-003.json"), JSON.stringify(rows, null, 2));
console.log(`authored ${rows.length} rows -> scripts/pipeline/batch-003.json`);
