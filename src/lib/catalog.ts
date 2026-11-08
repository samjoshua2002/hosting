// One-click services: databases, database admin tools and popular self-hosted apps, all as Docker
// containers with data under ~/data/<name>. {name} is replaced by the service's name when it's created.
// Browser-safe (no secrets): passwords are written as "generate" and filled in on the server.

export type ServiceCategory = "Databases" | "Database tools" | "Storage" | "Monitoring" | "Automation" | "Analytics" | "AI" | "Developer tools";
export type DbEngine = "postgres" | "mysql" | "mongo" | "redis";

export interface ServiceTemplate {
  id: string;
  name: string;
  category: ServiceCategory;
  desc: string;
  type: "database" | "tool" | "service" | "website";
  port: number;
  link: "none" | "private" | "public";
  install: string;
  build: string;
  start: string;
  env: Record<string, string>;
  /** created already connected to a database of this engine (the tool's settings are filled in) */
  connects?: { engines: DbEngine[]; env?: string };
  /** how to sign in, for the Services page: literal user or the env key holding it, and the password's env key */
  login?: { user?: string; userEnv?: string; passEnv?: string; note?: string };
  /** memory it needs, shown as a hint */
  ram?: string;
}

const pull = (image: string) => `docker pull ${image}`;
const data = (owner?: string) => `mkdir -p "$HOME/data/{name}"${owner ? ` && sudo chown -R ${owner} "$HOME/data/{name}"` : ""}`;
const run = (args: string) => `docker rm -f {name} >/dev/null 2>&1; exec docker run --name {name} ${args}`;

