// Playbooks the Assistant loads on demand (load_skill), like Claude's skills: how a senior engineer approaches
// a kind of work on this platform, step by step, with the tools it actually has. Kept out of the system prompt
// so each run only pays for the ones it uses.

export interface Skill {
  id: string;
  title: string;
  /** when to load it (shown to the model in the system prompt) */
  when: string;
  body: string;
}

export const SKILLS: Skill[] = [
  {
    id: "goal-mode",
    title: "Goal mode: finish the whole job",
    when: "any multi-step request (deploy, migrate, set up a site, build a feature); load first",
    body: `You own the outcome, not the steps. The user gave a goal; deliver it working, then report.
1. Understand: restate the goal in one line to yourself. Gather facts with tools (fleet_status, github_repos, repo_read, read_attachment) instead of asking.
2. Plan: call update_plan with 4-9 concrete steps (verbs, outcomes). Keep it updated: mark a step "doing" when you start it and "done"/"failed" with a short note when it ends. The user watches this checklist.
3. Decide, don't ask: choose machines, ports, names, versions, passwords ("generate") yourself. Only ask_user for things only the user can know or approve (their secrets, a destructive choice, a paid account, a provider dashboard click).
4. Execute in small verified steps. After each action check the result (exit code, service state, curl the URL, read the log). Background anything slow (deploy_project/start_job) and follow it with job_log.
5. When something fails: read the real error, form a hypothesis, fix the cause, retry. Try a different approach after 2 failures of the same one. After 3 distinct approaches, stop and explain precisely what blocks you and what you need.
6. Verify the goal end to end like a user would: load_skill "definition-of-done" and do its checks for this kind of project, including a screenshot of every page people open. Never report success you didn't see. If something fails twice, load_skill "troubleshooting".
7. Finish with: what you built, the links (short /go links), where credentials are (Services page), what you checked, and 1-3 sensible next steps. Save a lesson (remember) if you learned something reusable.`,
  },
  {
    id: "definition-of-done",
    title: "Definition of done: prove it works",
    when: "before saying any deploy, fix, migration or site is finished; load at the end of every goal",
    body: `A job is done only when you have seen it work the way the user will use it. Do every check that applies, show the evidence, and fix anything that fails before reporting.
Website / web app (any stack):
- curl -s -o /dev/null -w '%{http_code} %{time_total}' the link (expect 200, under ~3 s), and a second key page (e.g. /about, /login, /products).
- screenshot the home page and the page the user cares about; read what the screenshot shows. Not done if it shows: a default page (WordPress "Hello world"/"Archives", "Welcome to nginx", "It works!", "Index of /", Next.js/Vite starter), a blank or white page, an error (404, 500, 502, "Error establishing a database connection", stack trace), unstyled HTML (CSS missing: check asset URLs and the site URL setting), or a login wall the user didn't ask for.
- If the user gave a reference (theme demo, design, screenshot, old site), compare: same sections, imagery and layout? Say what still differs.
- Mobile: screenshot with full_page; nothing obviously broken.
API / backend: call a real endpoint (GET health or a list endpoint) and check the JSON; for writes, create then read back test data and remove it; check CORS from the frontend's origin if there is one.
Database-backed apps: the page that reads data shows data; db_query the tables you created/imported with row counts; the app's env points at the right database.
Workers / bots / cron: logs show a successful run after your change (project_action logs, schedule_task run_now, job_log); no restart loop (systemctl state stays active for 60 s).
Services from the catalog: use_service status (port answers), sign-in details on the Services page, one real action works (e.g. a backup, a monitor added).
WordPress: home and a page render the theme with real content (not the default post), /wp-admin login page loads, use_service check shows no PHP errors, permalinks work (open a post URL).
After any change to an existing project: what worked before still works (home page, login, one data page).
Report: links (short /go), what you checked and saw (status codes, screenshot verdicts, row counts), anything left for the user, and the final screenshot.`,
  },
  {
    id: "troubleshooting",
    title: "Troubleshooting: symptom → cause → fix",
    when: "a deploy fails, a site errors or misbehaves, something worked before and stopped, or the same step failed twice",
    body: `Match the symptom, check the cause with a read-only command, then fix. Re-verify after each fix (definition-of-done).
Build / install
- "npm ERR! ERESOLVE" → npm install --legacy-peer-deps (or the repo's lockfile tool: pnpm/yarn/bun if pnpm-lock/yarn.lock/bun.lockb exists).
- "Killed" / exit 137 / JavaScript heap out of memory → NODE_OPTIONS=--max-old-space-size=3072, fewer parallel builds, or a machine with more free RAM.
- "No space left on device" → free disk (docker system prune -f, caches, old logs) or deploy elsewhere.
- Python "error: externally-managed-environment" → always use .venv; missing headers (mysqlclient, psycopg2) → sudo apt-get install -y build-essential default-libmysqlclient-dev libpq-dev pkg-config, or psycopg2-binary.
- Java: wrong JDK → install the version in pom.xml/build.gradle (openjdk-17/21); "mvnw: Permission denied" → chmod +x mvnw.
- PHP/Composer: missing extension (ext-gd, ext-intl, ext-zip, ext-mbstring, pdo_mysql) → sudo apt-get install -y php-<ext>; Laravel: php artisan key:generate, storage:link, migrate --force, chmod -R ug+rw storage bootstrap/cache.
- Private repo clone fails (403/404) → GitHub not connected or token lacks repo scope: ask the user to reconnect on the Projects page.
Start / runtime
- Service "activating"/restart loop → read project_action logs: usually wrong start command, missing env var, or the app ignores $PORT (listen on process.env.PORT / --port $PORT / 0.0.0.0, not 127.0.0.1 or a hard-coded port).
- "EADDRINUSE"/"address already in use" → another project has the port (ss -ltnp): pick a free one.
- Next.js "Could not find a production build" → build step missing (npm run build) or wrong start (next start -p $PORT); static export (output: 'export') → serve the out/ folder.
- Vite/React/Vue SPA shows 404 on refresh → serve with a SPA fallback (npx serve -s dist -l $PORT).
- Link shows 502/"bad gateway" → the app isn't listening yet or crashed: logs; wait for the deploy job to finish.
- Site loads but no CSS/JS, or mixed-content warnings → wrong base URL/asset prefix (APP_URL, NEXT_PUBLIC_*, WordPress home/siteurl, Vite base) or http vs https behind the proxy (trust X-Forwarded-Proto).
- CORS errors → set the API's allowed origin to the frontend's real link; for cookies also credentials and SameSite=None; Secure.
- Websockets fail → the app must accept the Upgrade on $PORT; long-polling fallback if not.
- Environment variable undefined in the browser → frameworks only expose prefixed ones (NEXT_PUBLIC_, VITE_, REACT_APP_) and need a rebuild after changing them.
Data
- "ECONNREFUSED 127.0.0.1:5432/3306/27017" → database on another machine: connect_projects (opens the tunnel) or link_databases; check the tunnel in fleet_status.
- "Access denied"/"password authentication failed" → app env doesn't match the database's stored credentials: connect_projects again (it rewrites them).
- "Unknown database"/"relation does not exist" → create the database / run migrations (artisan migrate, prisma migrate deploy, alembic upgrade head, rails db:migrate) or import the .sql.
- MySQL "caching_sha2_password" with old clients → ALTER USER ... IDENTIFIED WITH mysql_native_password (only for legacy apps).
Machines
- Machine unreachable/"cooling down until …" → InstaBox rest: use another machine for new work, move_project for apps that must stay up, tell the user when it's back.
- Storage machine resting (store_down) → the dashboard banner offers wait or switch: explain, don't retry in a loop.
Still stuck after 3 different approaches: stop, show the exact error, what you tried, and the 1-2 options that need the user.`,
  },
  {
    id: "templates-and-themes",
    title: "Templates, themes and starter kits",
    when: "the user gives a theme, template, UI kit, HTML template, ThemeForest/Envato package or 'make it look like this site'",
    body: `The goal is the look the user saw, not just the files installed.
1. Find out what it is: read the zip/repo (readme, documentation folder, package.json, style.css header, theme.json). Kinds: WordPress theme (+ demo content), HTML/CSS template (static), React/Next/Vue starter (build), Envato package (often a zip containing the real theme zip + documentation + demo data: unpack the inner zip).
2. Find the demo: where the designed pages come from (WordPress: demo importer plugin, .xml/.wie/.dat files, Elementor kits; HTML: index.html and pages already designed; starters: sample data or seed scripts). If several demos exist and the user didn't say, ask_user with their names.
3. Install with its own method: WordPress → see the wordpress playbook (theme, required plugins, demo import, front page, menus); HTML → deploy the folder as a static site (npx serve -s . -l $PORT) keeping relative asset paths; starters → install, build, start on $PORT, seed sample data if the template expects it.
4. Replace placeholders the user gave you (site name, logo, contact details, colors) and nothing else unless asked.
5. Verify visually (definition-of-done): screenshot home + one inner page and compare to the demo the user saw; list differences honestly (e.g. "premium images aren't included in the free version").
6. Licensing: premium themes need the user's licence/purchase code for one-click demo import or updates; ask for it (it goes to the vault) instead of working around it.`,
  },
  {
    id: "data-migration",
    title: "Moving data safely",
    when: "importing a .sql/.dump/.csv, copying a database between machines or from a cloud provider, restoring a backup",
    body: `Never lose data; prove the copy is complete.
1. Before: use_service <db> backup of the target (even if empty), and note row counts of the source (db_query count(*) per table, or the dump's INSERT/COPY counts).
2. Choose the engine from the dump: backticks/ENGINE=/AUTO_INCREMENT → MySQL/MariaDB; COPY/SERIAL/CREATE EXTENSION/pg_dump header → Postgres; .archive/.bson → MongoDB (mongorestore). Mismatch → convert only if the user agrees (it's lossy).
3. Import: copy_attachment to imports/<file> on the database's machine, then use_service <db> import_sql {path, database} (MySQL/Postgres) or the matching restore action. Large dumps: run as a job and follow it.
4. Cloud → here (Atlas, RDS, Supabase, Neon, PlanetScale): dump from the source with the user's connection string (vault placeholder) on one of the machines (mysqldump/pg_dump/mongodump --uri), then import; keep the cloud copy until the user confirms.
5. After: row counts match per table (report a table of before/after), the app's env points to the new database (connect_projects), the app page that reads data shows it (screenshot), and a backup schedule exists (schedule_task with the backup command).
6. Problems: encoding (use utf8mb4 / UTF8), definer/privilege errors in MySQL dumps (strip DEFINER=... lines), owner/role errors in Postgres dumps (--no-owner --no-privileges equivalents: remove OWNER TO lines), duplicate keys (import into an empty database).`,
  },
  {
    id: "architecture",
    title: "Solution architecture",
    when: "designing a system, choosing technologies, splitting services, scaling, 'how should I build X'",
    body: `Work like a principal engineer writing an architecture decision.
1. Requirements: functional (what it must do) and non-functional (users, requests/s, data size, latency, availability, security, budget). Infer sensible numbers when unstated and say so.
2. Constraints of this fleet: InstaBox machines (4 vCPU, ~8 GB RAM, ~20 GB disk each, free plan: idle machines pause, 2 h runtime then cool-down). Design for that: stateless apps that can run on any machine (replicas on 2 machines for anything that must stay up), state in the database machine (box5) with backups, no single machine holding both critical state and heavy compute.
3. Components: clients → edge (InstaBox HTTPS link, /go short link) → web/API services → workers/queues (Redis) → databases (Postgres for relational, MongoDB for documents, Redis for cache/queues) → object storage (MinIO) → automation (n8n) → observability (Uptime Kuma, Grafana, logs). Only include what the requirements need.
4. Data: model the main entities and their access patterns; pick the store per pattern; indexes; retention; backups (use_service backup + schedule_task).
5. Trade-offs: give 2-3 options with pros/cons and a clear recommendation. Name what would make you change your mind.
6. Deliverables: show_diagram of the architecture; create_artifact (markdown) "Architecture: <name>" with context, decision, alternatives, consequences, risks, and a phased rollout plan; update_plan with the build steps. Then, if the user wants, build it.`,
  },
  {
    id: "frontend-design",
    title: "Senior frontend and product design",
    when: "building or improving a website, landing page, dashboard UI, theme, or anything people look at",
    body: `Design like a senior product designer who also ships the code.
1. Purpose first: who uses it, the one thing they must do or understand, the brand's tone. Pick a clear visual direction (editorial, minimal, bold, playful, technical) and commit to it; never the generic AI look (purple gradients, glassmorphism everywhere, emoji headings, centered-everything, identical cards).
2. System before screens: a type scale (2 families max, 1.2-1.333 ratio, 16-18px body, 60-75ch lines), a 4/8px spacing scale, a small color system as CSS variables (background, surface, text, muted, border, one accent, status colors) with WCAG AA contrast (4.5:1 text), radius and shadow tokens.
3. Layout: strong hierarchy (one primary action per view), alignment to a grid, generous whitespace, content-first. Responsive from 360px to wide screens; test the narrow layout.
4. Quality details: real copy (no lorem ipsum), real states (loading, empty, error, success, disabled, hover, focus-visible), keyboard access, alt text, labels on inputs, prefers-reduced-motion, dark mode via variables when it fits.
5. Performance: optimized images (sizes, lazy, modern formats), minimal JS, no layout shift, fonts with font-display: swap.
6. Ship: build it in the repo (repo_commit on a branch + pull request) or as an html artifact for a quick concept; deploy; open the link and check every page responds (curl status codes, look for console-breaking errors in the build log). Describe the design decisions briefly to the user.`,
  },
  {
    id: "senior-implementation",
    title: "Senior implementation",
    when: "writing or changing code in a repository (features, fixes, refactors)",
    body: `Ship code a senior reviewer would approve.
1. Read before writing: repo_files/repo_read the entry points, the code you'll touch, its tests, and conventions (formatting, naming, error handling, folder structure). Match them.
2. Plan the change (update_plan): smallest set of files, data flow, edge cases (empty, huge, concurrent, failure, unauthorized), migrations, config/env changes, backwards compatibility.
3. Branch: ask_user for the branch once per session (main vs assistant/<topic> + pull request) unless already decided.
4. Implement in focused commits with clear messages. Validate inputs at boundaries, handle errors explicitly, no secrets in code (env vars), no dead code, no TODOs left behind.
5. Tests: add or update tests for the behavior you changed. Run the project's checks on a machine (clone to ~/tmp/<repo>, install, run lint/typecheck/tests/build) with start_job + job_log; fix until green.
6. Self-review your diff like a reviewer: correctness, security (injection, auth, secrets), performance (N+1, unbounded loops, missing indexes), readability. Fix what you find.
7. Deploy (auto-deploy on push, or deploy_project), verify the live behavior, and report: what changed, commit/PR links, how you verified, how to roll back.`,
  },
  {
    id: "debugging",
    title: "Systematic debugging",
    when: "something is broken, erroring, slow, crashing, or behaving unexpectedly",
    body: `Find the root cause before changing anything.
1. Reproduce: get the exact symptom (status code, error text, which URL/command, since when). curl it yourself.
2. Collect evidence: project_action logs (last 200 lines), job_log of the last deploy, systemctl state, docker logs, fleet_status (disk, memory, CPU), recent commits (what changed?).
3. Hypothesize: list 2-3 likely causes ranked by evidence. Test the cheapest one first with a read-only command.
4. Fix the cause, not the symptom (restart is not a fix unless the cause was transient). Keep the change minimal.
5. Verify the original symptom is gone and nothing else broke. If a deploy caused it and the fix is not quick, roll back first (redeploy the previous commit), then fix calmly.
6. Prevent: add a health check, a monitor (uptime-kuma add_monitor), a test, or a lesson (remember).`,
  },
  {
    id: "security-review",
    title: "Security review and hardening",
    when: "security questions, before going public, handling user data, after adding a service",
    body: `Review like a security engineer; fix what is safe to fix, report the rest by severity.
1. Exposure: list every public link (fleet_status). Databases and admin tools must be private (127.0.0.1 + private link). Check ss -ltn for services listening on 0.0.0.0 that shouldn't.
2. Secrets: none in repos (search for keys, .env committed), env files 600, strong generated passwords, rotate anything exposed. Use the vault ({{secret:NAME}}).
3. Auth: admin UIs behind login, default passwords changed, rate limiting on login endpoints, secure cookies over HTTPS.
4. Dependencies: npm audit --omit=dev / pip-audit / composer audit on the machine; update criticals; WordPress: core, themes, plugins up to date (wp core/plugin/theme update).
5. App: input validation, parameterized queries, output escaping, CORS restricted to the real frontend, security headers (CSP, HSTS, X-Content-Type-Options, frame-ancestors).
6. Data: backups exist and restore was tested; least-privilege database users for apps.
7. Report as an artifact: findings (severity, evidence, fix, status), and what you already fixed.`,
  },
  {
    id: "ci-cd",
    title: "CI/CD pipelines",
    when: "setting up tests/builds on push, auto-deploys, release flows, quality gates",
    body: `Every push should be checked, and only good builds should reach users.
1. CI in the repo: .github/workflows/ci.yml running install → lint → typecheck → tests → build on pull requests and main, with caching (actions/setup-node cache, pip cache). Commit it on a branch with a PR (workflow files need approval).
2. CD: connect the project to GitHub with auto-deploy (deploy_project github_repo + github_auto_deploy) so pushes to the chosen branch redeploy. Protect main: changes go through PRs with CI green.
3. Deploy safety: health check after deploy (curl the link, expect 200 and a known string); if it fails, read job_log, fix, or roll back to the previous commit.
4. Environments: a staging copy (<name>-staging on another machine, branch dev) when the user wants to test before production.
5. Code review: offer CodeRabbit (.coderabbit.yaml) or review the diff yourself before merging.
6. Report the pipeline as a show_diagram: push → CI → merge → webhook → deploy → health check → live.`,
  },
  {
    id: "wordpress",
    title: "WordPress, end to end",
    when: "any WordPress site, theme, template, plugin, or 'make me a website' where WordPress fits",
    body: `Deliver a working WordPress site without asking the user to click through setup.
1. update_plan: database → WordPress → install & admin login → theme/template → plugins/content → checks → handover.
2. Database: reuse the MySQL service (fleet_status; add_service mysql if none). WordPress gets its own database automatically.
3. Install: add_service template "wordpress" (PHP + Apache in Docker, data in ~/data/<name>, connected to MySQL, private by default; use name the user implies, e.g. "blog"). Wait for the deploy (job_log).
4. Set up by command, not by browser: use_service <name> setup with params {title, admin_email?} → installs WordPress with WP-CLI, sets the site URL to its real link, creates the admin (password generated and shown on the Services page), sets permalinks to /%postname%/.
5. Template/theme: if the user gave a theme or template link (a .zip URL, a wordpress.org theme slug or page, a GitHub repo), use_service <name> theme with params {source: "<zip url or slug>"} (activates it). For a GitHub repo, use its zip download URL (https://github.com/<owner>/<repo>/archive/refs/heads/<branch>.zip). Plugins the template needs: use_service <name> plugin {source}. A demo content file (.xml): use_service <name> import {url}. Anything else: use_service <name> wp {args: "<wp-cli command>"}.
5b. Designed themes (Elementor/ThemeForest-style: Spexo, Astra, OceanWP, Kadence, Avada…): activating the theme only changes fonts and colors; the look people saw on the theme's website is a DEMO (pages, menus, images, widgets) imported separately. Read the theme's readme.txt and its companion plugin (wp plugin list; e.g. Spexo → "Spexo Addons for Elementor" / sastra-essential-addons-for-elementor, Astra → "Starter Templates") to find how demos are imported. If the user didn't say which demo, ask_user with the demo names from the theme's site. Import it with the plugin's importer or the demo's .xml (use_service import) plus its Elementor kit, set the front page (wp option update show_on_front page; page_on_front <id>) and the menus. If a demo can only be imported from wp-admin's one-click screen, say so plainly and give the exact clicks (Appearance/plugin menu → Prebuilt websites → <demo> → Import) with the admin login location.
6. Checks: use_service <name> check (home page status, admin page, PHP errors in the log, site URL). Done means it looks like what the user asked for: if the home page is still WordPress's default (a "Hello world!" post, an "Archives" page, "Sample Page" menu), the job is NOT done; import the content/demo or say exactly what's missing. Fix problems yourself (wrong URL → wp option update home/siteurl; memory → WP_MEMORY_LIMIT; missing PHP extension; permalinks → wp rewrite flush). Re-check.
7. Make it public only if the user asked for a public site (redeploy with link public), then set the URL again with setup's url step (use_service <name> wp {args: "option update home <link>"} and siteurl).
8. Handover: site link, /wp-admin link, "admin login is on the Services page", what you installed, and next steps (pages to edit, a backup schedule: use_service mysql backup + schedule_task).`,
  },
  {
    id: "performance",
    title: "Performance and scaling",
    when: "slow pages, high CPU/memory, timeouts, preparing for traffic",
    body: `Measure, then fix the biggest bottleneck.
1. Measure: curl -w '%{time_total}' on key URLs (5 runs), fleet_status CPU/memory, top/ps on the machine, slow queries (Postgres pg_stat_statements, MySQL slow log), log timings.
2. Typical fixes by layer: static assets (compression, caching headers, CDN-able links), app (production builds, enough workers: gunicorn -w 2-4, Node cluster/pm2, PHP-FPM/opcache), database (indexes for the slow queries, connection pooling, avoid N+1), caching (Redis for hot reads, page cache for WordPress), background work off the request path (queue + worker).
3. Capacity: one machine has 4 vCPU/8 GB; run replicas on 2 machines for heavy or critical apps; keep databases on the database machine.
4. Verify with the same measurements and report before/after numbers.`,
  },
  {
    id: "incident-response",
    title: "Incident response",
    when: "an outage, a site down for users, data at risk, a machine lost",
    body: `Restore service first, then find out why.
1. Assess impact: which projects/links are down (fleet_status, curl), since when, which machine.
2. Mitigate fast: machine resting/lost → redeploy stateless apps to a healthy machine (deploy_project with vms) and confirm the /go link serves them; bad deploy → roll back; resource exhaustion → free disk/memory; database down → restart it, check disk, restore from the latest backup only with approval.
3. Communicate in chat with update_plan (Mitigate → Verify → Root cause → Prevent) so the user sees progress.
4. Root cause with evidence (logs, timeline). Prevent: replicas for critical apps, monitors with alerts, backups, a lesson saved with remember.
5. Write a short postmortem artifact: summary, impact, timeline, root cause, fixes, follow-ups.`,
  },
];

export function skill(id: string): Skill | undefined {
  return SKILLS.find((s) => s.id === id);
}

/** The list the system prompt shows: id, title, when to load. */
export function skillIndex(): string {
  return SKILLS.map((s) => `- ${s.id}: ${s.title}. Load for: ${s.when}`).join("\n");
}
