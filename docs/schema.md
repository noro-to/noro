# The standard schema

> **Draft.** The exact list of fields is an open question for v0.2. What's here
> is what the adapters, the compute step and the tests use today. If a field
> needs to be added, renamed or dropped, open an issue before you change it,
> because `src/schema.ts` (the types) and this page have to change together.

Every ad platform exports its numbers differently: other header names, other
number formats, cost in micros or in dollars, totals mixed in with the data.
noro's first step, **ingest**, reads an export (CSV or XLSX) and maps each row
onto one standard shape, so every later step works the same way for every
platform. Ingest converts units and formats but computes nothing: sums, ratios
and comparisons all happen in the compute step, where each one becomes a fact
with an id.

## Row

One row of an export after mapping (`Row` in `src/schema.ts`).

| Field | Type | Meaning | Units |
|---|---|---|---|
| `date` | string, optional | The day the row covers, when the export is daily. | ISO `YYYY-MM-DD` |
| `period` | string, optional | A label for the period when the row isn't a single day, e.g. `2026-W40`, `2026-09`, or `2026-09-29/2026-10-05` for a date range. Set instead of `date`. | free text |
| `platform` | string | The platform's display name, e.g. `Google Ads`. | |
| `account` | string | Account or advertiser. `(not in export)` when the export has no account column. | |
| `campaign` | string | Campaign (Amazon DSP: order). | |
| `adGroup` | string, optional | Ad group (Google Ads), ad set (Meta) or line item (Amazon DSP). Absent when the export has no such column. | |
| `spend` | number | Cost. | Major currency units (dollars, not cents, not micros) |
| `impressions` | number | Impressions. | count |
| `clicks` | number | Clicks, as the platform's main click metric (Meta: link clicks). | count |
| `conversions` | number | The platform's **primary** conversions column. May be fractional (data-driven attribution). | count |
| `conversionValue` | number | Value of those conversions. `0` when the export has none (ingest warns). | Major currency units |
| `extra` | object | Platform-specific columns the schema doesn't name, keyed by the adapter's name for them (`extra.allConversions`, `extra.reach`, ...). Numbers when they parse, otherwise text; ID columns stay text. | as exported |

Each row has either `date` or `period`, never both.

## Dataset

What ingest returns (`Dataset` in `src/schema.ts`):

- `source`: the file path as given.
- `platform`, `adapter`: display name and adapter id (`google-ads`, `meta`, `amazon-dsp`, or `guessed` when the user confirmed a guessed mapping).
- `currency`: ISO code for the whole dataset. Read from a currency column, then from a code in the spend header (`Amount spent (USD)`), then the adapter default (`USD`). If an export mixes currencies, ingest uses the most common one and warns that totals across currencies mean nothing.
- `mapping`: the raw header each field came from, for this file.
- `rows`: the mapped rows, in file order.
- `warnings`: everything ingest did that you might want to know: preamble lines and total rows skipped, micros converted, blanks read as 0, values that weren't numbers, missing optional columns.
- `sources`: set when the dataset comes from `ingestAll` (every run does): one entry per file with `file`, `platform`, `adapter`, `currency`, `rows` (rows used, after period alignment), and that file's own `mapping` and `warnings`.

### Several exports in one dataset

`ingestAll(files)` in `src/ingest/index.ts` reads several exports into one
dataset for a combined cross-channel report (`noro this a.csv b.csv c.csv`).
Every row already carries its `platform`, so the rows simply merge, in a fixed
order (platform, then path) so the order of the files never changes a number.

