# Learning Nginx

Study notes for learning nginx, built around one working example: using nginx
as a **reverse proxy and load balancer** in front of three identical Node.js
apps.

Nginx is installed system-wide, so its config lives at `/etc/nginx/nginx.conf`
and is **not** tracked by this repo. Its contents are copied below, with
explanations, so the setup is preserved and understood.

---

## How the pieces fit together

The repo runs three copies of the same Express app via
[docker-compose.yaml](docker-compose.yaml). Each container listens on port
`3000` internally, but they're published to different **host** ports:

| Service | `APP_NAME` | Host port → container port |
| --- | --- | --- |
| `app1` | `App1` | `3001` → `3000` |
| `app2` | `App2` | `3002` → `3000` |
| `app3` | `App3` | `3003` → `3000` |

[server.js](server.js) responds with `<h1>Hello, ${App_Name}!</h1>`, so each
instance identifies itself — which is what makes the load balancing visible.

Nginx sits in front on port `8080` and spreads incoming requests across all
three:

```
                                    ┌──────────────────────┐
                                    │  app1  :3001 → :3000 │
                                    └──────────────────────┘
                                    ┌──────────────────────┐
browser ──▶ nginx :8080 ──▶ ────────│  app2  :3002 → :3000 │
              (upstream             └──────────────────────┘
               nodejs_cluster)      ┌──────────────────────┐
                                    │  app3  :3003 → :3000 │
                                    └──────────────────────┘
```

The client only ever talks to port `8080`. It never knows there are three
backends, how many there are, or which one served its request.

---

## `/etc/nginx/nginx.conf`

```nginx
worker_processes 1;

events {
    worker_connections 1024;
}

http {
    include mime.types;

    upstream nodejs_cluster {
        least_conn;
        server 127.0.0.1:3001;
        server 127.0.0.1:3002;
        server 127.0.0.1:3003;
    }

    server {
        listen 8080;
        server_name localhost;

        location / {
            proxy_pass http://nodejs_cluster;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
        }
    }
}
```

This replaces the stock config that ships with nginx — it's deliberately
minimal, so everything in it is there for a reason.

---

## A note on contexts

Nginx config is a nesting of **contexts** (blocks). Reading the file above gets
much easier once this hierarchy is in your head:

```
main (the file itself, no braces)
├── events { }              # connection handling
└── http { }                # everything HTTP
    ├── upstream { }        # a named pool of backend servers
    └── server { }          # one virtual host
        └── location { }    # one URL path pattern
```

Directives are only valid in certain contexts, and inner contexts **inherit**
from outer ones. Note that `upstream` is a *sibling* of `server`, not a child —
it defines a reusable backend pool at the `http` level that any `server` or
`location` can point at.

---

## Global context

| Directive | Value | Meaning |
| --- | --- | --- |
| `worker_processes` | `1` | Spawn a single worker process to handle requests. (The master process only supervises.) `1` is fine for learning and keeps behaviour easy to reason about; production configs use `auto`, which means one worker per CPU core. |

### What's *not* here

The stock config also sets `user`, `error_log`, and `pid`. Omitting them isn't
an error — nginx falls back to the values compiled into your build:

```bash
# See every compiled-in default path and option
nginx -V
```

On Debian/Ubuntu and Alpine packages that means the logs still land in
`/var/log/nginx/`. Note that with no `user` directive, workers run as the
default user compiled in (usually `nobody`), which can cause permission
surprises when serving files from disk — not an issue here, since we only
proxy.

---

## `events` block

Controls how nginx accepts connections.

| Directive | Value | Meaning |
| --- | --- | --- |
| `worker_connections` | `1024` | Maximum simultaneous connections **per worker**. |

The ceiling for the whole server is `worker_processes × worker_connections` —
here `1 × 1024 = 1024`. Important caveat for a reverse proxy: each client
request consumes **two** connections from that budget (client → nginx, and
nginx → backend), so the real client limit is closer to `512`. This value is
also capped by the OS file-descriptor limit (`ulimit -n`).

---

## `http` block

### `include mime.types;`

Pulls in nginx's lookup table mapping file extensions to `Content-Type` values
(`.html` → `text/html`, `.css` → `text/css`, `.png` → `image/png`, …).

The path is **relative**, and nginx resolves relative paths against its prefix
directory — normally `/etc/nginx` — so this loads `/etc/nginx/mime.types`. The
stock config writes it out in full as `/etc/nginx/mime.types`; both work.

It has little effect in this config, since responses come from the Node apps
with their own `Content-Type` headers already set, and nginx passes those
through. It matters as soon as you serve a static file directly.

