// What the Assistant can do with each installed service (use_service). Every action is a bash script that runs
// on the service's machine with the service's own settings loaded (passwords stay on the machine and never
// reach the model; output is masked again before it does). $S is the project name, $C its Docker container, $PORT its port.
import { shq } from "./ssh";

export interface DriverCtx {
  name: string;
  port: number;
  params: Record<string, unknown>;
  /** for actions that need another project's connection details (metabase add_database) */
  peer?: { name: string; engine: string; port: number; env: Record<string, string>; sameMachine: boolean };
}
export interface Action {
  about: string;
  readOnly?: boolean;
  /** needs the user's approval (deletes or overwrites) */
  danger?: boolean;
  /** long-running: started in the background, check with the matching *_status action */
  needsPeer?: boolean;
  script: (c: DriverCtx) => string | { error: string };
}

const p = (c: DriverCtx, k: string) => (c.params[k] === undefined || c.params[k] === null ? "" : String(c.params[k]));
const IDENT = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$/;
function need(c: DriverCtx, ...keys: string[]): { error: string } | null {
  for (const k of keys) if (!IDENT.test(p(c, k))) return { error: `params.${k} is required (letters, digits, _ . : @ / -)` };
  return null;
}
/** a path under the home folder, for backups/uploads */
function homePath(v: string): string | null {
  const s = v.replace(/^~\//, "");
  return s && !s.includes("..") && /^[A-Za-z0-9_./-]+$/.test(s) ? s : null;
}
const BACKUPS = '"$HOME/data/backups"';
const stamp = "$(date +%Y%m%d-%H%M%S)";
const json = (o: unknown) => shq(JSON.stringify(o));

/* ---------- actions every project has ---------- */

export const COMMON: Record<string, Action> = {
  status: {
    about: "is it running, the container, and whether its port answers",
    readOnly: true,
    script: () =>
      `echo "service: $(systemctl --user is-active "hosting-$S" 2>/dev/null)"; docker ps -a --filter "name=^$C$" --format 'container: {{.Status}} ({{.Image}})' 2>/dev/null; [ -n "$PORT" ] && echo "port $PORT answers: $(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:$PORT/" || echo no)"`,
  },
  logs: { about: "last lines of its log", readOnly: true, script: () => `docker logs --tail 80 "$C" 2>&1 || tail -n 80 "$HOME/.hosting/projects/$S.log"` },
  restart: { about: "restart it", script: () => `systemctl --user restart "hosting-$S" && sleep 3 && systemctl --user is-active "hosting-$S"` },
  api: {
    about: "call its HTTP API on the machine: params {method, path, body?}; signed in as admin when the service has a known login",
    readOnly: false,
    script: (c) => {
      const method = (p(c, "method") || "GET").toUpperCase();
      const path = p(c, "path");
      if (!/^(GET|POST|PUT|PATCH|DELETE)$/.test(method) || !path.startsWith("/") || /\s/.test(path)) return { error: "params: method GET/POST/PUT/PATCH/DELETE, path starting with /" };
      const body = c.params.body === undefined ? "" : `-H 'Content-Type: application/json' --data-binary ${json(c.params.body)}`;
      return `curl -sS -m 60 -X ${method} "\${AUTH[@]}" ${body} "http://127.0.0.1:$PORT"${shq(path)} | head -c 20000`;
    },
  },
};

/* ---------- databases ---------- */

const pg = (sql: string) => `docker exec "$C" psql -U postgres -v ON_ERROR_STOP=1 -c ${shq(sql)}`;
const POSTGRES: Record<string, Action> = {
  databases: { about: "list databases and sizes", readOnly: true, script: () => `docker exec "$C" psql -U postgres -Atc "select datname, pg_size_pretty(pg_database_size(datname)) from pg_database where not datistemplate"` },
  create_database: { about: "params {database}", script: (c) => need(c, "database") ?? pg(`CREATE DATABASE "${p(c, "database")}"`) },
  backup: { about: "dump every database to ~/data/backups (gzip)", script: () => `mkdir -p ${BACKUPS}; f=${BACKUPS}/"$S"-${stamp}.sql.gz; docker exec "$C" pg_dumpall -U postgres | gzip > "$f" && ls -lh "$f"` },
  backups: { about: "list its backups", readOnly: true, script: () => `ls -lh ${BACKUPS}/"$S"-* 2>/dev/null || echo "no backups yet"` },
  restore: {
    about: "params {file} from backups: replays a dump (overwrites)",
    danger: true,
    script: (c) => {
      const f = homePath(p(c, "file").replace(/^.*data\/backups\//, "data/backups/"));
      return f ? `gunzip -c "$HOME/${f}" | docker exec -i "$C" psql -U postgres` : { error: "params.file: a file from backups" };
    },
  },
};

const MYSQL = (cli: string, dump: string): Record<string, Action> => {
  const q = (sql: string) => `docker exec -e MYSQL_PWD="$MYSQL_ROOT_PASSWORD" "$C" ${cli} -uroot -e ${shq(sql)}`;
  return {
    databases: { about: "list databases", readOnly: true, script: () => `docker exec -e MYSQL_PWD="$MYSQL_ROOT_PASSWORD" "$C" ${cli} -uroot -N -e "SHOW DATABASES"` },
    create_database: { about: "params {database}", script: (c) => need(c, "database") ?? q(`CREATE DATABASE IF NOT EXISTS \`${p(c, "database")}\` CHARACTER SET utf8mb4`) },
    backup: {
      about: "dump every database to ~/data/backups (gzip)",
      script: () => `mkdir -p ${BACKUPS}; f=${BACKUPS}/"$S"-${stamp}.sql.gz; docker exec -e MYSQL_PWD="$MYSQL_ROOT_PASSWORD" "$C" ${dump} -uroot --all-databases --single-transaction | gzip > "$f" && ls -lh "$f"`,
    },
    backups: POSTGRES.backups,
    restore: {
      about: "params {file} from backups (overwrites)",
      danger: true,
      script: (c) => {
        const f = homePath(p(c, "file").replace(/^.*data\/backups\//, "data/backups/"));
        return f ? `gunzip -c "$HOME/${f}" | docker exec -i -e MYSQL_PWD="$MYSQL_ROOT_PASSWORD" "$C" ${cli} -uroot` : { error: "params.file: a file from backups" };
      },
    },
  };
};

const mongo = `-u admin -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin`;
const MONGO: Record<string, Action> = {
  databases: {
    about: "list databases and sizes",
    readOnly: true,
    script: () => `docker exec "$C" mongosh --quiet ${mongo} --eval 'db.adminCommand({listDatabases:1}).databases.map(d=>d.name+"  "+(d.sizeOnDisk/1048576).toFixed(1)+" MB").join("\\n")'`,
  },
  backup: { about: "mongodump of everything to ~/data/backups", script: () => `mkdir -p ${BACKUPS}; f=${BACKUPS}/"$S"-${stamp}.archive.gz; docker exec "$C" mongodump ${mongo} --archive --gzip > "$f" && ls -lh "$f"` },
  backups: POSTGRES.backups,
  restore: {
    about: "params {file} from backups (mongorestore, overwrites matching collections with --drop)",
    danger: true,
    script: (c) => {
      const f = homePath(p(c, "file").replace(/^.*data\/backups\//, "data/backups/"));
      return f ? `docker exec -i "$C" mongorestore ${mongo} --archive --gzip --drop < "$HOME/${f}"` : { error: "params.file: a file from backups" };
    },
  },
};

const REDIS: Record<string, Action> = {
  info: { about: "keys per database, memory", readOnly: true, script: () => `docker exec "$C" redis-cli -a "$REDIS_PASSWORD" --no-auth-warning INFO keyspace; docker exec "$C" redis-cli -a "$REDIS_PASSWORD" --no-auth-warning INFO memory | grep -E 'used_memory_human|maxmemory_human'` },
  backup: { about: "snapshot to ~/data/backups", script: () => `mkdir -p ${BACKUPS}; docker exec "$C" redis-cli -a "$REDIS_PASSWORD" --no-auth-warning SAVE && f=${BACKUPS}/"$S"-${stamp}.rdb && docker cp "$C":/data/dump.rdb "$f" && ls -lh "$f"` },
  backups: POSTGRES.backups,
};

/* ---------- storage ---------- */

const mc = `docker exec "$C" mc alias set local "http://127.0.0.1:$((PORT + 1))" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null &&`;
const obj = (c: DriverCtx) => `local/${p(c, "bucket")}${p(c, "key") ? `/${p(c, "key")}` : ""}`;
const MINIO: Record<string, Action> = {
  buckets: { about: "list buckets", readOnly: true, script: () => `${mc} docker exec "$C" mc ls local` },
  create_bucket: { about: "params {bucket}", script: (c) => need(c, "bucket") ?? `${mc} docker exec "$C" mc mb --ignore-existing ${shq(`local/${p(c, "bucket")}`)}` },
  files: { about: "params {bucket, key?: prefix}", readOnly: true, script: (c) => need(c, "bucket") ?? `${mc} docker exec "$C" mc ls --recursive ${shq(obj(c))} | tail -n 200` },
  upload: {
    about: "params {path: file on the machine under ~, bucket, key?}",
    script: (c) => {
      const f = homePath(p(c, "path"));
      if (!f) return { error: "params.path: a file under the home folder" };
      return need(c, "bucket") ?? `${mc} docker exec -i "$C" mc pipe ${shq(`local/${p(c, "bucket")}/${p(c, "key") || f.split("/").pop()}`)} < "$HOME/${f}" && echo uploaded`;
    },
  },
  download: {
    about: "params {bucket, key, path: where to save under ~}",
    script: (c) => {
      const f = homePath(p(c, "path"));
      if (!f) return { error: "params.path: where to save, under the home folder" };
      return need(c, "bucket", "key") ?? `mkdir -p "$(dirname "$HOME/${f}")" && ${mc} docker exec "$C" mc cat ${shq(obj(c))} > "$HOME/${f}" && ls -lh "$HOME/${f}"`;
    },
  },
  remove: { about: "params {bucket, key?}: deletes an object, or the whole bucket", danger: true, script: (c) => need(c, "bucket") ?? `${mc} docker exec "$C" ${p(c, "key") ? `mc rm ${shq(obj(c))}` : `mc rb --force ${shq(obj(c))}`}` },
};

/* ---------- monitoring ---------- */

// Uptime Kuma has no REST API; its own socket API through the uptime-kuma-api package (installed once, in a venv)
const kuma = (body: string) => `V="$HOME/.hosting/tools/kuma"; [ -x "$V/bin/python" ] || { python3 -m venv "$V" && "$V/bin/pip" -q install uptime-kuma-api; } || exit 1
KUMA_URL="http://127.0.0.1:$PORT" "$V/bin/python" - <<'PY'
import os, json, sys
from uptime_kuma_api import UptimeKumaApi, MonitorType
api = UptimeKumaApi(os.environ["KUMA_URL"], timeout=30)
P = json.loads(os.environ.get("KUMA_PARAMS") or "{}")
user, pw = os.environ.get("KUMA_USER") or P.get("username"), os.environ.get("KUMA_PASSWORD") or P.get("password")
${body}
api.disconnect()
PY`;
const kumaLogin = `if api.need_setup():
    print("Uptime Kuma isn't set up yet: run the setup action first."); sys.exit(1)
if not (user and pw):
    print("No login saved: run setup (new install) or pass params.username and params.password ({{secret:NAME}})."); sys.exit(1)
api.login(user, pw)`;
const withParams = (c: DriverCtx) => `export KUMA_PARAMS=${json(c.params)};`;
const UPTIME: Record<string, Action> = {
  setup: {
    about: "first-time setup: creates the admin login (saved in the service's settings, shown on the Services page)",
    script: () =>
      `grep -q '^KUMA_PASSWORD=' "$HOME/.hosting/projects/$S.env" 2>/dev/null && { echo "already set up by the dashboard"; exit 0; }
KUMA_USER=admin KUMA_PASSWORD="$(openssl rand -hex 16)"; export KUMA_USER KUMA_PASSWORD
${kuma(`if not api.need_setup():
    print("It was already set up by hand; pass params.username and params.password to use it."); sys.exit(2)
api.setup(user, pw); print("admin login created")`)}
[ $? -eq 0 ] && printf 'KUMA_USER=admin\\nKUMA_PASSWORD=%s\\n' "$KUMA_PASSWORD" >> "$HOME/.hosting/projects/$S.env"`,
  },
  monitors: {
    about: "list monitors and whether they're up",
    readOnly: true,
    script: (c) => withParams(c) + kuma(`${kumaLogin}
for m in api.get_monitors(): print(m["id"], m["name"], m.get("url") or m.get("hostname") or "", "active" if m["active"] else "paused")`),
  },
  add_monitor: {
    about: "params {name, url, interval?: seconds (default 60), keyword?: text the page must contain}",
    script: (c) =>
      withParams(c) +
      kuma(`${kumaLogin}
kind = MonitorType.KEYWORD if P.get("keyword") else MonitorType.HTTP
r = api.add_monitor(type=kind, name=P["name"], url=P["url"], interval=int(P.get("interval") or 60), **({"keyword": P["keyword"]} if P.get("keyword") else {}))
print("added monitor", r.get("monitorID"))`),
  },
  add_notification: {
    about: "params {name, type (e.g. telegram, discord, slack, smtp, webhook), fields: {...that type's settings}}; applied to every monitor",
    script: (c) =>
      withParams(c) +
      kuma(`${kumaLogin}
r = api.add_notification(name=P["name"], type=P["type"], isDefault=True, applyExisting=True, **(P.get("fields") or {}))
print("added notification", r.get("id"))`),
  },
  pause: { about: "params {id}", script: (c) => withParams(c) + kuma(`${kumaLogin}\napi.pause_monitor(int(P["id"])); print("paused")`) },
  resume: { about: "params {id}", script: (c) => withParams(c) + kuma(`${kumaLogin}\napi.resume_monitor(int(P["id"])); print("resumed")`) },
  delete_monitor: { about: "params {id}", danger: true, script: (c) => withParams(c) + kuma(`${kumaLogin}\napi.delete_monitor(int(P["id"])); print("deleted")`) },
};

const grafana = (method: string, path: string, body?: unknown) =>
  `curl -sS -m 30 -u "admin:$GF_SECURITY_ADMIN_PASSWORD" -X ${method} ${body === undefined ? "" : `-H 'Content-Type: application/json' --data-binary ${json(body)}`} "http://127.0.0.1:$PORT${path}"`;
const GRAFANA: Record<string, Action> = {
  dashboards: { about: "list dashboards", readOnly: true, script: () => grafana("GET", "/api/search?type=dash-db") },
  datasources: { about: "list data sources", readOnly: true, script: () => grafana("GET", "/api/datasources") },
  add_datasource: {
    about: "params {datasource: Grafana data source JSON (name, type e.g. prometheus/loki/postgres/mysql/influxdb, url, access: proxy, …)}",
    script: (c) => (c.params.datasource && typeof c.params.datasource === "object" ? grafana("POST", "/api/datasources", c.params.datasource) : { error: "params.datasource: Grafana data source JSON" }),
  },
  create_dashboard: {
    about: "params {dashboard: Grafana dashboard JSON (title, panels…)}: creates or replaces by title",
    script: (c) => (c.params.dashboard && typeof c.params.dashboard === "object" ? grafana("POST", "/api/dashboards/db", { dashboard: c.params.dashboard, overwrite: true }) : { error: "params.dashboard: dashboard JSON" }),
  },
};

/* ---------- analytics ---------- */

// Metabase: the dashboard creates the admin itself (setup), then signs in with that login for every call
const mbSession = `MB="http://127.0.0.1:$PORT"; [ -n "$MB_ADMIN_PASSWORD" ] || { echo "No Metabase login saved: run setup (new install), or it was set up by hand in the browser."; exit 1; }
TOKEN=$(curl -sS -m 30 -H 'Content-Type: application/json' -d "{\\"username\\":\\"$MB_ADMIN_EMAIL\\",\\"password\\":\\"$MB_ADMIN_PASSWORD\\"}" "$MB/api/session" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("id",""))')
[ -n "$TOKEN" ] || { echo "Metabase sign-in failed"; exit 1; }
AUTH=(-H "X-Metabase-Session: $TOKEN")`;
const mb = (method: string, path: string, body?: unknown) =>
  `curl -sS -m 120 "\${AUTH[@]}" -X ${method} ${body === undefined ? "" : `-H 'Content-Type: application/json' --data-binary ${json(body)}`} "$MB${path}"`;
const METABASE: Record<string, Action> = {
  setup: {
    about: "first-time setup: creates the admin login (saved in the service's settings, shown on the Services page)",
    script: () => `MB="http://127.0.0.1:$PORT"; grep -q '^MB_ADMIN_PASSWORD=' "$HOME/.hosting/projects/$S.env" 2>/dev/null && { echo "already set up by the dashboard"; exit 0; }
TOK=$(curl -sS -m 30 "$MB/api/session/properties" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("setup-token") or "")')
[ -n "$TOK" ] || { echo "Metabase was already set up by hand (or is still starting): sign in in the browser instead."; exit 2; }
PW="$(openssl rand -hex 12)Aa1"
curl -sS -m 60 -H 'Content-Type: application/json' -d "{\\"token\\":\\"$TOK\\",\\"user\\":{\\"first_name\\":\\"Admin\\",\\"last_name\\":\\"Hosting\\",\\"email\\":\\"admin@hosting.dev\\",\\"password\\":\\"$PW\\",\\"site_name\\":\\"Hosting\\"},\\"prefs\\":{\\"site_name\\":\\"Hosting\\",\\"allow_tracking\\":false}}" "$MB/api/setup" | grep -q '"id"' || { echo "setup failed"; exit 1; }
printf 'MB_ADMIN_EMAIL=admin@hosting.dev\\nMB_ADMIN_PASSWORD=%s\\n' "$PW" >> "$HOME/.hosting/projects/$S.env"; echo "admin login created (admin@hosting.dev)"`,
  },
  databases: { about: "databases Metabase knows", readOnly: true, script: () => `${mbSession}\n${mb("GET", "/api/database")} | python3 -c 'import json,sys; d=json.load(sys.stdin); [print(x["id"], x["engine"], x["name"]) for x in d.get("data", d)]'` },
  add_database: {
    about: "params {database: one of your database projects}: adds it with its stored login (it must be on the same machine or tunnelled with link_databases)",
    needsPeer: true,
    script: (c) => {
      const d = c.peer;
      if (!d) return { error: "params.database: name of one of your database projects" };
      const engine = d.engine === "mongo" ? "mongo" : d.engine === "mysql" ? "mysql" : d.engine === "postgres" ? "postgres" : "";
      if (!engine) return { error: `${d.name} isn't a Postgres, MySQL or MongoDB database` };
      const user = engine === "postgres" ? "postgres" : engine === "mysql" ? "root" : "admin";
      const pass = d.env.POSTGRES_PASSWORD ?? d.env.MYSQL_ROOT_PASSWORD ?? d.env.MONGO_INITDB_ROOT_PASSWORD ?? "";
      const dbname = engine === "postgres" ? "postgres" : engine === "mysql" ? d.env.MYSQL_DATABASE || "app" : "admin";
      const details: Record<string, unknown> = { host: "127.0.0.1", port: d.port, dbname, user, password: pass, ...(engine === "mongo" ? { "authdb": "admin", "use-conn-uri": false } : {}) };
      return `${mbSession}\n${mb("POST", "/api/database", { engine, name: d.name, details, is_full_sync: true })} | python3 -c 'import json,sys; d=json.load(sys.stdin); print("added database", d.get("id"), d.get("name")) if "id" in d else print(json.dumps(d)[:400])'${d.sameMachine ? "" : `\necho "(${d.name} is on another machine: make sure link_databases connects this machine to it)"`}`;
    },
  },
  questions: { about: "saved questions", readOnly: true, script: () => `${mbSession}\n${mb("GET", "/api/card?f=all")} | python3 -c 'import json,sys; [print(x["id"], x["name"]) for x in json.load(sys.stdin)]'` },
  query: {
    about: "params {database_id, sql}: runs a native query and prints the first rows",
    readOnly: true,
    script: (c) => {
      const id = Number(c.params.database_id);
      if (!Number.isInteger(id) || !p(c, "sql")) return { error: "params: database_id (from databases) and sql" };
      return `${mbSession}\n${mb("POST", "/api/dataset", { database: id, type: "native", native: { query: p(c, "sql") } })} | python3 -c 'import json,sys; d=json.load(sys.stdin).get("data",{}); print(" | ".join(c["name"] for c in d.get("cols",[]))); [print(" | ".join(map(str,r))) for r in d.get("rows",[])[:50]]'`;
    },
  },
  create_question: {
    about: "params {name, database_id, sql, display?: table|bar|line|pie}: saves a question people can open in Metabase",
    script: (c) => {
      const id = Number(c.params.database_id);
      if (!Number.isInteger(id) || !p(c, "sql") || !p(c, "name")) return { error: "params: name, database_id and sql" };
      const card = { name: p(c, "name"), display: p(c, "display") || "table", visualization_settings: {}, dataset_query: { database: id, type: "native", native: { query: p(c, "sql") } } };
      return `${mbSession}\n${mb("POST", "/api/card", card)} | python3 -c 'import json,sys; d=json.load(sys.stdin); print("saved question", d.get("id"), d.get("name"))'`;
    },
  },
};

/* ---------- websites ---------- */

// WP-CLI in its own container, sharing the site's files and database settings (www-data is 33 in the Apache image)
const WP_FN = `WPDB="wp_$(printf %s "$S" | tr - _)"
WP() { docker run --rm -i --network host --user 33:33 -e HOME=/tmp -e WORDPRESS_DB_HOST="127.0.0.1:\${DB_PORT:-3306}" -e WORDPRESS_DB_USER="$DB_USERNAME" -e WORDPRESS_DB_PASSWORD="$DB_PASSWORD" -e WORDPRESS_DB_NAME="$WPDB" -e WORDPRESS_CONFIG_EXTRA="$WP_EXTRA" -v "$HOME/data/$S":/var/www/html wordpress:cli wp "$@"; }
SITE=$(sed 's/?.*//' "$HOME/.hosting/projects/$S.url" 2>/dev/null); [ -n "$SITE" ] || SITE="http://127.0.0.1:$PORT"`;

/** Split a WP-CLI argument string like a shell would (quotes group words, --opt="two words" stays one), without running anything. */
export function splitArgs(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let has = false;
  let q: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === q) q = null;
      else if (ch === "\\" && q === '"' && i + 1 < line.length) cur += line[++i];
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      q = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
    } else if (ch === "\\" && i + 1 < line.length) {
      cur += line[++i];
      has = true;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}
const wpSource = (v: string) => /^(https:\/\/\S+|[a-z0-9][a-z0-9-]{0,80})$/i.test(v);

const WORDPRESS: Record<string, Action> = {
  setup: {
    about: "params {title, admin_email?, url?}: installs WordPress by command (admin login generated and saved for the Services page), sets the site URL to its link, pretty permalinks",
    script: (c) => {
      const title = p(c, "title") || c.name;
      const email = p(c, "admin_email") || "admin@example.com";
      const url = p(c, "url");
      if (url && !/^https?:\/\/[^\s'"]+$/.test(url)) return { error: "params.url must be an http(s) link" };
      return `${WP_FN}
${url ? `SITE=${shq(url.replace(/\/$/, ""))}` : ""}
for i in $(seq 1 40); do [ -f "$HOME/data/$S/wp-config.php" ] && break; sleep 3; done
[ -f "$HOME/data/$S/wp-config.php" ] || { echo "WordPress files aren't there yet: check status/logs"; exit 1; }
WP db create >/dev/null 2>&1 || true
if WP core is-installed 2>/dev/null; then
  echo "WordPress was already installed; updating its address"
else
  grep -q '^WP_ADMIN_PASSWORD=' "$HOME/.hosting/projects/$S.env" 2>/dev/null || printf 'WP_ADMIN_USER=admin\nWP_ADMIN_PASSWORD=%s\n' "$(openssl rand -base64 18 | tr -d '/+=' | head -c 20)" >> "$HOME/.hosting/projects/$S.env"
  set -a; . "$HOME/.hosting/projects/$S.env"; set +a
  WP core install --url="$SITE" --title=${shq(title)} --admin_user="$WP_ADMIN_USER" --admin_password="$WP_ADMIN_PASSWORD" --admin_email=${shq(email)} --skip-email || exit 1
fi
WP option update home "$SITE" >/dev/null && WP option update siteurl "$SITE" >/dev/null
WP rewrite structure '/%postname%/' --hard >/dev/null 2>&1; WP rewrite flush --hard >/dev/null 2>&1
echo "site: $SITE"; echo "admin: $SITE/wp-admin (user and password on the Services page)"; WP core version | sed 's/^/WordPress /'`;
    },
  },
  theme: {
    about: "params {source: theme zip URL or wordpress.org slug, activate?: true}: installs (replacing an older copy) and activates it",
    script: (c) => (wpSource(p(c, "source")) ? `${WP_FN}
WP theme install ${shq(p(c, "source"))} --force ${c.params.activate === false ? "" : "--activate"} && WP theme list --status=active --fields=name,version` : { error: "params.source: an https zip link or a wordpress.org theme slug" }),
  },
  plugin: {
    about: "params {source: plugin zip URL or wordpress.org slug, activate?: true}",
    script: (c) => (wpSource(p(c, "source")) ? `${WP_FN}
WP plugin install ${shq(p(c, "source"))} --force ${c.params.activate === false ? "" : "--activate"} && WP plugin list --status=active --fields=name,version` : { error: "params.source: an https zip link or a wordpress.org plugin slug" }),
  },
  import: {
    about: "params {url: WordPress export .xml (demo content)}: imports posts, pages, menus and media",
    script: (c) =>
      /^https:\/\/\S+$/.test(p(c, "url"))
        ? `${WP_FN}
WP plugin install wordpress-importer --activate >/dev/null && curl -fsSL ${shq(p(c, "url"))} -o "$HOME/data/$S/.import.xml" && sudo chown 33:33 "$HOME/data/$S/.import.xml" 2>/dev/null; WP import /var/www/html/.import.xml --authors=create; rm -f "$HOME/data/$S/.import.xml"`
        : { error: "params.url: https link to a WordPress export (.xml)" },
  },
  wp: {
    about: "params {args: any WP-CLI command without the leading wp, e.g. \"post list\", \"option get blogname\", \"menu create Main\"}",
    script: (c) => {
      const args = splitArgs(p(c, "args").replace(/^\s*wp\s+/, ""));
      return args.length ? `${WP_FN}
WP ${args.map(shq).join(" ")}` : { error: "params.args: a WP-CLI command" };
    },
  },
  check: {
    about: "health check: site and admin respond through the link, WordPress version, site URL, recent PHP errors",
    readOnly: true,
    script: () => `${WP_FN}
LINK=$(cat "$HOME/.hosting/projects/$S.url" 2>/dev/null); [ -n "$LINK" ] || LINK="http://127.0.0.1:$PORT/"
echo "home page: $(curl -s -o /dev/null -m 20 -L -w '%{http_code} in %{time_total}s' "$LINK")"
echo "on the machine: $(curl -s -o /dev/null -m 10 -w '%{http_code}' -H "Host: $(printf %s "$SITE" | sed 's#^https*://##; s#/.*##')" "http://127.0.0.1:$PORT/")"
echo "installed: $(WP core is-installed 2>/dev/null && echo yes || echo no) · $(WP core version 2>/dev/null | sed 's/^/WordPress /')"
echo "site url: $(WP option get home 2>/dev/null)"
echo "active theme: $(WP theme list --status=active --field=name 2>/dev/null)"
echo "plugins: $(WP plugin list --status=active --field=name 2>/dev/null | tr '\n' ' ')"
echo "recent errors:"; docker logs --tail 200 "$C" 2>&1 | grep -iE 'php (fatal|warning|parse)|error' | tail -n 8 || true`,
  },
  backup: {
    about: "database export + uploads/themes/plugins to ~/data/backups",
    script: () => `${WP_FN}
mkdir -p ${BACKUPS}; WP db export - | gzip > ${BACKUPS}/"$S"-db-${stamp}.sql.gz && sudo tar czf ${BACKUPS}/"$S"-files-${stamp}.tgz -C "$HOME/data/$S" wp-content && ls -lh ${BACKUPS}/"$S"-* | tail -n 2`,
  },
  backups: POSTGRES.backups,
};

/* ---------- AI and developer tools ---------- */

const OLLAMA: Record<string, Action> = {
  models: { about: "installed models", readOnly: true, script: () => `docker exec "$C" ollama list` },
  pull: {
    about: "params {model} e.g. llama3.2:3b, qwen2.5:7b: downloads in the background; check with pull_status",
    script: (c) => need(c, "model") ?? `nohup docker exec "$C" ollama pull ${shq(p(c, "model"))} > "$HOME/.hosting/projects/$S.pull.log" 2>&1 & echo "downloading ${p(c, "model")} in the background; check with pull_status"`,
  },
  pull_status: { about: "progress of the last download", readOnly: true, script: () => `tail -c 600 "$HOME/.hosting/projects/$S.pull.log" 2>/dev/null | tr '\\r' '\\n' | tail -n 3; docker exec "$C" ollama list` },
  ask: {
    about: "params {prompt, model?}: one answer from a local model",
    readOnly: true,
    script: (c) =>
      p(c, "prompt")
        ? `M=${shq(p(c, "model"))}; [ -n "$M" ] || M="\${MODEL:-$(docker exec "$C" ollama list | awk 'NR==2{print $1}')}"; curl -sS -m 240 "http://127.0.0.1:$PORT/api/generate" -d "$(python3 -c 'import json,sys; print(json.dumps({"model": sys.argv[1], "prompt": sys.argv[2], "stream": False}))' "$M" ${shq(p(c, "prompt"))})" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("response") or d)'`
        : { error: "params.prompt is required" },
  },
  remove: { about: "params {model}", danger: true, script: (c) => need(c, "model") ?? `docker exec "$C" ollama rm ${shq(p(c, "model"))}` },
};

const CODE_SERVER: Record<string, Action> = {
  extensions: { about: "installed extensions", readOnly: true, script: () => `docker exec "$C" code-server --list-extensions` },
  install_extension: { about: "params {id} e.g. ms-python.python, esbenp.prettier-vscode", script: (c) => need(c, "id") ?? `docker exec "$C" code-server --install-extension ${shq(p(c, "id"))}` },
};

const PORTAINER: Record<string, Action> = {
  containers: { about: "containers on this machine (what Portainer shows)", readOnly: true, script: () => `docker ps -a --format 'table {{.Names}}\\t{{.Image}}\\t{{.Status}}'` },
};

/** Actions per catalog service id (on top of COMMON). n8n has its own tool. Admin UIs are for the user: use db_query for data. */
export const DRIVERS: Record<string, Record<string, Action>> = {
  wordpress: WORDPRESS,
  postgres: POSTGRES,
  mysql: MYSQL("mysql", "mysqldump"),
  mariadb: MYSQL("mariadb", "mariadb-dump"),
  mongodb: MONGO,
  redis: REDIS,
  minio: MINIO,
  "uptime-kuma": UPTIME,
  grafana: GRAFANA,
  metabase: METABASE,
  ollama: OLLAMA,
  "code-server": CODE_SERVER,
  portainer: PORTAINER,
};

/** How `api` signs in for services with a known admin login. */
export const API_AUTH: Record<string, string> = {
  grafana: `AUTH=(-u "admin:$GF_SECURITY_ADMIN_PASSWORD")`,
  metabase: mbSession,
};

export function actionsFor(id: string | null): Record<string, Action> {
  return { ...COMMON, ...(id ? DRIVERS[id] ?? {} : {}) };
}

/** One line per service for the tool description and the prompt. */
export function driverSummary(): string {
  return Object.entries(DRIVERS)
    .map(([id, acts]) => `${id}: ${Object.keys(acts).join(", ")}`)
    .join("; ");
}
