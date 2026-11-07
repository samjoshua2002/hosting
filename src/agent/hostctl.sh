#!/usr/bin/env bash
# hostctl: the per-VM agent for the hosting control plane.
# The dashboard installs this at ~/.hosting/bin/hostctl and replaces it whenever the version changes.
# Edit src/agent/hostctl.sh in the repo, not the copy on a VM.

AGENT_VERSION="__AGENT_VERSION__"
H="$HOME/.hosting"
P="$H/projects"
J="$H/jobs"
UNIT_DIR="$HOME/.config/systemd/user"
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"
export GIT_TERMINAL_PROMPT=0
mkdir -p "$P" "$J" "$HOME/apps"

die() { echo "error: $*" >&2; exit 1; }
valid_name() { [[ "$1" =~ ^[a-z0-9][a-z0-9-]{0,39}$ ]]; }
valid_id() { [[ "$1" =~ ^[a-z0-9-]{6,64}$ ]]; }
num() { if [[ "$1" =~ ^-?[0-9]+(\.[0-9]+)?$ ]]; then printf '%s' "$1"; else printf 0; fi; }

json_str() {
  local s
  s=$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr -d '\000-\037')
  printf '"%s"' "$s"
}

cpu_pct() {
  local a b c d e f g h t1 i1 t2 i2
  read -r _ a b c d e f g h _ < /proc/stat
  t1=$((a + b + c + d + e + f + g + h)); i1=$((d + e))
  sleep 0.3
  read -r _ a b c d e f g h _ < /proc/stat
  t2=$((a + b + c + d + e + f + g + h)); i2=$((d + e))
  if [ $((t2 - t1)) -gt 0 ]; then echo $((100 * ((t2 - t1) - (i2 - i1)) / (t2 - t1))); else echo 0; fi
}

# Sets JS_STATE (running|done|lost), JS_CODE, JS_ENDED for job $1.
job_state() {
  local id=$1 pid
  JS_CODE=null
  JS_ENDED=null
  if [ -f "$J/$id.exit" ]; then
    JS_STATE=done
    JS_CODE=$(tr -cd '0-9' < "$J/$id.exit" | head -c 5)
    [ -n "$JS_CODE" ] || JS_CODE=null
    JS_ENDED=$(stat -c %Y "$J/$id.exit" 2>/dev/null || echo null)
  else
    pid=$(cat "$J/$id.pid" 2>/dev/null)
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then JS_STATE=running; else JS_STATE=lost; fi
  fi
}