export const CATALOG: ServiceTemplate[] = [
  // ---- databases ----
  {
    id: "postgres",
    name: "PostgreSQL 17",
    category: "Databases",
    desc: "The reliable SQL database. Private, data kept on the machine.",
    type: "database",
    port: 5432,
    link: "none",
    install: data(),
    build: pull("postgres:17"),
    start: run(`-p 127.0.0.1:$PORT:5432 -e POSTGRES_PASSWORD -v "$HOME/data/{name}":/var/lib/postgresql/data postgres:17`),
    env: { POSTGRES_PASSWORD: "generate" },
  },
  {
    id: "mysql",
    name: "MySQL 8.4",
    category: "Databases",
    desc: "MySQL with an \"app\" database ready for PHP, Laravel, WordPress.",
    type: "database",
    port: 3306,
    link: "none",
    install: data(),
    build: pull("mysql:8.4"),
    start: run(`-p 127.0.0.1:$PORT:3306 -e MYSQL_ROOT_PASSWORD -e MYSQL_DATABASE -v "$HOME/data/{name}":/var/lib/mysql mysql:8.4`),
    env: { MYSQL_ROOT_PASSWORD: "generate", MYSQL_DATABASE: "app" },
  },
  {
    id: "mariadb",
    name: "MariaDB 11",
    category: "Databases",
    desc: "Drop-in MySQL alternative. Uses port 3307 so it can sit next to MySQL.",
    type: "database",
    port: 3307,
    link: "none",
    install: data(),
    build: pull("mariadb:11"),
    start: run(`-p 127.0.0.1:$PORT:3306 -e MYSQL_ROOT_PASSWORD -e MYSQL_DATABASE -v "$HOME/data/{name}":/var/lib/mysql mariadb:11`),
    env: { MYSQL_ROOT_PASSWORD: "generate", MYSQL_DATABASE: "app" },
  },
  {
    id: "mongodb",
    name: "MongoDB 8",
    category: "Databases",
    desc: "Document database, admin user and password set up.",
    type: "database",
    port: 27017,
    link: "none",
    install: data(),
    build: pull("mongo:8"),
    start: run(`-p 127.0.0.1:$PORT:27017 -e MONGO_INITDB_ROOT_USERNAME=admin -e MONGO_INITDB_ROOT_PASSWORD -v "$HOME/data/{name}":/data/db mongo:8`),
    env: { MONGO_INITDB_ROOT_PASSWORD: "generate" },
  },
  {
    id: "redis",
    name: "Redis 7",
    category: "Databases",
    desc: "Cache and queues, persistent, password protected.",
    type: "database",
    port: 6379,
    link: "none",
    install: data(),
    build: pull("redis:7"),
    start: run(`-p 127.0.0.1:$PORT:6379 -v "$HOME/data/{name}":/data redis:7 redis-server --appendonly yes --requirepass "$REDIS_PASSWORD"`),
    env: { REDIS_PASSWORD: "generate" },
  },

  // ---- database tools (placed next to their database, already pointed at it) ----
  {
    id: "pgadmin",
    name: "pgAdmin 4",
    category: "Database tools",
    desc: "Manage PostgreSQL in the browser. Your server is already listed.",
    type: "tool",
    port: 5050,
    link: "private",
    install: data("5050:5050"),
    build: `${pull("dpage/pgadmin4")} && printf '{"Servers":{"1":{"Name":"PostgreSQL","Group":"Servers","Host":"127.0.0.1","Port":%s,"MaintenanceDB":"postgres","Username":"%s","SSLMode":"prefer"}}}' "\${DB_PORT:-5432}" "\${DB_USERNAME:-postgres}" > "$HOME/data/{name}.servers.json"`,
    start: run(
      `--network host -e PGADMIN_LISTEN_PORT=$PORT -e PGADMIN_DEFAULT_EMAIL -e PGADMIN_DEFAULT_PASSWORD -e PGADMIN_SERVER_JSON_FILE=/pgadmin4/servers.json -v "$HOME/data/{name}.servers.json":/pgadmin4/servers.json:ro -v "$HOME/data/{name}":/var/lib/pgadmin dpage/pgadmin4`,
    ),
    env: { PGADMIN_DEFAULT_EMAIL: "admin@hosting.dev", PGADMIN_DEFAULT_PASSWORD: "generate" },
    connects: { engines: ["postgres"] },
    login: { userEnv: "PGADMIN_DEFAULT_EMAIL", passEnv: "PGADMIN_DEFAULT_PASSWORD", note: "the database password is in the Databases list" },
  },
  {
    id: "phpmyadmin",
    name: "phpMyAdmin",
    category: "Database tools",
    desc: "The classic MySQL / MariaDB admin, already pointed at your database.",
    type: "tool",
    port: 8081,
    link: "private",
    install: "",
    build: pull("phpmyadmin"),
    start: run(`--network host -e PMA_HOST=127.0.0.1 -e PMA_PORT="\${DB_PORT:-3306}" -e APACHE_PORT=$PORT -e UPLOAD_LIMIT=256M phpmyadmin`),
    env: {},
    connects: { engines: ["mysql"] },
    login: { userEnv: "DB_USERNAME", passEnv: "DB_PASSWORD" },
  },
  {
    id: "adminer",
    name: "Adminer",
    category: "Database tools",
    desc: "One small page for MySQL, MariaDB and PostgreSQL.",
    type: "tool",
    port: 8082,
    link: "private",
    install: "",
    build: pull("adminer"),
    start: run(`--network host -e ADMINER_DEFAULT_SERVER="127.0.0.1:\${DB_PORT:-3306}" adminer php -S 0.0.0.0:$PORT -t /var/www/html`),
    env: {},
    connects: { engines: ["mysql", "postgres"] },
    login: { userEnv: "DB_USERNAME", passEnv: "DB_PASSWORD" },
  },
  {
    id: "mongo-express",
    name: "Mongo Express",
    category: "Database tools",
    desc: "Browse and edit MongoDB collections.",
    type: "tool",
    port: 8083,
    link: "private",
    install: "",
    build: pull("mongo-express"),
    start: run(
      `--network host -e ME_CONFIG_MONGODB_URL -e ME_CONFIG_BASICAUTH=true -e ME_CONFIG_BASICAUTH_USERNAME=admin -e ME_CONFIG_BASICAUTH_PASSWORD -e VCAP_APP_HOST=0.0.0.0 -e VCAP_APP_PORT=$PORT -e PORT=$PORT mongo-express`,
    ),
    env: { ME_CONFIG_BASICAUTH_PASSWORD: "generate" },
    connects: { engines: ["mongo"], env: "ME_CONFIG_MONGODB_URL" },
    login: { user: "admin", passEnv: "ME_CONFIG_BASICAUTH_PASSWORD" },
  },
  {
    id: "redisinsight",
    name: "Redis Insight",
    category: "Database tools",
    desc: "Redis's own browser UI, connected to your Redis.",
    type: "tool",
    port: 5540,
    link: "private",
    install: data("1000:1000"),
    build: pull("redis/redisinsight"),
    start: run(
      `--network host -e RI_APP_PORT=$PORT -e RI_REDIS_HOST=127.0.0.1 -e RI_REDIS_PORT="\${REDIS_PORT:-6379}" -e RI_REDIS_PASSWORD="\${REDIS_PASSWORD:-}" -v "$HOME/data/{name}":/data redis/redisinsight`,
    ),
    env: {},
    connects: { engines: ["redis"] },
    login: { note: "no sign-in of its own: keep the link private" },
  },
  {
    id: "cloudbeaver",
    name: "CloudBeaver",
    category: "Database tools",
    desc: "DBeaver in the browser: a Workbench-style editor for every database.",
    type: "tool",
    port: 8978,
    link: "private",
    install: data(),
    build: pull("dbeaver/cloudbeaver"),
    start: run(`--network host -v "$HOME/data/{name}":/opt/cloudbeaver/workspace dbeaver/cloudbeaver`),
    env: {},
    login: { note: "first visit: create the admin user; add connections with host 127.0.0.1 and the passwords from the Databases list" },
    ram: "1 GB",
  },

  // ---- storage ----
  {
    id: "minio",
    name: "MinIO (S3 storage)",
    category: "Storage",
    desc: "S3-compatible file storage with a web console. API on the next port.",
    type: "service",
    port: 9001,
    link: "private",
    install: data(),
    build: pull("minio/minio"),
    start: run(`--network host -e MINIO_ROOT_USER -e MINIO_ROOT_PASSWORD -v "$HOME/data/{name}":/data minio/minio server /data --console-address 127.0.0.1:$PORT --address 127.0.0.1:$((PORT + 1))`),
    env: { MINIO_ROOT_USER: "admin", MINIO_ROOT_PASSWORD: "generate" },
    login: { userEnv: "MINIO_ROOT_USER", passEnv: "MINIO_ROOT_PASSWORD" },
  },

  // ---- monitoring ----
  {
    id: "uptime-kuma",
    name: "Uptime Kuma",
    category: "Monitoring",
    desc: "Watch your sites and APIs, get alerts when they go down.",
    type: "service",
    port: 3001,
    link: "private",
    install: data(),
    build: pull("louislam/uptime-kuma:1"),
    start: run(`-p 127.0.0.1:$PORT:3001 -v "$HOME/data/{name}":/app/data louislam/uptime-kuma:1`),
    env: {},
    login: { note: "first visit: create the admin user" },
  },
  {
    id: "grafana",
    name: "Grafana",
    category: "Monitoring",
    desc: "Dashboards and charts for metrics and logs.",
    type: "service",
    port: 3002,
    link: "private",
    install: data("472:472"),
    build: pull("grafana/grafana"),
    start: run(`-p 127.0.0.1:$PORT:3000 -e GF_SECURITY_ADMIN_PASSWORD -v "$HOME/data/{name}":/var/lib/grafana grafana/grafana`),
    env: { GF_SECURITY_ADMIN_PASSWORD: "generate" },
    login: { user: "admin", passEnv: "GF_SECURITY_ADMIN_PASSWORD" },
  },

  // ---- automation ----
  {
    id: "n8n",
    name: "n8n",
    category: "Automation",
    desc: "Visual workflows: webhooks, schedules, 400+ integrations.",
    type: "service",
    port: 5678,
    link: "private",
    install: data("1000:1000"),
    build: pull("n8nio/n8n"),
    start: run(`-p 127.0.0.1:$PORT:5678 -e N8N_SECURE_COOKIE=false -v "$HOME/data/{name}":/home/node/.n8n n8nio/n8n`),
    env: {},
    login: { note: "first visit: create the owner account" },
  },

  // ---- analytics ----
  {
    id: "metabase",
    name: "Metabase",
    category: "Analytics",
    desc: "Questions and dashboards on top of your databases, no SQL needed.",
    type: "service",
    port: 3003,
    link: "private",
    install: data(),
    build: pull("metabase/metabase"),
    start: run(`--network host -e MB_JETTY_PORT=$PORT -e MB_DB_FILE=/metabase-data/metabase.db -v "$HOME/data/{name}":/metabase-data metabase/metabase`),
    env: {},
    login: { note: "first visit: create the admin user; add databases with host 127.0.0.1" },
    ram: "1.5 GB",
  },

  // ---- AI ----
  {
    id: "ollama",
    name: "Ollama (local AI models)",
    category: "AI",
    desc: "Run open models like Llama on the machine, private API link.",
    type: "service",
    port: 11434,
    link: "private",
    install: data(),
    build: `${pull("ollama/ollama")} && (docker rm -f {name}-pull >/dev/null 2>&1; docker run -d --name {name}-pull -v "$HOME/data/{name}":/root/.ollama ollama/ollama >/dev/null && sleep 4 && docker exec {name}-pull ollama pull "\${MODEL:-llama3.2:3b}"; docker rm -f {name}-pull >/dev/null 2>&1)`,
    start: run(`-p 127.0.0.1:$PORT:11434 -v "$HOME/data/{name}":/root/.ollama ollama/ollama`),
    env: { MODEL: "llama3.2:3b" },
    ram: "4 GB",
  },

  // ---- developer tools ----
  {
    id: "code-server",
    name: "VS Code in the browser",
    category: "Developer tools",
    desc: "code-server with your ~/apps folder open: edit projects on the machine.",
    type: "service",
    port: 8443,
    link: "private",
    install: data("1000:1000"),
    build: pull("codercom/code-server"),
    start: run(`-p 127.0.0.1:$PORT:8080 -e PASSWORD -v "$HOME/apps":/home/coder/project -v "$HOME/data/{name}":/home/coder/.config codercom/code-server /home/coder/project`),
    env: { PASSWORD: "generate" },
    login: { passEnv: "PASSWORD" },
  },
  {
    id: "portainer",
    name: "Portainer",
    category: "Developer tools",
    desc: "See and manage the Docker containers on a machine.",
    type: "service",
    port: 9000,
    link: "private",
    install: data(),
    build: pull("portainer/portainer-ce"),
    start: run(`-p 127.0.0.1:$PORT:9000 -v /var/run/docker.sock:/var/run/docker.sock -v "$HOME/data/{name}":/data portainer/portainer-ce`),
    env: {},
    login: { note: "open it within 5 minutes of starting to create the admin user" },
  },
];