- `source` joins the paths with ` + `, `platform` joins the sorted platform names with ` + `, `adapter` is `combined`, `mapping` is empty (each file's is in `sources`), and each file's warnings are prefixed with its file name.
- **One currency.** Files in different currencies throw `MixedCurrencyError`. There is no conversion: code would have to invent an exchange rate.
- **Aligned periods.** With daily rows, only the dates every file covers are kept. With period labels (weeks, months, ranges), only the labels every file has. Dropping rows adds a warning that stops a run before any model call unless the user accepts it (`--accept-warnings`), like the micros warning. No shared date or period throws `CombineError`, as do a file with no data rows and the same file given twice.
- One file gives the same dataset as `ingest()`, plus `sources`.

When the rows come from more than one platform, compute adds a channel scope:
blended totals labelled "all channels", each platform as a channel
(`scope.platform`), each channel's share of total spend and conversions, and
campaign facts per platform. The facts table then lists the platforms in
`channels`. With one platform the facts table is exactly what a single file
gives.

## Rules every adapter follows

**Micros.** The Google Ads API, scripts and Report Editor can report money in
micros: 1,000,000 micros = 1 unit of currency, so $48.21 arrives as
`48210000`. Any column an adapter lists under `micros` is divided by 1,000,000
on ingest, and the dataset only ever holds major units. A cost column that is
*not* declared as micros but has a median above 1,000,000 per row gets a
warning, because that is what an unconverted micros export looks like (see the
`W-micros-cost` watchout in `rules/watchout/micros-cost.yaml`).

**Conversions vs All conversions.** Google Ads has two columns:
*Conversions* counts the actions marked as primary for bidding;
*All conv.* adds secondary actions, cross-device and view-through estimates.
They don't tie, and a CPA computed from one doesn't compare with a CPA from the
other. `conversions` is always the primary column. *All conv.* is kept as
`extra.allConversions` and is never summed into `conversions`. The
`W-conversions-vs-all-conversions` watchout flags reports that mix them. Meta's
*Results* has a similar problem (it means whatever each campaign optimises
for), so the Meta adapter prefers *Purchases* and only falls back to *Results*.

**Number formats.** `$1,234.56`, `1,234`, `12.5%`, `(45.00)` (negative), and
codes like `USD 3.20` all parse. Blank cells and placeholders such as `--` read
as `0`, and ingest says how many it read that way. Anything else that isn't a
number becomes `0` with a warning naming the column, the first bad value and its
line. Adapters can set a `,` decimal separator for European formats.

**Dates.** `2026-09-29`, `09/29/2026`, `Sep 29, 2026`,
`Tuesday, September 29, 2026`, `29 Sep 2026` and XLSX date cells all become
`2026-09-29`. Slash dates are month-first unless the adapter says
`dates.order: dmy` (or the first part is over 12). A value in the date column
that isn't a date is kept as the row's `period` label, with a warning.

**Rows that aren't data.** Each adapter lists `skipRows` rules: Google Ads
`Total: ...` rows, Meta's summary row (no campaign name), Amazon DSP's `Total`
row. Blank rows and repeated header rows are always dropped. Preamble lines
above the header row (Google Ads puts the report name and date range there)
are skipped: ingest looks for the header in the first 30 lines.

## Which raw column each adapter maps

The first header in each list that is present in the file wins. Matching
ignores case and extra spaces; `*` matches any text.

| Field | Google Ads (`google-ads.yaml`) | Meta (`meta.yaml`) | Amazon DSP (`amazon-dsp.yaml`) |
|---|---|---|---|
| `date` | Day, Date | Reporting starts, Day | Date |
| `period` | Week, Month, Quarter, Year | (start/end range, see below) | Week, Month |
| `account` | Account name, Account | Account name | Advertiser |
| `campaign` | Campaign | Campaign name | Order |
| `adGroup` | Ad group | Ad set name | Line item |
| `spend` | Cost, **Cost (micros)** | Amount spent (*), Amount spent | Total cost, **Total cost (micros)** |
| `impressions` | Impr., Impressions | Impressions | Impressions |
| `clicks` | Clicks | Link clicks, Clicks (all) | Click-throughs |
| `conversions` | Conversions | Purchases, Website purchases, Results | Total purchases, Purchases |
| `conversionValue` | Conv. value, Conversion value, **Conv. value (micros)** | Purchases conversion value, Website purchases conversion value, Purchase conversion value | Total sales, Sales |
| currency | Currency code, Currency (column) | code in the spend header | Currency (column) |

**Bold** headers are micros and are divided by 1,000,000.

Meta: when a row's *Reporting ends* differs from its *Reporting starts*, the
row covers a range and gets `period: "<start>/<end>"` instead of `date`.

Extra fields kept under `extra`:

| Adapter | `extra` name ← raw header |
|---|---|
| Google Ads | `allConversions` ← All conv., All conversions · `allConversionValue` ← All conv. value · `currencyCode` ← Currency code · `campaignType` ← Campaign type |
| Meta | `reach` ← Reach · `clicksAll` ← Clicks (all) · `results` ← Results · `resultIndicator` ← Result indicator |
| Amazon DSP | `orderId` ← Order ID · `lineItemId` ← Line item ID · `productPurchases` ← Purchases (promoted product) · `productSales` ← Sales (promoted product) · `totalRoas` ← Total ROAS |

A header is used once: schema fields claim headers first, extras get what's left.

Amazon DSP's *Total purchases* and *Total sales* include halo purchases (any
product of the brand, not only the promoted one); the promoted-product columns
are kept under `extra` when present.