list_projects() {
  local first=1 f n active dep url
  for f in "$P"/*.json; do
    [ -e "$f" ] || continue
    n=$(basename "$f" .json)
    valid_name "$n" || continue
    active=$(systemctl --user is-active "hosting-$n.service" 2>/dev/null)
    [ -n "$active" ] || active=unknown
    dep=$(cat "$P/$n.deployed" 2>/dev/null)
    [[ "$dep" =~ ^[0-9]+$ ]] || dep=null
    [ $first -eq 1 ] || printf ','
    first=0
    printf '{"manifest":'
    cat "$f"
    url=null
    [ -s "$P/$n.url" ] && url=$(json_str "$(head -c 400 "$P/$n.url")")
    printf ',"active":%s,"deployedAt":%s,"url":%s}' "$(json_str "$active")" "$dep" "$url"
  done
}

list_jobs() {
  local first=1 f id
  for f in $(ls -1t "$J"/*.json 2>/dev/null | head -n 15); do
    id=$(basename "$f" .json)
    valid_id "$id" || continue
    job_state "$id"
    [ $first -eq 1 ] || printf ','
    first=0
    printf '{"id":"%s","meta":' "$id"
    cat "$f"
    printf ',"state":"%s","exitCode":%s,"endedAt":%s}' "$JS_STATE" "$JS_CODE" "$JS_ENDED"
  done
}

# Tunnels to a database machine (hosting-tunnel-<vm>.service, written by the dashboard)
list_tunnels() {
  local first=1 f n
  for f in "$UNIT_DIR"/hosting-tunnel-*.service; do
    [ -e "$f" ] || continue
    n=$(basename "$f" .service)
    n=${n#hosting-tunnel-}
    valid_name "$n" || continue
    [ $first -eq 1 ] || printf ','
    first=0
    printf '{"to":"%s","active":%s,"ports":[%s]}' "$n" "$(json_str "$(systemctl --user is-active "hosting-tunnel-$n.service" 2>/dev/null)")" \
      "$(grep -o '127\.0\.0\.1:[0-9]*:127' "$f" | cut -d: -f2 | paste -sd, -)"
  done
}

# ---------- scheduled tasks (cron) ----------
# Named tasks are two crontab lines: "# hosting:<name>" then the entry, which runs ~/.hosting/cron/<name>.sh
# and appends to <name>.log. Entries added by hand (no marker) are listed too, with an empty name.
CRON_DIR="$H/cron"

cron_ensure() {
  command -v crontab >/dev/null 2>&1 && return 0
  sudo -n apt-get update -qq >/dev/null 2>&1
  sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq cron >/dev/null 2>&1
  sudo -n systemctl enable --now cron >/dev/null 2>&1
  command -v crontab >/dev/null 2>&1
}

list_cron() {
  command -v crontab >/dev/null 2>&1 || return 0
  crontab -l 2>/dev/null | awk -v d="$CRON_DIR" '
    function esc(x) { gsub(/\\/, "\\\\", x); gsub(/"/, "\\\"", x); gsub(/\t/, " ", x); return x }
    /^# hosting:/ { name = substr($0, 11); next }
    /^[[:space:]]*(#|$)/ { next }
    /^[A-Za-z_][A-Za-z0-9_]*=/ { next }
    {
      line = $0
      if ($1 ~ /^@/) { sched = $1; sub(/^[[:space:]]*[^[:space:]]+[[:space:]]+/, "", line) }
      else { sched = $1 " " $2 " " $3 " " $4 " " $5; for (i = 0; i < 5; i++) sub(/^[[:space:]]*[^[:space:]]+[[:space:]]+/, "", line) }
      if (name != "") {
        # named task: show the command the user scheduled, not the wrapper
        f = d "/" name ".cmd"; body = ""
        while ((getline l < f) > 0) body = body (body == "" ? "" : "; ") l
        close(f)
        if (body != "") line = body
      }
      printf "%s{\"name\":\"%s\",\"schedule\":\"%s\",\"command\":\"%s\"}", (n++ ? "," : ""), esc(name), esc(sched), esc(substr(line, 1, 400))
      name = ""
    }'
}

cron_without() { crontab -l 2>/dev/null | awk -v m="# hosting:$1" '$0 == m { skip = 1; next } skip { skip = 0; next } { print }'; }

cmd_cron() {
  local act=$1 n=$2 sched=$3 tmp body
  case "$act" in
    list) printf '['; list_cron; printf ']\n'; return ;;
  esac
  valid_name "$n" || die "invalid task name (lowercase letters, digits, dashes)"
  case "$act" in
    add)
      cron_ensure || die "cron is not available and could not be installed"
      [[ "$sched" =~ ^(@(reboot|hourly|daily|weekly|monthly|yearly|annually|midnight)|[0-9*/,-]+[[:space:]]+[0-9*/,-]+[[:space:]]+[0-9*/,?LW-]+[[:space:]]+[0-9A-Za-z*/,-]+[[:space:]]+[0-9A-Za-z*/,?L#-]+)$ ]] || die "schedule must be 5 cron fields (e.g. */20 * * * *) or @hourly/@daily"
      mkdir -p "$CRON_DIR"
      body=$(cat)
      [ -n "$body" ] || die "empty command"
      printf '%s\n' "$body" > "$CRON_DIR/$n.cmd"
      { echo '#!/usr/bin/env bash'; echo 'export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"'; echo 'cd "$HOME" || exit 1'; echo 'echo "---- $(date -u +%Y-%m-%dT%H:%M:%SZ) ----"'; printf '%s\n' "$body"; } > "$CRON_DIR/$n.sh"
      chmod 700 "$CRON_DIR/$n.sh"
      tmp=$(mktemp)
      { cron_without "$n"; echo "# hosting:$n"; echo "$sched /bin/bash $CRON_DIR/$n.sh >> $CRON_DIR/$n.log 2>&1"; } > "$tmp"
      crontab "$tmp" && rm -f "$tmp" && echo "scheduled $n: $sched"
      ;;
    remove)
      tmp=$(mktemp)
      cron_without "$n" > "$tmp"
      crontab "$tmp" && rm -f "$tmp" "$CRON_DIR/$n.sh" "$CRON_DIR/$n.cmd" && echo "removed $n"
      ;;
    run)
      [ -f "$CRON_DIR/$n.sh" ] || die "no task $n"
      bash "$CRON_DIR/$n.sh" >> "$CRON_DIR/$n.log" 2>&1
      echo "exit $?"
      tail -n 20 "$CRON_DIR/$n.log"
      ;;
    logs) if [ -f "$CRON_DIR/$n.log" ]; then tail -n 200 "$CRON_DIR/$n.log"; else echo "(no runs yet)"; fi ;;
    *) die "unknown cron action: $act" ;;
  esac
}