export const CATEGORIES: ServiceCategory[] = ["Databases", "Database tools", "Storage", "Monitoring", "Automation", "Analytics", "AI", "Developer tools"];

export function template(id: string): ServiceTemplate | undefined {
  return CATALOG.find((t) => t.id === id);
}

/** Which engine a database project runs (from its start command). */
export function engineFromStart(start: string): DbEngine | null {
  if (/postgres/.test(start)) return "postgres";
  if (/mysql|mariadb/.test(start)) return "mysql";
  if (/mongo/.test(start)) return "mongo";
  if (/redis/.test(start)) return "redis";
  return null;
}

/** Recognise a running service from its start command (covers ones installed before the catalog). */
const DETECT: [string, RegExp][] = [
  ["mongo-express", /mongo-express/],
  ["pgadmin", /pgadmin4|pgadmin/],
  ["phpmyadmin", /phpmyadmin/],
  ["adminer", /\badminer\b/],
  ["redisinsight", /redisinsight/],
  ["cloudbeaver", /cloudbeaver/],
  ["minio", /minio\/minio/],
  ["uptime-kuma", /uptime-kuma/],
  ["grafana", /grafana\/grafana/],
  ["n8n", /n8nio\/n8n/],
  ["metabase", /metabase\/metabase/],
  ["ollama", /\bollama\b/],
  ["code-server", /code-server/],
  ["portainer", /portainer/],
  ["mariadb", /mariadb:/],
  ["mysql", /\bmysql:/],
  ["postgres", /postgres:/],
  ["mongodb", /\bmongo:/],
  ["redis", /redis:\d|redis-server/],
];

