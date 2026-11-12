# Edge Prerender Worker

The Cloudflare Worker behind the **Edge Prerender: AI Crawler Snapshots** plugin for Bubble.

Bubble pages are built in the browser, so a crawler that does not run JavaScript receives a page title and an empty body. This Worker sits in front of your app's domain. When GPTBot, ClaudeBot, PerplexityBot or a link previewer asks for a page, it answers with a stored snapshot: the same page your visitors see, already rendered to plain HTML. People always get your normal app.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/housesharingappjerome-wq/bubble-edge-prerender)

## Before you start

You need all of these:

1. A Bubble app on a custom domain (a paid Bubble plan).
2. That domain's DNS on Cloudflare, with the record for your app proxied (orange cloud).
3. A Cloudflare account with R2 turned on. R2 has a free allowance, but Cloudflare asks for a payment method before you can use it.

If your app is on a `bubbleapps.io` address, crawlers reach Bubble directly and never pass through the Worker. You can still try the Worker in standalone mode (see below), but it will not change what crawlers see on your real address.

## Setup, step by step

About 30 minutes if you have used Cloudflare Workers before.

### 1. Deploy the Worker

Click **Deploy to Cloudflare** above and follow the prompts. Cloudflare copies this code into your own account and creates the three things the Worker needs:

- a D1 database (`DB`) for the snapshot index, crawler visits and usage. Its tables are created automatically on first run;
- an R2 bucket (`SNAPSHOTS`) that holds the snapshot HTML;
- a Browser Run binding (`BROWSER`) that renders the pages.

When the form asks for `API_KEY`, enter a long random value and keep a copy. This is the key you will paste into the plugin. If the form does not ask, add it after deploying: open the Worker, then **Settings**, **Variables and Secrets**, and add a secret named `API_KEY`.

Prefer the command line? Clone the repository, then:

```
npm install
npx wrangler secret put API_KEY
npx wrangler deploy
```

### 2. Check it is running

Open `https://<your-worker>.workers.dev/__prerender/health`. You should see `"ok": true` and `"api_key_set": true`.

### 3. Put the Worker on your domain

In the Cloudflare dashboard open **Workers & Pages**, choose the Worker, then **Settings**, then **Domains & Routes**, and add a **Route**:

- Route: `www.yourdomain.com/*` (use the exact host your Bubble app runs on)
- Zone: your domain

Do not add an `ORIGIN_URL` variable. On a route, the Worker passes every normal visitor straight through to Bubble and only answers crawlers itself.

### 4. Connect the Bubble plugin

In your Bubble app open **Plugins**, choose **Edge Prerender: AI Crawler Snapshots** and fill in:

- **Worker URL**: your app's address, for example `https://www.yourdomain.com`
- **API key**: the value from step 1

Fill in the development versions too.

### 5. Create the first snapshots

Run the plugin action **Prerender - Queue pages from sitemap** once (turn the sitemap on in Bubble under Settings, SEO / metatags), or run **Prerender - Render page** for individual pages. Then add **Render page** to the end of any workflow that changes what a public page shows, and **Purge** to workflows that delete or unpublish a page.

### 6. Confirm crawlers get the snapshot

```
curl -A "GPTBot" https://www.yourdomain.com/your-page
```

The response should contain your page's text, not an empty body.

## Standalone mode (testing without a custom domain)

Open the Worker, then **Settings**, **Variables and Secrets**, and add a variable named `ORIGIN_URL` set to your app's address, for example `https://yourapp.bubbleapps.io/version-test`. Then use the Worker's `workers.dev` address as the plugin's Worker URL. The plugin actions and snapshot previews all work, which is useful for a trial. Real crawlers visiting your Bubble address are not affected until the Worker runs on your own domain.

## Settings

Change these under the Worker's **Settings**, **Variables and Secrets**, or in `wrangler.jsonc`.

| Variable | Default | What it does |
|---|---|---|
| `API_KEY` (secret) | none | Required. The plugin sends it with every call. |
| `ORIGIN_URL` | not set | Only for standalone mode. Add it yourself when needed. |
| `BOT_SET` | `ai+social` | `ai`, `ai+social`, or `all` (adds search engine crawlers). |
| `EXTRA_BOTS` | empty | Extra user-agent tokens to treat as crawlers, comma separated. |
| `MAX_PAGES` | `50` | Most pages the Worker will track. |
| `MAX_RENDERS_PER_MONTH` | `500` | Monthly render cap. |
| `RENDER_INTERVAL_SECONDS` | `11` | Pause between renders. The free plan allows about one every 10 seconds. |
| `SNAPSHOT_TTL_HOURS` | `168` | Snapshots older than this are rendered again. |
| `AUTO_QUEUE_ON_MISS` | `true` | Queue a page the first time a crawler asks for it. |
| `AUTO_REFRESH` | `true` | Re-render old snapshots automatically. |
| `INCLUDE_PATHS` / `EXCLUDE_PATHS` | empty | Limit which paths are prerendered, comma separated. |
| `IGNORE_QUERY` | `false` | Treat a page with different query strings as one page. |
| `MIN_TEXT_CHARS` | `80` | A render with less text than this is marked thin and not served. |
| `WAIT_UNTIL`, `WAIT_SELECTOR`, `SETTLE_MS`, `RENDER_TIMEOUT_SECONDS` | see `src/index.js` | Fine-tune when a render counts as finished. |
| `PUBLIC_PREVIEW` | `true` | Allow snapshot preview links without the API key. |

## What it does not do

- It does not improve rankings by itself. It makes the content you already have readable to crawlers that skip JavaScript.
- It only covers public pages. Snapshots are taken logged out, so anything behind a login is never captured.
- It does not write or change your content. The snapshot holds what a visitor sees.

## Running costs

Cloudflare's free plan allows 10 minutes of browser time a day, which suits a small site. Larger sites need the Workers Paid plan. The page and render limits above keep usage predictable. Check Cloudflare's pricing pages for current figures.

## API

All routes are under `/__prerender`. Every route except `/health` and snapshot previews needs the header `Authorization: Bearer <API_KEY>`.

| Route | Method | Purpose |
|---|---|---|
| `/health` | GET | Shows the Worker's mode and limits. |
| `/render` | POST | Render one page (`url`) or queue many (`urls`). |
| `/purge` | POST | Remove snapshots by `url`, `prefix` or `all`. |
| `/sitemap` | POST | Queue pages from the app's sitemap. |
| `/status` | GET | Snapshot state for one page. |
| `/list` | GET | Tracked pages. |
| `/usage` | GET | Renders and crawler visits this month. |
| `/bots` | GET | Crawler visits by crawler. |
| `/check` | GET | Compare a page without JavaScript against its snapshot. |
| `/snapshot` | GET | The stored snapshot HTML for a page. |

## Licence

See [LICENSE](LICENSE). You may deploy and modify this code for your own sites and your clients' sites. You may not resell it or include it in another product.