list_ports() {
  local out=""
  if command -v instabox-port >/dev/null 2>&1; then
    out=$(timeout 5 instabox-port list 2>/dev/null)
  fi
  if [ "${out:0:1}" = "{" ]; then printf '%s' "$out"; else printf 'null'; fi
}

# Metrics history: one line per status call (at most one per 10s), so charts fill in while
# someone is looking. Nothing runs in the background, so idle VMs can still pause.
# Columns: ts cpu% memUsedKb diskUsedKb load1 netRxBytes netTxBytes
record_sample() {
  local f="$H/metrics.log" now last
  now=$(date +%s)
  last=$(tail -n 1 "$f" 2>/dev/null | cut -d' ' -f1)
  [[ "$last" =~ ^[0-9]+$ ]] || last=0
  if [ $((now - last)) -ge 10 ]; then
    echo "$now $1 $2 $3 $4 $5 $6" >> "$f"
  fi
  if [ "$(wc -l < "$f")" -gt 3000 ]; then
    tail -n 2000 "$f" > "$f.tmp" && mv -f "$f.tmp" "$f"
  fi
}

# Samples newer than $1 (unix seconds), newest 720 at most.
history_json() {
  local since=$1
  [[ "$since" =~ ^[0-9]+$ ]] || since=0
  if [ ! -f "$H/metrics.log" ]; then printf '[]'; return; fi
  awk -v s="$since" '$1 > s && NF == 7' "$H/metrics.log" | tail -n 720 |
    awk 'BEGIN { printf "[" } { if (n++) printf ","; printf "[%s,%s,%s,%s,%s,%s,%s]", $1, $2, $3, $4, $5, $6, $7 } END { printf "]" }'
}

cmd_status() {
  local cores memt mema l1 l5 l15 up dt du dk cpu os rx tx
  cores=$(nproc 2>/dev/null || echo 1)
  memt=$(awk '/^MemTotal:/{print $2}' /proc/meminfo)
  mema=$(awk '/^MemAvailable:/{print $2}' /proc/meminfo)
  read -r l1 l5 l15 _ < /proc/loadavg
  up=$(cut -d. -f1 /proc/uptime)
  read -r dt du < <(df -Pk "$HOME" | awk 'NR==2{print $2, $3}')
  read -r rx tx < <(awk 'NR > 2 { sub(/^ +/, ""); split($0, a, /[: ]+/); if (a[1] != "lo") { rx += a[2]; tx += a[10] } } END { printf "%.0f %.0f\n", rx, tx }' /proc/net/dev)
  dk=false
  timeout 3 docker info >/dev/null 2>&1 && dk=true
  cpu=$(cpu_pct)
  os=$(. /etc/os-release 2>/dev/null; echo "$PRETTY_NAME")
  cores=$(num "$cores"); memt=$(num "$memt"); mema=$(num "$mema"); cpu=$(num "$cpu")
  dt=$(num "$dt"); du=$(num "$du"); l1=$(num "$l1"); rx=$(num "$rx"); tx=$(num "$tx")
  record_sample "$cpu" "$((memt - mema))" "$du" "$l1" "$rx" "$tx"
  printf '{"v":%s,"hostname":%s,"os":%s,"cores":%s,"memTotalKb":%s,"memAvailKb":%s,"load":[%s,%s,%s],"cpuPct":%s,"uptimeSec":%s,"diskTotalKb":%s,"diskUsedKb":%s,"netRx":%s,"netTx":%s,"docker":%s,' \
    "$(json_str "$AGENT_VERSION")" "$(json_str "$(hostname)")" "$(json_str "$os")" \
    "$cores" "$memt" "$mema" "$l1" "$(num "$l5")" "$(num "$l15")" "$cpu" "$(num "$up")" \
    "$dt" "$du" "$rx" "$tx" "$dk"
  printf '"projects":['
  list_projects
  printf '],"jobs":['
  list_jobs
  printf '],"cron":['
  list_cron
  printf '],"tunnels":['
  list_tunnels
  printf '],"ports":'
  list_ports
  printf ',"history":'
  history_json "$1"
  printf '}\n'
}

