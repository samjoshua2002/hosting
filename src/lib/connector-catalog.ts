// Connectors the Assistant can use, like Claude's: services you connect once (a token you paste, kept encrypted,
// or a remote MCP server) and it uses them by itself when a task needs them. Browser-safe: definitions only.

export type ConnectorCategory = "Hosting" | "Code" | "Data" | "Monitoring" | "Messaging" | "Work" | "Payments" | "AI" | "Docs";

export interface ConnectorDef {
  id: string;
  name: string;
  by: string;
  category: ConnectorCategory;
  desc: string;
  /** simple-icons slug and the color to draw it in (white for black logos on our dark UI) */
  logo: { slug: string; color: string };
  /**
   * builtin: set up elsewhere in the dashboard (GitHub, Azure, email…), shown with its real state
   * token:   paste an API token; the Assistant calls the service's REST API with it (connector_api)
   * mcp:     a remote MCP server; its tools become the Assistant's
   * mailbox: email accounts (several allowed), connected with an app password; the Assistant's email tool
   */
  kind: "builtin" | "token" | "mcp" | "mailbox";
  token?: {
    label: string;
    /** where to create one */
    help: string;
    /** checked when you connect: a cheap read that proves the token works and tells us whose it is */
    check: string;
    base: string;
    /** how the token is sent */
    auth: "bearer" | "bot" | "x-api-key" | "plain" | "url";
    headers?: Record<string, string>;
    /** what the Assistant can do with it, in a line (shown and given to the model) */
    can: string;
  };
  mcp?: { url: string; reuse?: "github" };
  mailbox?: { provider: "gmail" | "zoho" | "custom"; help: string; steps: string };
}