export function serviceIdOf(m: { template?: string; start: string; build: string }): string | null {
  if (m.template && template(m.template)) return m.template;
  const s = `${m.start} ${m.build}`;
  return DETECT.find(([, re]) => re.test(s))?.[0] ?? null;
}

/** What to do once it's running. {url} is its link, {vm} its machine, {port} its port. */
export const USAGE: Record<string, string[]> = {
  postgres: ["Host, user, password and connection string are in the Databases section above.", "To use it from a project, connect them on the Pipeline: the app gets DATABASE_URL and DB_* settings."],
  mysql: ["Connection details are in the Databases section above; the \"app\" database is ready.", "Connect a project to it on the Pipeline: it gets DATABASE_URL and DB_HOST/DB_USERNAME/DB_PASSWORD."],
  mariadb: ["Connection details are in the Databases section above (port 3307).", "Connect a project to it on the Pipeline to get its settings."],
  mongodb: ["Connection string and password are in the Databases section above.", "Connect a project on the Pipeline: it gets MONGODB_URI."],
  redis: ["Password and URL are in the Databases section above.", "Connect a project on the Pipeline: it gets REDIS_URL."],
  pgadmin: ["Open it and sign in with the email and password shown here.", "Your PostgreSQL server is already listed under Servers. When it asks, paste the database password from the Databases section."],
  phpmyadmin: ["Open it and sign in as root with the password shown here.", "Pick the \"app\" database on the left to see and edit its tables."],
  adminer: ["Open it, choose MySQL or PostgreSQL, server 127.0.0.1, and the user and password shown here."],
  "mongo-express": ["Open it and sign in as admin with the password shown here.", "Pick a database on the left to browse and edit documents."],
  redisinsight: ["Open it: your Redis is already added. Click it to browse keys and run commands."],
  cloudbeaver: ["First visit: set the admin password.", "Then New Connection → pick the engine, host 127.0.0.1, and the port and password from the Databases section."],
  minio: [
    "Open the console and sign in with the user and password shown here, then create a bucket.",
    "Apps on {vm} use the S3 endpoint http://127.0.0.1:{port+1} with that user as access key and the password as secret key.",
  ],
  "uptime-kuma": ["First visit: create the admin user.", "Add New Monitor → paste a project's link (Projects page) to get alerts when it goes down."],
  grafana: ["Sign in as admin with the password shown here.", "Connections → Add data source → PostgreSQL/MySQL, host 127.0.0.1 and the Databases section's password."],
  n8n: ["First visit: create the owner account.", "Build a workflow; webhook triggers use this service's link."],
  metabase: ["First visit: create the admin user.", "Add your database with host 127.0.0.1 and the Databases section's password, then ask questions."],
  ollama: [
    "Ollama answers on an API, it has no web page of its own (that's why it only says \"Ollama is running\").",
    "Try it right here, call it from code with the snippets below, or connect a project to it on the Pipeline (it gets {NAME}_URL).",
    "More models: ask the Assistant, e.g. \"pull mistral on {name}\".",
  ],
  "code-server": ["Open it and enter the password shown here.", "Your projects on {vm} are in the project folder; edits apply after Redeploy (or Restart for scripts)."],
  portainer: ["Open it within 5 minutes of the start to create the admin user (it locks itself otherwise: then Restart it).", "Choose Get Started to manage the Docker containers on {vm}."],
};