prune_jobs() {
  local f id
  ls -1t "$J"/*.json 2>/dev/null | tail -n +41 | while read -r f; do
    id=$(basename "$f" .json)
    job_state "$id"
    [ "$JS_STATE" = running ] || rm -f "$J/$id".*
  done
}

# job-start <id> <base64 meta json>; the job's bash script arrives on stdin.
cmd_job_start() {
  local id=$1 meta=$2 i
  valid_id "$id" || die "invalid job id"
  [ -e "$J/$id.json" ] && die "job $id already exists"
  cat > "$J/$id.sh"
  printf '%s' "$meta" | base64 -d > "$J/$id.json" 2>/dev/null || echo '{}' > "$J/$id.json"
  [ -s "$J/$id.json" ] || echo '{}' > "$J/$id.json"
  : > "$J/$id.log"
  cat > "$J/$id.run" <<EOF
#!/usr/bin/env bash
echo \$\$ > "$J/$id.pid"
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:\$PATH"
export GIT_TERMINAL_PROMPT=0
cd "\$HOME" || exit 1
bash "$J/$id.sh" >> "$J/$id.log" 2>&1 < /dev/null
echo \$? > "$J/$id.exit"
EOF
  if ! systemd-run --user --quiet --collect --unit "hosting-job-$id" bash "$J/$id.run" >/dev/null 2>&1; then
    nohup setsid bash "$J/$id.run" >/dev/null 2>&1 < /dev/null &
  fi
  for i in 1 2 3 4 5 6 7 8 9 10; do
    [ -s "$J/$id.pid" ] && break
    sleep 0.2
  done
  prune_jobs
  printf '{"id":"%s"}\n' "$id"
}

cmd_job_log() {
  local id=$1 n=${2:-65536}
  valid_id "$id" || die "invalid job id"
  [ -e "$J/$id.json" ] || die "no such job"
  [[ "$n" =~ ^[0-9]+$ ]] || n=65536
  job_state "$id"
  printf '__JOB__ %s %s\n' "$JS_STATE" "$JS_CODE"
  tail -c "$n" "$J/$id.log" 2>/dev/null
}

cmd_job_kill() {
  local id=$1 pid
  valid_id "$id" || die "invalid job id"
  systemctl --user stop "hosting-job-$id" >/dev/null 2>&1
  pid=$(cat "$J/$id.pid" 2>/dev/null)
  if [ -n "$pid" ]; then
    kill -TERM -- "-$pid" 2>/dev/null
    kill -TERM "$pid" 2>/dev/null
  fi
  [ -f "$J/$id.exit" ] || echo 143 > "$J/$id.exit"
  echo "stopped $id"
}

write_unit() {
  local n=$1
  mkdir -p "$UNIT_DIR"
  cat > "$P/$n.start.sh" <<EOF
#!/usr/bin/env bash
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:\$PATH"
cd "$HOME/apps/$n" || exit 1
. "$P/$n.conf"
[ -s "$P/$n.start-cmd" ] && START=\$(cat "$P/$n.start-cmd")
set -a
[ -f "$P/$n.env" ] && . "$P/$n.env"
set +a
[ -n "\$PORT" ] && export PORT
log="$P/$n.log"
if [ -f "\$log" ] && [ "\$(stat -c %s "\$log")" -gt 5242880 ]; then mv -f "\$log" "\$log.1"; fi
echo "---- start \$(date -u +%Y-%m-%dT%H:%M:%SZ) ----" >> "\$log"
exec bash -c "\$START" >> "\$log" 2>&1
EOF
  cat > "$UNIT_DIR/hosting-$n.service" <<EOF
[Unit]
Description=hosting project $n
After=network-online.target

[Service]
Type=simple
ExecStart=/bin/bash $P/$n.start.sh
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF
}

cmd_deploy() {
  local n=$1 dir state out flag link REPO="" BRANCH="main" INSTALL="" BUILD="" START="" PORT="" PUBLISH=0 ACCESS=public
  valid_name "$n" || die "invalid project name"
  [ -f "$P/$n.conf" ] || die "project $n is not configured on this VM"
  . "$P/$n.conf"
  dir="$HOME/apps/$n"
  echo "==> deploying $n on $(hostname) at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if [ -n "$REPO" ]; then
    if [ -d "$dir/.git" ]; then
      echo "==> git fetch origin $BRANCH"
      git -C "$dir" fetch --depth 1 origin "$BRANCH" && git -C "$dir" reset --hard FETCH_HEAD || die "git update failed"
    else
      echo "==> git clone $REPO ($BRANCH)"
      rm -rf "$dir"
      git clone --depth 1 --branch "$BRANCH" "$REPO" "$dir" || die "git clone failed"
    fi
  else
    mkdir -p "$dir"
  fi
  cd "$dir" || die "cannot enter $dir"
  set -a
  [ -f "$P/$n.env" ] && . "$P/$n.env"
  set +a
  [ -n "$PORT" ] && export PORT
  if [ -n "$INSTALL" ]; then
    echo "==> $INSTALL"
    bash -c "$INSTALL" || die "install step failed"
  fi
  if [ -n "$BUILD" ]; then
    echo "==> $BUILD"
    bash -c "$BUILD" || die "build step failed"
  fi
  # Next.js static export (output: 'export') can't run "next start": serve the exported ./out folder instead
  rm -f "$P/$n.start-cmd"
  if printf '%s' "$START" | grep -q "next start\|npm run start\|npm start" && [ -d out ] &&
    grep -qsE "output[\"']?[[:space:]]*:[[:space:]]*[\"']export[\"']" next.config.* 2>/dev/null; then
    echo "==> static export detected (output: 'export'): serving ./out"
    printf '%s' 'exec npx --yes serve -s out -l "$PORT"' > "$P/$n.start-cmd"
  fi
  if [ -n "$START" ]; then
    write_unit "$n"
    systemctl --user daemon-reload
    systemctl --user enable "hosting-$n.service" >/dev/null 2>&1
    echo "==> (re)starting service hosting-$n"
    systemctl --user restart "hosting-$n.service" || die "service failed to start"
    sleep 3
    state=$(systemctl --user is-active "hosting-$n.service")
    echo "    service is $state"
    if [ "$state" != active ]; then
      tail -n 30 "$P/$n.log" 2>/dev/null
      die "service is not running"
    fi
  fi
  date +%s > "$P/$n.deployed"
  if [ "$PUBLISH" = 1 ] && [ -n "$PORT" ] && command -v instabox-port >/dev/null 2>&1; then
    flag=--public
    [ "$ACCESS" = private ] && flag=--private
    echo "==> publishing port $PORT ($ACCESS link)"
    out=$(instabox-port publish "$PORT" --name "$n" $flag --json 2>&1)
    # private links come back as tokenUrl (the URL with its ?_token=); keep that one, readable only by us
    link=$(printf '%s\n' "$out" | sed -n 's/.*"tokenUrl": *"\([^"]*\)".*/\1/p' | head -n 1)
    [ -n "$link" ] || link=$(printf '%s\n' "$out" | sed -n 's/.*"url": *"\([^"]*\)".*/\1/p' | head -n 1)
    if [ -n "$link" ]; then
      (umask 077; printf '%s' "$link" > "$P/$n.url")
      echo "    ${link%%\?*}"
    else
      echo "$out" | tail -n 3
    fi
  elif [ -n "$PORT" ] && command -v instabox-port >/dev/null 2>&1 && [ -f "$P/$n.url" ]; then
    instabox-port unpublish "$PORT" >/dev/null 2>&1
    rm -f "$P/$n.url"
    echo "==> link removed"
  fi
  echo "==> done"
}

