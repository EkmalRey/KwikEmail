# Security Policy

## Supported versions

Security fixes are provided for the latest release and the current default branch.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository. Do not open a public issue containing credentials, email contents, domains, account identifiers, callback URLs, or deployment logs. If private reporting is not enabled, contact the maintainer privately before sharing details.

Include the affected version, impact, reproduction steps, and a minimal sanitized example. You can expect an initial response within seven days.

## Sensitive data

The complete `/data` directory is sensitive. It contains archived email, encrypted Cloudflare credentials, Worker bootstrap keys, Wrangler OAuth profiles, sessions, and the encryption key needed to decrypt stored credentials. Back it up and restore it as one unit with access controls equivalent to the running service.

KwikEmail is intended for loopback, Tailscale, or another trusted private network by default. Fresh installations use temporary password `123456`, so replace it before changing the default loopback binding. Use least-privilege Cloudflare credentials and revoke them immediately if `/data` or a credential is exposed.