### `upstream nodejs_cluster { … }`

This is the load balancer. An `upstream` block declares a **named pool of
backend servers** that can then be referenced by name anywhere in the config.

```nginx
upstream nodejs_cluster {
    least_conn;
    server 127.0.0.1:3001;
    server 127.0.0.1:3002;
    server 127.0.0.1:3003;
}
```

| Part | Meaning |
| --- | --- |
| `nodejs_cluster` | Arbitrary name for the pool. It becomes a pseudo-hostname usable in `proxy_pass http://nodejs_cluster`. |
| `least_conn;` | The balancing **method** — send each request to whichever backend currently has the fewest active connections. |
| `server 127.0.0.1:3001;` | One backend. Repeated per instance. These are the *host* ports from `docker-compose.yaml`, not the container's internal `3000`. |

#### Balancing methods

`least_conn` is one of several. The method directive goes at the top of the
`upstream` block:

| Method | Behaviour |
| --- | --- |
| *(none)* | **Round-robin** — the default. Requests cycle through backends in order. Simple and even, but blind to how busy each backend is. |
| `least_conn` | Fewest active connections wins. Better when request durations vary a lot, since a backend stuck on a slow request stops receiving new ones. **This is what we use.** |
| `ip_hash` | The client's IP is hashed to pick a backend, so a given client always lands on the same one. Used for *sticky sessions* when state is held in server memory. |
| `random` | Pick at random. `random two least_conn` picks two at random and sends to the less busy of them — cheap approximation of `least_conn` that scales better. |

#### Per-server options worth knowing

Not used in this config, but these are the ones you'll reach for next:

```nginx
upstream nodejs_cluster {
    least_conn;
    server 127.0.0.1:3001 weight=3;              # gets ~3x the traffic
    server 127.0.0.1:3002 max_fails=2 fail_timeout=30s;
    server 127.0.0.1:3003 backup;                # only used if others are down
}
```

Even without these, nginx does **passive health checking** by default: if a
backend refuses a connection or errors out, nginx marks it unavailable
(`max_fails=1`, `fail_timeout=10s` by default) and retries the request against
another backend. Stop one container and traffic keeps flowing — that's this
mechanism, not something you configured.

> **Gotcha — `127.0.0.1` is relative to wherever nginx runs.** This works
> because nginx runs on the *host*, where Compose has published ports
> 3001–3003. If you later move nginx into a container, `127.0.0.1` becomes that
> container itself and every backend goes unreachable. Inside Compose you'd
> instead use the service names and internal port: `server app1:3000;`.

### `server { … }`

A `server` block is one **virtual host**.

| Directive | Value | Meaning |
| --- | --- | --- |
| `listen` | `8080` | Accept HTTP connections on TCP port 8080. Port 8080 rather than 80 means no root privileges are needed to bind it, and it stays clear of anything already on 80. |
| `server_name` | `localhost` | Handle requests whose `Host` header is `localhost`. As the only server block on this port it's also the **default server**, so it catches everything arriving on 8080 regardless of `Host`. |

### `location / { … }`

`location /` is a **prefix match**, and since `/` prefixes every path, this is
the catch-all — every request to port 8080 lands here and gets proxied.

```nginx
location / {
    proxy_pass http://nodejs_cluster;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}
```

#### `proxy_pass http://nodejs_cluster;`

Forward the request to the `nodejs_cluster` upstream. Nginx opens its own
connection to the chosen backend, relays the request, and streams the response
back to the client. The `http://` scheme is required; the hostname resolves to
the `upstream` block rather than to DNS.

#### Why the `proxy_set_header` lines exist

This is the part worth actually understanding. When nginx proxies a request it
builds a **new** request to send to the backend, and by default the backend
loses all knowledge of the original client. Two headers get set back:

| Header | Value | Why it matters |
| --- | --- | --- |
| `Host` | `$host` | The hostname the *client* asked for. Without this, nginx sends `Host: nodejs_cluster` — the upstream's internal name. Anything the backend derives from `Host` (absolute URL generation, redirects, multi-tenant routing, cookie domains) would then be wrong. |
| `X-Real-IP` | `$remote_addr` | The client's IP address. Without it, every request appears to originate from nginx, so backend logging, rate limiting, and geo-lookup all see one IP. `X-Real-IP` isn't a standard header — it's a convention — so the backend has to opt into reading it. |

`$host` and `$remote_addr` are nginx variables evaluated per request.

#### Headers you'd typically add next

```nginx
proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
```

