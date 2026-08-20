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

## Creating a self-signed certificate (for HTTPS)

Everything above runs over plain HTTP. To serve HTTPS instead, nginx needs two
files:

- a **private key** — a secret number, kept on the server and never shared
- a **certificate** — a public file that wraps your key's public half together
  with your identity ("this is localhost"), plus a signature vouching for it

Normally a **Certificate Authority** (a company like Let's Encrypt) signs that
certificate, and browsers trust it because they already trust the CA. For local
learning there's no CA involved — you sign it yourself. That's what
**self-signed** means.

### Step 1 — Make a directory to keep them in

```bash
sudo mkdir -p /etc/nginx/ssl
cd /etc/nginx/ssl
```

**Why here, and not inside this repo?** The private key is a secret. This
project's `.gitignore` only ignores `node_modules/`, so a key file saved in the
project folder would be picked up by the next `git add .` and committed —
possibly pushed to GitHub. Putting it in `/etc/nginx/ssl` keeps it out of git's
reach completely, and sits it right next to the config that reads it.

If you ever do keep keys inside a project, add this to `.gitignore` first:

```gitignore
*.key
*.crt
*.pem
```

### Step 2 — Run the command

Open a terminal and paste this:

```bash
sudo openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout nginx-selfsigned.key \
  -out nginx-selfsigned.crt
```

The `\` at the end of a line means "this command continues on the next line" —
it's only there for readability. As a single line:

```bash
sudo openssl req -x509 -nodes -days 365 -newkey rsa:2048 -keyout nginx-selfsigned.key -out nginx-selfsigned.crt
```

`sudo` is needed because `/etc/nginx/ssl` is owned by root. Watch the spelling
of the output filenames — `nginx`, not `nginxx`. OpenSSL will happily create a
file with a typo'd name, and then nginx won't find it later.

### Step 3 — What each part means

| Part | What it does |
| --- | --- |
| `openssl` | The tool itself. A general-purpose toolbox for keys, certificates, and encryption. |
| `req` | The sub-command for certificate requests. Normally it produces a *request* to send to a CA — `-x509` below changes that. |
| `-x509` | Skip the request and output a finished, **self-signed certificate** instead. X.509 is the standard format all TLS certificates use. Without this flag you'd get a `.csr` request file that isn't usable on its own. |
| `-nodes` | **No** **D**ES — don't put a passphrase on the private key. Important for a server: with a passphrase, nginx would stop and ask you to type it every single time it starts, so it could never boot unattended. In OpenSSL 3 this is also spelled `-noenc`; `-nodes` still works. |
| `-days 365` | How long the certificate is valid — one year from today. After that browsers and `curl` report it as expired and you generate a new one. |
| `-newkey rsa:2048` | Create a brand-new private key at the same time, using RSA at 2048 bits. Without this you'd have to make the key separately first. 2048 is the sensible minimum; 4096 is slower but stronger. |
| `-keyout nginx-selfsigned.key` | Where to write the **private key**. Keep secret. |
| `-out nginx-selfsigned.crt` | Where to write the **certificate**. This one is public — it's sent to every visitor. |

The `.key` / `.crt` extensions are just naming convention. OpenSSL doesn't care;
pick names you'll recognise later.

### Step 4 — The questions it asks

After you press Enter, OpenSSL asks for identity details. Every one is optional
except the last:

```
Country Name (2 letter code) [AU]:BD
State or Province Name (full name) [Some-State]:Dhaka
Locality Name (eg, city) []:Dhaka
Organization Name (eg, company) [Internet Widgits Pty Ltd]:Learning
Organizational Unit Name (eg, section) []:
Common Name (e.g. server FQDN or YOUR name) []:localhost
Email Address []:
```

**Common Name is the one that matters.** It's the hostname the certificate
claims to be for, and it must match the address you type in the browser. Since
you're testing on `localhost`, enter `localhost`. Press Enter to skip any of the
others.

To skip the questions entirely, pass the answers on the command line with
`-subj`:

```bash
sudo openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout nginx-selfsigned.key \
  -out nginx-selfsigned.crt \
  -subj "/C=BD/ST=Dhaka/L=Dhaka/O=Learning/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
```

That `-addext` line is worth knowing about: modern browsers **ignore Common
Name** and read the *Subject Alternative Name* field instead. A certificate with
only a CN will fail in Chrome with `ERR_CERT_COMMON_NAME_INVALID` even when the
name is correct. `curl` is more forgiving, which is why a cert can look fine in
the terminal and still be rejected by the browser.

### Step 5 — What you end up with

```bash
ls -l /etc/nginx/ssl
```

| File | Contains | Share it? |
| --- | --- | --- |
| `nginx-selfsigned.key` | The private key | **Never.** Anyone holding this can impersonate your server. |
| `nginx-selfsigned.crt` | The certificate | Yes — it's handed to every visitor automatically. |

Lock the key down so only root can read it:

```bash
sudo chmod 600 /etc/nginx/ssl/nginx-selfsigned.key
```

Check what you actually generated:

```bash
openssl x509 -in /etc/nginx/ssl/nginx-selfsigned.crt -noout -subject -dates
```

That prints the Common Name you entered and the valid-from / valid-until dates —
a quick way to confirm the file is what you think it is.

### Step 6 — Wiring it into nginx

Two directives point nginx at the files, and `listen` gains the `ssl` keyword:

```nginx
server {
    listen 443 ssl;
    server_name localhost;

    ssl_certificate /path/to/your/certs/nginx-selfsigned.crt;
    ssl_certificate_key /path/to/your/certs/nginx-selfsigned.key;


    location / {
        proxy_pass http://nodejs_cluster;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
    }
}
```

Add this as a **second** `server` block inside `http` — keep the existing port
8080 one so you can compare HTTP and HTTPS side by side.

Notes on the above:

- `8443` is the conventional "unofficial HTTPS" port, pairing with `8080` for
  HTTP. The real standard is `443`; either works here.
- `ssl_certificate` takes the **`.crt`**, `ssl_certificate_key` takes the
  **`.key`**. Swapping them is a common mistake and produces a confusing
  `PEM_read_bio_X509` error at startup.
- `X-Forwarded-Proto $scheme` is newly important now. TLS stops at nginx, so the
  app only ever sees plain HTTP. Without this header it can't tell the visitor
  arrived over HTTPS, and any redirect it builds will drop back to `http://`.

Then test and reload:

```bash
sudo nginx -t
sudo systemctl reload nginx

curl -k https://localhost:8443
```

The `-k` tells curl to skip certificate verification. Without it you'll get
`self-signed certificate` and no output — which is curl working correctly, not a
broken setup.

### Step 7 — Why the browser shows a warning

Open `https://localhost:8443` and you'll get **"Your connection is not private"**
or **"Warning: Potential Security Risk Ahead"**.

This is expected and not a mistake. The browser is saying: *the encryption is
fine, but nobody I trust vouched for who this server claims to be.* It has a
list of trusted Certificate Authorities built in, and you aren't on it.

Click **Advanced → Proceed to localhost** to continue. The traffic is genuinely
encrypted; the only thing missing is third-party verification of identity.

For a real domain you'd replace this certificate with a free one from **Let's
Encrypt** (via `certbot`), which browsers trust automatically. Self-signed
certificates are for local development only.

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