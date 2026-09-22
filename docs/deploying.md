# Deploying behind your existing TLS

opds-feed listens on plain HTTP and expects a reverse proxy to terminate TLS. It
publishes on `127.0.0.1:8080` by default, so nothing reaches it except through that
proxy.

Two things matter for the reverse proxy:

1. **Forward the `Authorization` header.** Everything is behind HTTP Basic; if the
   proxy strips or consumes that header, the reader gets a 401 loop. In particular,
   do not put a second authentication layer (an OAuth portal, Cloudflare Access,
   `auth_basic` in nginx) in front of it — e-readers can only do Basic, and two
   Basic realms on one path cannot both be satisfied.
2. **Set `PUBLIC_URL`** to the exact external URL, or pass `X-Forwarded-Proto` and
   `X-Forwarded-Host` and leave `PUBLIC_URL` unset. The OPDS feed contains absolute
   links; if they are wrong the catalogue lists fine but nothing downloads.

## Caddy

```caddyfile
books.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

Caddy sets the `X-Forwarded-*` headers and passes `Authorization` through by default.

## nginx

```nginx
server {
    listen 443 ssl http2;
    server_name books.example.com;

    ssl_certificate     /etc/letsencrypt/live/books.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/books.example.com/privkey.pem;

    # EPUBs are small, but an article with many images is not nothing.
    client_max_body_size 4m;

    location / {
        proxy_pass         http://127.0.0.1:8080;
        proxy_http_version 1.1;

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host  $host;

        # Small readers download the whole file in one go; give them room.
        proxy_read_timeout 120s;
        proxy_buffering    off;
    }
}
```

## Apache

```apache
<VirtualHost *:443>
    ServerName books.example.com

    SSLEngine on
    SSLCertificateFile    /etc/letsencrypt/live/books.example.com/fullchain.pem
    SSLCertificateKeyFile /etc/letsencrypt/live/books.example.com/privkey.pem

    ProxyPreserveHost On
    RequestHeader set X-Forwarded-Proto "https"

    ProxyPass        / http://127.0.0.1:8080/
    ProxyPassReverse / http://127.0.0.1:8080/
</VirtualHost>
```

Apache drops the `Authorization` header from proxied requests in some
configurations. If readers get a 401 loop, add:

```apache
CGIPassAuth On
```

## systemd (without Docker)

```ini
[Unit]
Description=opds-feed
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=opds
WorkingDirectory=/opt/opds-feed
EnvironmentFile=/opt/opds-feed/.env
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=5

# The service only ever needs to write its own data directory.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/opds-feed/data

[Install]
WantedBy=multi-user.target
```

## Checking it from the outside

```bash
# Should be 401 with a Basic challenge
curl -i https://books.example.com/opds | head -3

# Should be 200 and an Atom navigation feed
curl -u reader:yourpassword https://books.example.com/opds | head -20

# Links inside the feed must point at your public hostname, not localhost
curl -su reader:yourpassword https://books.example.com/opds/all | grep acquisition
```

If that last command shows `http://localhost:8080/...`, `PUBLIC_URL` is wrong or
the proxy is not sending `X-Forwarded-Host`.

## If your reader cannot do HTTPS

Some very small readers ship a limited TLS stack. If yours cannot open the
catalogue over HTTPS, do **not** fall back to Basic auth over plain HTTP on a public
domain — that puts your password on the wire in clear text on every request. Put the
service on a WireGuard or Tailscale network instead, and keep the public HTTPS
endpoint for the web UI and the ingest API.

## Backups

```bash
# systemd / bare metal
systemctl stop opds-feed
tar czf opds-feed-$(date +%F).tar.gz data/
systemctl start opds-feed

# Docker: the data lives in the named volume `opds-data`, not in ./data
docker compose stop
docker run --rm -v opds-feed_opds-data:/data -v "$PWD:/out" busybox \
    tar czf /out/opds-feed-$(date +%F).tar.gz -C /data .
docker compose start
```

SQLite runs in WAL mode, so copying `data/` while the service is running can catch
it mid-write. Stopping it first, or using `sqlite3 data/opds-feed.sqlite ".backup ..."`,
avoids that.