cmd_project() {
  local act=$1 n=$2 lines=${3:-200} PORT=""
  valid_name "$n" || die "invalid project name"
  [[ "$lines" =~ ^[0-9]+$ ]] || lines=200
  case "$act" in
    start | stop | restart)
      systemctl --user "$act" "hosting-$n.service" || die "$act failed"
      echo "hosting-$n: $(systemctl --user is-active "hosting-$n.service")"
      ;;
    logs)
      if [ -f "$P/$n.log" ]; then tail -n "$lines" "$P/$n.log"; else echo "(no logs yet)"; fi
      ;;
    env)
      [ -f "$P/$n.env" ] && cat "$P/$n.env"
      true
      ;;
    remove)
      systemctl --user disable --now "hosting-$n.service" >/dev/null 2>&1
      rm -f "$UNIT_DIR/hosting-$n.service"
      systemctl --user daemon-reload
      [ -f "$P/$n.conf" ] && . "$P/$n.conf"
      if [ -n "$PORT" ] && command -v instabox-port >/dev/null 2>&1; then
        instabox-port unpublish "$PORT" >/dev/null 2>&1
      fi
      rm -rf "${HOME:?}/apps/$n"
      rm -f "$P/$n".*
      echo "removed $n"
      ;;
    *) die "unknown action: $act" ;;
  esac
}

case "$1" in
  version) echo "$AGENT_VERSION" ;;
  status) cmd_status "$2" ;;
  job-start) shift; cmd_job_start "$@" ;;
  job-log) shift; cmd_job_log "$@" ;;
  job-kill) shift; cmd_job_kill "$@" ;;
  deploy) shift; cmd_deploy "$@" ;;
  project) shift; cmd_project "$@" ;;
  cron) shift; cmd_cron "$@" ;;
  *)
    echo "usage: hostctl {version|status|job-start|job-log|job-kill|deploy|project}" >&2
    exit 2
    ;;
esac
