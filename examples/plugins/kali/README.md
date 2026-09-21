# kali — installed security tools, for authorised testing only

Wraps command-line security tools you have **already installed** — `nmap`,
`whatweb`, `nikto`, `gobuster`, `dnsrecon`, `sslscan` — as ETTORE tools the
agent can drive during work you are authorised to do: a pentest engagement, a
CTF, your own lab. It **installs nothing** and ships **no exploits**.

## The authorisation gate

Every tool that touches a target refuses to run until you have declared a
scope, and refuses any host outside it:

```
kali_scope { action: "set", targets: ["192.168.56.0/24", "scanme.nmap.org"], note: "home lab" }
```

- The scope holds hosts, IPs and CIDR ranges.
- It lives only in the running session — it is never written to disk and does
  not persist, so each session states its own authorisation deliberately.
- A target outside the scope is refused with a message naming the host.

The scope is your own record that you are cleared to test those hosts. The
plugin enforces the boundary; **you are responsible for the authorisation
behind it.** Scanning hosts you do not own or have written permission to test
is, in most jurisdictions, illegal.

## Tools

| Tool | What it runs | Risk |
| --- | --- | --- |
| `kali_scope` | sets/shows the authorised targets | low |
| `kali_tools` | which wrapped tools are installed | low |
| `kali_portscan` | `nmap` port/service scan | high |
| `kali_web_fingerprint` | `whatweb` technology fingerprint | medium |
| `kali_web_scan` | `nikto` web-server scan | high |
| `kali_dir_enum` | `gobuster` directory enumeration | high |
| `kali_dns_enum` | `dnsrecon` DNS records | medium |
| `kali_tls_scan` | `sslscan` TLS inspection | low |

Every tool runs through `execFile` with an argument array — never a shell
string — and chooses its arguments from a typed schema, so a target or an
option can never become a second command.

## Install

```
/plugins install <path-to>/kali
```

Then check what is present:

```
/kali
```

Missing tools are named with the `apt` package that provides them; install the
ones you need yourself.
