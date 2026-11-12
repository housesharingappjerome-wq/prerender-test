// Crawler detection. Each entry is [canonical name, lowercase user-agent token].
// Order matters: more specific tokens come before generic ones.

export const AI_BOTS = [
  ["GPTBot", "gptbot"],
  ["OAI-SearchBot", "oai-searchbot"],
  ["ChatGPT-User", "chatgpt-user"],
  ["ClaudeBot", "claudebot"],
  ["Claude-SearchBot", "claude-searchbot"],
  ["Claude-User", "claude-user"],
  ["Claude-Web", "claude-web"],
  ["anthropic-ai", "anthropic-ai"],
  ["PerplexityBot", "perplexitybot"],
  ["Perplexity-User", "perplexity-user"],
  ["Meta-ExternalAgent", "meta-externalagent"],
  ["Meta-ExternalFetcher", "meta-externalfetcher"],
  ["FacebookBot", "facebookbot"],
  ["Amazonbot", "amazonbot"],
  ["Applebot-Extended", "applebot-extended"],
  ["Bytespider", "bytespider"],
  ["CCBot", "ccbot"],
  ["cohere-ai", "cohere-ai"],
  ["cohere-training-data-crawler", "cohere-training-data-crawler"],
  ["MistralAI-User", "mistralai-user"],
  ["DuckAssistBot", "duckassistbot"],
  ["YouBot", "youbot"],
  ["Diffbot", "diffbot"],
  ["GoogleOther", "googleother"],
  ["Google-CloudVertexBot", "google-cloudvertexbot"],
  ["PetalBot", "petalbot"],
  ["AI2Bot", "ai2bot"],
  ["Timpibot", "timpibot"],
  ["ImagesiftBot", "imagesiftbot"],
  ["Kangaroo Bot", "kangaroo bot"],
  ["PanguBot", "pangubot"],
  ["Omgilibot", "omgili"],
];

export const SOCIAL_BOTS = [
  ["facebookexternalhit", "facebookexternalhit"],
  ["Twitterbot", "twitterbot"],
  ["LinkedInBot", "linkedinbot"],
  ["Slackbot", "slackbot"],
  ["Discordbot", "discordbot"],
  ["WhatsApp", "whatsapp"],
  ["TelegramBot", "telegrambot"],
  ["Pinterestbot", "pinterest"],
  ["redditbot", "redditbot"],
  ["SkypeUriPreview", "skypeuripreview"],
  ["Embedly", "embedly"],
  ["Iframely", "iframely"],
  ["Mastodon", "mastodon"],
  ["Bluesky", "bluesky cardyb"],
];

export const SEARCH_BOTS = [
  ["Googlebot", "googlebot"],
  ["Google-InspectionTool", "google-inspectiontool"],
  ["Bingbot", "bingbot"],
  ["Applebot", "applebot"],
  ["DuckDuckBot", "duckduckbot"],
  ["YandexBot", "yandex"],
  ["Baiduspider", "baiduspider"],
  ["Yahoo Slurp", "slurp"],
  ["SeznamBot", "seznambot"],
  ["Qwantbot", "qwant"],
  ["Bravebot", "bravebot"],
];

const SETS = {
  ai: [AI_BOTS],
  "ai+social": [AI_BOTS, SOCIAL_BOTS],
  all: [AI_BOTS, SOCIAL_BOTS, SEARCH_BOTS],
};

/**
 * Returns the canonical crawler name for a user agent, or null for humans
 * and for crawlers outside the configured set.
 * @param {string} userAgent
 * @param {"ai"|"ai+social"|"all"} botSet
 * @param {string[]} extraTokens lowercase user-agent tokens added by the site owner
 */
export function classifyBot(userAgent, botSet = "ai+social", extraTokens = []) {
  if (!userAgent) return null;
  const ua = userAgent.toLowerCase();
  for (const token of extraTokens) {
    if (token && ua.includes(token)) return token;
  }
  const lists = SETS[botSet] || SETS["ai+social"];
  for (const list of lists) {
    for (const [name, token] of list) {
      if (ua.includes(token)) return name;
    }
  }
  return null;
}