- `X-Forwarded-For` is the *standard* version of `X-Real-IP`, and
  `$proxy_add_x_forwarded_for` **appends** to any existing value rather than
  replacing it — so with proxies chained you get the full path, not just the
  last hop. Frameworks like Express (`app.set('trust proxy', true)`) read this
  one automatically.
- `X-Forwarded-Proto` tells the backend whether the *client* used `http` or
  `https`. Once TLS terminates at nginx, the backend only sees plain HTTP and
  will build `http://` redirects without this.

Treat both as untrusted input on requests from the open internet — a client can
send whatever `X-Forwarded-For` it likes, and only the hop your own proxy
appended is trustworthy.

### What's *not* in the `http` block

Worth knowing, because their absence changes behaviour:

| Omitted | Consequence |
| --- | --- |
| `log_format` + `access_log` | Requests are logged in nginx's built-in `combined` format instead of a custom one. Add a `log_format` if you want to record proxy-specific fields like `$upstream_addr` — very useful for confirming *which* backend served a request. |
| `include conf.d/*.conf;` | The stock config ends with this line, which is what loads `/etc/nginx/conf.d/default.conf` — the default site on port 80. **Dropping it means that file is no longer read at all**, so there is nothing listening on port 80 any more. Intentional here; just don't be surprised when edits to `default.conf` have no effect. |
| `sendfile` / `gzip` / `keepalive_timeout` | Fall back to defaults (`sendfile off`, no compression, 75s keepalive). `sendfile` is a static-file optimisation, so it's irrelevant while we only proxy. |

---

## Running it end to end

```bash
# 1. Start the three backends
docker compose up -d
docker compose ps                  # confirm all three are up

# 2. Check the backends directly — each should name itself
curl -s localhost:3001             # <h1>Hello, App1!</h1>
curl -s localhost:3002             # <h1>Hello, App2!</h1>
curl -s localhost:3003             # <h1>Hello, App3!</h1>

# 3. Validate the nginx config BEFORE applying it
sudo nginx -t

# 4. Apply it with zero downtime
sudo nginx -s reload

# 5. Watch the load balancing — the app name should change between requests
for i in (seq 12); curl -s localhost:8080; end
```

> The loop above is **fish** syntax, matching this shell. In bash/zsh:
> `for i in {1..12}; do curl -s localhost:8080; done`

With `least_conn` and three idle backends, distribution is roughly even but
**not** a strict `App1, App2, App3` cycle — nginx picks by current connection
count, and sequential `curl`s each finish before the next starts. Switch to
round-robin (delete the `least_conn` line) if you want to see a clean rotation.

### Watching failover

```bash
docker compose stop app2
for i in (seq 12); curl -s localhost:8080; end   # App2 disappears, no errors
docker compose start app2                        # it rejoins on its own
```

Requests keep succeeding because of the passive health checking described
above. Check `error.log` and you'll see the connection failures nginx absorbed
on your behalf.

---

## Useful commands

```bash
# Validate config syntax without applying it — always do this before reloading
sudo nginx -t

# Apply config changes gracefully (old workers finish in-flight requests)
sudo nginx -s reload
sudo systemctl reload nginx      # equivalent, via systemd

# Service state
sudo systemctl status nginx
sudo systemctl start nginx
sudo systemctl stop nginx
sudo systemctl restart nginx     # full restart; drops connections, prefer reload

# Dump the fully-resolved config, with every include expanded inline
sudo nginx -T

# Compiled-in defaults: config path, log paths, modules
nginx -V
```

Run `nginx -t` first: `nginx -s reload` also refuses to apply a broken config,
but `-t` is what tells you *what* is broken and on which line.

### Logs

| Path | Contents |
| --- | --- |
| `/var/log/nginx/access.log` | One line per request (built-in `combined` format) |
| `/var/log/nginx/error.log` | Startup problems, config errors, upstream failures |

```bash
sudo tail -f /var/log/nginx/access.log
sudo tail -f /var/log/nginx/error.log
```

Upstream problems — a backend refusing connections, timing out, or returning
garbage — show up in **`error.log`**, not `access.log`. That's the first place
to look when port 8080 starts returning `502 Bad Gateway`.

### Common failure modes

| Symptom | Likely cause |
| --- | --- |
| `502 Bad Gateway` | No backend reachable. Are the containers up? Is `127.0.0.1` correct for where nginx runs? |
| `504 Gateway Timeout` | A backend accepted the connection but didn't respond in time (`proxy_read_timeout`, 60s default). |
| `nginx: [emerg] bind() to 0.0.0.0:8080 failed` | Something else already holds port 8080 — `sudo ss -ltnp \| grep 8080`. |
| Edits to `default.conf` do nothing | Expected — `include conf.d/*.conf;` isn't in this config. |