export const CONNECTORS: ConnectorDef[] = [
  // ---- code & hosting ----
  { id: "github", name: "GitHub", by: "GitHub", category: "Code", desc: "Repos, branches, pull requests, issues, Actions and auto-deploy on push", logo: { slug: "github", color: "ffffff" }, kind: "builtin" },
  {
    id: "gmail",
    name: "Gmail",
    by: "Google",
    category: "Messaging",
    desc: "Search, read, draft and send from your Gmail accounts. Add as many as you like.",
    logo: { slug: "gmail", color: "EA4335" },
    kind: "mailbox",
    mailbox: { provider: "gmail", help: "https://myaccount.google.com/apppasswords", steps: "Turn on 2-Step Verification, then create an app password (Google Account → Security → App passwords)." },
  },
  {
    id: "zoho-mail",
    name: "Zoho Mail",
    by: "Zoho",
    category: "Messaging",
    desc: "Search, read, draft and send from your Zoho Mail accounts. Add as many as you like.",
    logo: { slug: "zoho", color: "E42527" },
    kind: "mailbox",
    mailbox: { provider: "zoho", help: "https://accounts.zoho.com/home#security/app_password", steps: "Zoho Mail → Settings → Mail Accounts → IMAP Access: turn it on. Then Zoho Accounts → Security → App Passwords: create one." },
  },
  {
    id: "imap",
    name: "Other email (IMAP)",
    by: "IMAP/SMTP",
    category: "Messaging",
    desc: "Any mailbox that offers IMAP and SMTP (Fastmail, your own domain…).",
    logo: { slug: "thunderbird", color: "0A84FF" },
    kind: "mailbox",
    mailbox: { provider: "custom", help: "", steps: "Your provider's IMAP and SMTP server names (SSL on ports 993 and 465) and an app password." },
  },
  {
    id: "vercel",
    name: "Vercel",
    by: "Vercel",
    category: "Hosting",
    desc: "Deployments, projects, environment variables and domains on Vercel",
    logo: { slug: "vercel", color: "ffffff" },
    kind: "token",
    token: { label: "Vercel access token", help: "https://vercel.com/account/settings/tokens", check: "/v2/user", base: "https://api.vercel.com", auth: "bearer", can: "list projects and deployments, read build logs, set env vars, redeploy, add domains" },
  },
  {
    id: "render",
    name: "Render",
    by: "Render",
    category: "Hosting",
    desc: "Web services, databases, deploys and logs on Render",
    logo: { slug: "render", color: "ffffff" },
    kind: "token",
    token: { label: "Render API key", help: "https://dashboard.render.com/u/settings#api-keys", check: "/v1/owners?limit=1", base: "https://api.render.com", auth: "bearer", can: "list services, trigger deploys, read deploy status, change env vars, suspend/resume" },
  },
  {
    id: "netlify",
    name: "Netlify",
    by: "Netlify",
    category: "Hosting",
    desc: "Sites, deploys and environment variables on Netlify",
    logo: { slug: "netlify", color: "00C7B7" },
    kind: "token",
    token: { label: "Netlify personal access token", help: "https://app.netlify.com/user/applications#personal-access-tokens", check: "/api/v1/user", base: "https://api.netlify.com", auth: "bearer", can: "list sites and deploys, trigger builds, set env vars" },
  },
  {
    id: "cloudflare",
    name: "Cloudflare",
    by: "Cloudflare",
    category: "Hosting",
    desc: "DNS records, zones, Workers and cache on Cloudflare",
    logo: { slug: "cloudflare", color: "F38020" },
    kind: "token",
    token: { label: "Cloudflare API token", help: "https://dash.cloudflare.com/profile/api-tokens", check: "/client/v4/user/tokens/verify", base: "https://api.cloudflare.com", auth: "bearer", can: "list zones, add/edit DNS records (e.g. point a domain at a project), purge cache" },
  },
  // ---- data ----
  {
    id: "supabase",
    name: "Supabase",
    by: "Supabase",
    category: "Data",
    desc: "Your Supabase projects: databases, auth and storage",
    logo: { slug: "supabase", color: "3FCF8E" },
    kind: "token",
    token: { label: "Supabase access token", help: "https://supabase.com/dashboard/account/tokens", check: "/v1/projects", base: "https://api.supabase.com", auth: "bearer", can: "list projects, read database settings and connection info, run SQL via the management API" },
  },
  {
    id: "neon",
    name: "Neon",
    by: "Neon",
    category: "Data",
    desc: "Serverless Postgres projects and branches on Neon",
    logo: { slug: "neon", color: "00E599" },
    kind: "token",
    token: { label: "Neon API key", help: "https://console.neon.tech/app/settings/api-keys", check: "/api/v2/projects?limit=1", base: "https://console.neon.tech", auth: "bearer", can: "list projects and branches, get connection strings, create branches" },
  },
  // ---- monitoring ----
  {
    id: "langfuse",
    name: "Langfuse",
    by: "Langfuse",
    category: "Monitoring",
    desc: "LLM observability, agent traces, token costs, latency and evaluations for your AI Assistant",
    logo: { slug: "langfuse", color: "ffffff" },
    kind: "builtin",
  },
  {
    id: "sentry",
    name: "Sentry",
    by: "Sentry",
    category: "Monitoring",
    desc: "Errors and performance issues from your apps",
    logo: { slug: "sentry", color: "ffffff" },
    kind: "token",
    token: { label: "Sentry auth token", help: "https://sentry.io/settings/account/api/auth-tokens/", check: "/api/0/", base: "https://sentry.io", auth: "bearer", can: "list projects and recent issues, read stack traces, resolve issues" },
  },
  // ---- messaging ----
  {
    id: "slack",
    name: "Slack",
    by: "Slack",
    category: "Messaging",
    desc: "Post deploy results and alerts to your channels",
    logo: { slug: "slack", color: "ffffff" },
    kind: "token",
    token: { label: "Slack bot token (xoxb-…)", help: "https://api.slack.com/apps", check: "/api/auth.test", base: "https://slack.com", auth: "bearer", can: "post messages to channels (chat.postMessage), list channels" },
  },
  {
    id: "discord",
    name: "Discord",
    by: "Discord",
    category: "Messaging",
    desc: "Send alerts and reports through your Discord bot",
    logo: { slug: "discord", color: "5865F2" },
    kind: "token",
    token: { label: "Discord bot token", help: "https://discord.com/developers/applications", check: "/api/v10/users/@me", base: "https://discord.com", auth: "bot", can: "post messages to channels the bot is in" },
  },
  {
    id: "telegram",
    name: "Telegram",
    by: "Telegram",
    category: "Messaging",
    desc: "Get alerts and reports from your Telegram bot",
    logo: { slug: "telegram", color: "26A5E4" },
    kind: "token",
    token: { label: "Telegram bot token (from @BotFather)", help: "https://t.me/BotFather", check: "/getMe", base: "https://api.telegram.org", auth: "url", can: "send messages to chats that started the bot (sendMessage), read updates" },
  },
  {
    id: "resend",
    name: "Resend",
    by: "Resend",
    category: "Messaging",
    desc: "Send email from your apps and the Assistant",
    logo: { slug: "resend", color: "ffffff" },
    kind: "token",
    token: { label: "Resend API key", help: "https://resend.com/api-keys", check: "/domains", base: "https://api.resend.com", auth: "bearer", can: "send emails, list domains" },
  },
  // ---- work ----
  {
    id: "notion",
    name: "Notion",
    by: "Notion",
    category: "Work",
    desc: "Write deploy notes, runbooks and reports into Notion",
    logo: { slug: "notion", color: "ffffff" },
    kind: "token",
    token: { label: "Notion integration secret", help: "https://www.notion.so/my-integrations", check: "/v1/users/me", base: "https://api.notion.com", auth: "bearer", headers: { "Notion-Version": "2022-06-28" }, can: "search pages, create and update pages in shared workspaces" },
  },
  {
    id: "linear",
    name: "Linear",
    by: "Linear",
    category: "Work",
    desc: "Create and update issues from incidents and reviews",
    logo: { slug: "linear", color: "ffffff" },
    kind: "token",
    token: { label: "Linear API key", help: "https://linear.app/settings/account/security", check: "graphql:{ viewer { id name email } }", base: "https://api.linear.app", auth: "plain", can: "create issues, update status, comment (GraphQL at /graphql)" },
  },
  // ---- payments ----
  {
    id: "stripe",
    name: "Stripe",
    by: "Stripe",
    category: "Payments",
    desc: "Check payments, customers and webhooks for your apps",
    logo: { slug: "stripe", color: "635BFF" },
    kind: "token",
    token: { label: "Stripe restricted key (rk_…) or secret key", help: "https://dashboard.stripe.com/apikeys", check: "/v1/balance", base: "https://api.stripe.com", auth: "bearer", can: "read balance, payments, customers and webhook endpoints" },
  },
  // ---- AI ----
  {
    id: "openai",
    name: "OpenAI",
    by: "OpenAI",
    category: "AI",
    desc: "Use OpenAI models and keys in the apps you deploy",
    logo: { slug: "openai", color: "ffffff" },
    kind: "token",
    token: { label: "OpenAI API key", help: "https://platform.openai.com/api-keys", check: "/v1/models", base: "https://api.openai.com", auth: "bearer", can: "list models; the key can be passed to apps as OPENAI_API_KEY" },
  },
  {
    id: "anthropic",
    name: "Anthropic",
    by: "Anthropic",
    category: "AI",
    desc: "Use Claude models in the apps you deploy",
    logo: { slug: "anthropic", color: "ffffff" },
    kind: "token",
    token: { label: "Anthropic API key", help: "https://console.anthropic.com/settings/keys", check: "/v1/models", base: "https://api.anthropic.com", auth: "x-api-key", headers: { "anthropic-version": "2023-06-01" }, can: "list models; the key can be passed to apps as ANTHROPIC_API_KEY" },
  },
  {
    id: "huggingface",
    name: "Hugging Face",
    by: "Hugging Face",
    category: "AI",
    desc: "Models, datasets and Spaces on Hugging Face",
    logo: { slug: "huggingface", color: "FFD21E" },
    kind: "token",
    token: { label: "Hugging Face access token", help: "https://huggingface.co/settings/tokens", check: "/api/whoami-v2", base: "https://huggingface.co", auth: "bearer", can: "search models and datasets, download private models on your machines" },
  },
  // ---- docs (remote MCP servers) ----
  { id: "context7", name: "Context7", by: "Upstash", category: "Docs", desc: "Up-to-date docs and code examples for any library or framework", logo: { slug: "upstash", color: "00E9A3" }, kind: "mcp", mcp: { url: "https://mcp.context7.com/mcp" } },
  { id: "deepwiki", name: "DeepWiki", by: "Cognition", category: "Docs", desc: "Ask questions about any public GitHub repository", logo: { slug: "wikipedia", color: "ffffff" }, kind: "mcp", mcp: { url: "https://mcp.deepwiki.com/mcp" } },
  { id: "cloudflare-docs", name: "Cloudflare Docs", by: "Cloudflare", category: "Docs", desc: "Search Cloudflare's documentation", logo: { slug: "cloudflare", color: "F38020" }, kind: "mcp", mcp: { url: "https://docs.mcp.cloudflare.com/mcp" } },
  { id: "github-mcp", name: "GitHub MCP", by: "GitHub", category: "Code", desc: "GitHub's official server: code search, issues, PRs, Actions (uses your GitHub connection)", logo: { slug: "github", color: "ffffff" }, kind: "mcp", mcp: { url: "https://api.githubcopilot.com/mcp/", reuse: "github" } },
  // ---- built in (set up in the dashboard) ----
  { id: "azure", name: "Azure OpenAI", by: "Microsoft", category: "AI", desc: "The models the Assistant thinks with", logo: { slug: "openai", color: "ffffff" }, kind: "builtin" },
  { id: "machines", name: "Your machines", by: "SSH", category: "Hosting", desc: "Every InstaBox or SSH machine: deploy, run, monitor", logo: { slug: "linux", color: "ffffff" }, kind: "builtin" },
  { id: "email", name: "Report sender", by: "Server", category: "Monitoring", desc: "The address the 5-hour fleet report is sent from (EMAIL_USER on the server). Not your mail: connect Gmail or Zoho Mail for that.", logo: { slug: "minutemailer", color: "ffffff" }, kind: "builtin" },
  { id: "unsplash", name: "Unsplash", by: "Unsplash", category: "Data", desc: "Daily cover photos and theme colors", logo: { slug: "unsplash", color: "ffffff" }, kind: "builtin" },
];

export const CONNECTOR_CATEGORIES: ConnectorCategory[] = ["Hosting", "Code", "Data", "Monitoring", "Messaging", "Work", "Payments", "AI", "Docs"];

export function connectorDef(id: string): ConnectorDef | undefined {
  return CONNECTORS.find((c) => c.id === id);
}
