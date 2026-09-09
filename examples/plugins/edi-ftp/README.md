# edi-ftp

Read EDI files off an FTP, FTPS or SFTP server and turn a fixed-width or
delimited *tracciato* into structured records.

```
/plugins install edi-ftp
/plugins enable edi-ftp
```

## The workflow

```
/edi profile add prod ftps://mario@edi.fornitore.it/out --env EDI_PASS
/edi ls prod --pattern "*.EDI" --newest
/edi head prod BOLLE_20240131.EDI
/edi get prod BOLLE_20240131.EDI
/edi inspect edi-in/BOLLE_20240131.EDI
/edi parse edi-in/BOLLE_20240131.EDI tracciato-bolle --limit 20
```

The same operations are available to the agent as tools, so "scarica l'ultimo
file EDI e dimmi quante righe ci sono per ogni tipo record" works as a plain
request.

## Connecting

| URL | What it does |
| --- | --- |
| `ftp://user@host/dir` | plain FTP, passive mode |
| `ftps://user@host/dir` | FTP with `AUTH TLS` on port 21 (explicit) |
| `ftps://user@host:990/dir` | implicit TLS |
| `sftp://user@host/dir` | SFTP over SSH — needs `npm install ssh2` |

The path in the URL becomes the profile's base directory: every later path is
relative to it unless it starts with `/`.

### Passwords

Three sources, most explicit first:

1. **`--env VAR` / `passwordEnv`** — the password is read from an environment
   variable at connection time and never stored. Prefer this.
2. **stored** — `--password` encrypts it into
   `~/.config/ettore/edi-ftp/profiles.json` (mode 0600) with AES-256-GCM under
   a key derived from stable machine material. This is obfuscation, not a
   password manager: it stops a config dump from being a credential dump, and
   nothing more. A password passed this way also lands in the conversation
   transcript.
3. **`ETTORE_EDI_PASSWORD`** — a whole-process fallback.

SFTP can use `--key ~/.ssh/id_ed25519` instead of a password.

FTPS certificates are validated. `--insecure` turns that off for a server with
a self-signed certificate — it is a real downgrade, not a formality.

## Layouts

A layout is JSON, so it can be written straight from a paper spec and kept in
git:

```json
{
  "name": "tracciato-bolle",
  "type": "fixed",
  "base": 1,
  "encoding": "latin1",
  "recordType": { "start": 1, "length": 2 },
  "records": {
    "01": { "name": "testata", "fields": [
      { "name": "mittente", "start": 3,  "length": 8 },
      { "name": "data",     "start": 12, "length": 8, "type": "date", "format": "YYYYMMDD" }
    ]},
    "02": { "name": "riga", "fields": [
      { "name": "articolo", "start": 3,  "length": 8 },
      { "name": "importo",  "start": 12, "length": 12, "type": "decimal", "decimals": 2 }
    ]}
  }
}
```

**`base` is the field to get right.** A tracciato spec counts columns from 1;
code counts from 0. Reading a 1-based spec as 0-based shifts every field on
the line by one character and raises no error at all — you get plausible
rubbish. `base` defaults to 1, matching the spec on paper.

Field types: `string` (trimmed), `raw` (untrimmed), `int`, `decimal`, `date`,
`bool`.

`decimal` reads both conventions in use: an implied decimal point
(`"000000012345"` with `"decimals": 2` → `123.45`) and a literal separator
(`"1.234,56"` → `1234.56`), deciding per value. A trailing minus counts as a
sign.

`date` takes `YYYYMMDD`, `DDMMYYYY`, `MMDDYYYY`, `YYMMDD` or `DDMMYY`. A value
that does not match comes back `null` — a wrong date in a customs record is
worse than a missing one.

For a single-record-type file, drop `recordType` and put `fields` at the top
level.

### Short lines

Senders strip trailing spaces, so the last fields of a record routinely arrive
truncated or missing. What that means is a property of your tracciato, so it is
a setting — `onShortField` on the layout, `onShort` on a single field, or
`--short` / `onShortField` for one call:

| Value | The field becomes | Reported |
| --- | --- | --- |
| `pad` | padded with spaces, then read | no |
| `report` | padded with spaces, then read | yes |
| `reject` | `null` | yes |
| `byType` *(default)* | padded for `string`/`raw`, `null` for `int`, `decimal`, `date`, `bool` | only for the rejected ones |

`byType` is the default because the two cases genuinely differ. A truncated
name is still a name. A truncated number is a *different* number: `123456` cut
to `1234` with `"decimals": 2` reads as 12,34 instead of 1234,56 — plausible,
wrong, and invisible. So it becomes `null` and lands in the report.

Set it per field where the tracciato says a field is optional:

```json
{ "name": "note", "start": 60, "length": 40, "onShort": "pad" }
```

Try a policy against a real file before saving it into the layout:

```
/edi parse edi-in/BOLLE.EDI tracciato-bolle --short report
```

Delimited layouts use `"type": "delimited"`, a `delimiter`, an optional
`quote`, `"header": true` to skip the first line, and `index` (0-based) on each
field instead of `start`/`length`.

Layouts live in `~/.config/ettore/edi-ftp/layouts/<name>.json`.

## Don't have the spec?

`edi_inspect` reads the file and reports what it can prove: line lengths and
whether they are uniform, which delimiters appear consistently, which short
prefixes look like record-type markers, and — for a fixed-width file — where
the always-blank columns are, which is where the field boundaries usually sit.
It ends with a **draft** layout.

The draft is evidence, not a spec. A column that happens to be empty in the
sample splits a field in two, and only the spec says what a field *means*.
Correct it, then `edi_layout_save`.

## Encoding

Defaults to `latin1` — it never throws and preserves every byte, which is what
you want for files that are usually CP1252 or plain ASCII. `utf8` is available
per profile, per layout, or per call.

## Tools

| Tool | Purpose |
| --- | --- |
| `edi_profile_save` / `edi_profile_list` / `edi_profile_delete` | connection profiles |
| `edi_list` | list a remote directory, with glob filter and sorting |
| `edi_read` | download and show the first lines, saving nothing |
| `edi_fetch` | download into the workspace, with size and SHA-256 |
| `edi_inspect` | analyse an undocumented tracciato, propose a layout |
| `edi_layout_save` / `edi_layout_list` / `edi_layout_show` | layouts |
| `edi_parse` | file + layout → records as JSON, table or CSV |

## Limits worth knowing

- Transfers are capped at 10 MB (`maxBytes` raises it) and every socket has a
  30 s timeout.
- Downloads and parsed output stay inside the workspace. A remote filename is
  server-controlled input, and `../../.ssh/authorized_keys` is a name a server
  can return.
- Passive mode only, and the data connection always goes back to the host you
  dialled — never the address in the `227` reply.
- Read-only: this plugin does not upload, rename or delete anything on the
  server.
- A malformed line is reported in `errors` and parsing continues; one bad
  record does not lose the other four thousand.