## How an export finds its adapter

`detectAdapter(headers)` in `src/adapters/loader.ts` tries every adapter
against each of the first 30 rows of the file:

1. Every header in the adapter's `detect.required` must be present, and its
   `columns` must cover `campaign`, `spend`, `impressions`, `clicks`,
   `conversions` and one of `date`/`period`.
2. Matching adapters are scored: 10 per required header, 3 per
   `detect.distinctive` header present, 1 per mapped column. The highest score
   wins; a tie goes to the adapter id that sorts first, so the result never
   depends on file order.

The first row that some adapter matches is the header row.

**Unknown exports.** When nothing matches, `guessMapping` in
`src/adapters/guess.ts` proposes a mapping from header synonyms ("Advertiser
name" → account, "Clicks (destination)" → clicks) and the values in the first
20 rows (dates, money, whole numbers, text), with a 0–1 confidence per field.
Ratio columns (CTR, CPC, "Cost per ...", "... rate", anything with `%`) are
never mapped. Then:

- With a `confirmMapping` callback (the CLI asks you), ingest uses the mapping
  you confirm, and `adapter` is `guessed`. Returning `null` aborts.
- Without one, ingest throws `UnknownExportError`, which carries the guess.

With `saveAdapterAs`, the confirmed mapping is saved as adapter YAML so the
same export is recognised next time without asking:

- an id such as `tiktok` writes `.noro/adapters/tiktok.yaml` under the working
  directory. Ingest loads that directory along with the built-in adapters.
  `.noro/` is gitignored: it's your local state.
- a path ending in `.yaml` is written there as given.

If the platform is useful to others, copy the saved file into `src/adapters/`,
review it (add `distinctive` headers, `micros`, `skipRows`), add a synthetic
fixture and a test, and open a PR. CONTRIBUTING.md has the steps.

## Adapter file reference

```yaml
id: google-ads                 # lowercase slug, unique
platform: Google Ads           # display name, copied to Row.platform
detect:
  required: [Campaign, Clicks] # all must be present
  distinctive: [Impr., All conv.]   # optional; each present adds to the score
columns:                       # schema field → header or list of alternatives
  date: [Day, Date]
  campaign: Campaign
  spend: [Cost, Cost (micros)]
  # ... impressions, clicks, conversions required; account, adGroup, conversionValue, period optional
extra:                         # optional; name → header(s), kept under Row.extra
  allConversions: [All conv.]
dateEnd: [Reporting ends]      # optional; see Meta
micros: [Cost (micros)]        # optional; headers divided by 1,000,000
currency:
  column: [Currency code]      # optional currency column
  fromHeader: true             # read "(USD)" from the spend header
  default: USD
numbers:
  thousands: ","
  decimal: "."
  zero: ["", "--"]             # cell values read as 0
dates:
  order: mdy                   # or dmy, for ambiguous slash dates
skipRows:                      # each rule has one target: field, column, firstColumn or any
  - firstColumn: true
    match: '^\s*Total\b'       # case-insensitive regex; or `blank: true`
    reason: total row
```

`loadAdapters` validates every file and reports all problems at once, naming
the file and the field (`Invalid adapter src/adapters/x.yaml: field
"columns.spend" is required`). Unknown keys are errors, so typos don't pass
silently.

## Fixtures

`fixtures/exports/` holds synthetic exports (invented names and numbers) for
each adapter plus `unknown-platform.csv` for the guess path and
`google-ads.xlsx` for the XLSX path. They are generated by
`npx tsx fixtures/generate.ts`; the header comment of that script has the
weekly totals. All of them cover Sep 29 – Oct 12 2026 (two weeks) for four
campaigns of the account "Acme Outdoor", and tell the same story:

- **PR-07 Prospecting**: CPA up 38% week over week (Google Ads: $30.00 → $41.40).
- **PR-03 Brand** and **NB-11 Generic**: stable (+1.5% and −2.0%).
- **DG-05 Demand Gen**: 12 and 14 conversions, a sample too small to read much into.

Google Ads uses `Cost (micros)` in the CSV and plain `Cost` in the XLSX, so
both paths are tested on the same numbers.
