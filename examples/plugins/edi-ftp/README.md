# edi-ftp

Read EDI files off an FTP, FTPS or SFTP server and turn them into structured
records — a fixed-width *tracciato*, a delimited file, or an EDIFACT / X12
interchange. With a layout you get named fields; without one it infers the
structure and returns the columns unnamed.

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

### Which record is this?

Four conventions, all in use. `recordType` takes whichever one your tracciato
follows:

```json
{ "recordType": { "start": 1, "length": 2 } }          // a marker at a position
{ "recordType": { "field": 0 } }                        // a column, in a delimited file
{ "recordType": { "pattern": "^(TESTA|RIGA)", "group": 1 } }
{ "recordType": { "byLength": { "120": "testata", "340": "riga" } } }
```

`byLength` is for the tracciati that mark nothing at all, where the only thing
telling a header from a detail row is how long the row is.

### Hierarchy

A tracciato is flat on disk and hierarchical in meaning: a testata, then its
righe, then the next testata. Declare the relationship and set `"nest": true`:

```json
"02": { "name": "riga", "parent": "01", "childKey": "righe", "fields": [ … ] }
```

Each child attaches to the last parent seen before it. A child arriving before
any parent stays at the root rather than being dropped — losing a record
because the file opened badly would be worse than an odd shape. `stats.matched`
still counts every record; `stats.roots` counts the top-level ones.

### Repeating slots

`"occurs": 10` reads ten consecutive values into an array, moving by `step`
(the field's own length unless the tracciato pads between slots):

```json
{ "name": "quantita", "start": 41, "length": 6, "type": "int", "occurs": 10 }
```

### Signs, codes, validation

`"signed"` says where the sign lives: `trailing` (`012345-`), `leading`, or
`overpunch` — the COBOL zoned decimal still produced by every mainframe, where
the sign rides on the last digit, so `12{` is +120 and `12}` is −120. Read as
plain text those are both 12: same number, opposite meaning, no error anywhere.

`"decode"` maps codes to meanings, and `decodeUnknown` (`keep`, `null`,
`error`) says what an unlisted code does:

```json
{ "name": "regime", "start": 3, "length": 2,
  "decode": { "01": "Esportazione definitiva", "02": "Temporanea" },
  "decodeUnknown": "error" }
```

`"required": true` and `"pattern": "^[A-Z]{4}$"` turn a silently wrong value
into a reported one. Neither stops the parse; both land in `errors`.

### Decimal marks

`1.234,56` and `1234.56` are the same amount in two conventions, and stripping
every dot as a thousands separator turns the second into 123456. The mark is
decided per value: the field may name it with `decimalSeparator`, an EDIFACT
interchange declares it in its `UNA` header, and otherwise it is inferred —
when both marks appear the last one is the decimal, and several dots with no
comma is grouping. One case stays ambiguous, a single dot with exactly three
digits after it (`1.234`), read as a decimal point unless `decimalSeparator`
says otherwise.

### EDIFACT and X12

`"type": "segment"` reads the other EDI family — punctuation-delimited
segments rather than lines, which is why a line-based parser sees such a file
as one enormous row. Fields are addressed by `element` and optionally
`component`:

```json
{
  "type": "segment",
  "records": {
    "NAD": { "name": "anagrafica", "fields": [
      { "name": "ruolo", "element": 1 },
      { "name": "ragioneSociale", "element": 2, "component": 0 }
    ]},
    "MOA": { "name": "importo", "fields": [
      { "name": "valore", "element": 1, "component": 1, "type": "decimal" }
    ]}
  }
}
```

The punctuation is not configured: EDIFACT states it in the `UNA` header, and
X12 pins it by position because the `ISA` envelope is exactly 106 characters.
Declare `separators` only for a file that carries neither. The release
character (`?` in EDIFACT) is honoured, so a company name containing a `+`
survives as one element instead of tearing the segment in half.

## Don't have the spec?

`edi_inspect` reads the file and reports what it can prove: line lengths and
whether they are uniform, which delimiters appear consistently, which short
prefixes look like record-type markers, and — for a fixed-width file — where
the always-blank columns are, which is where the field boundaries usually sit.
It ends with a **draft** layout.

The draft is evidence, not a spec. A column that happens to be empty in the
sample splits a field in two, and only the spec says what a field *means*.
Correct it, then `edi_layout_save`.

For an EDIFACT or X12 file there are no boundaries to guess: the inspector
reports the dialect, the punctuation and every segment tag with its element
count, which is the skeleton of a layout. The names still come from the message
spec — "element 4 of NAD" is a position, not a meaning.

**`edi_parse` also works with no layout at all.** It infers the structure and
returns records with placeholder names (`campo_1`, `campo_2`, … or `el_1` for
segments), flagged with a warning and accompanied by the inferred layout so you
can correct it and save it. Unnamed columns you can look at beat an error
message. When even the structure cannot be inferred it says so and hands back
the inspection rather than inventing one.

What no parser can do is derive *meaning* from data. Boundaries, delimiters and
record markers are in the file; that column 12 is the shipping date is in the
spec, and has to be written into the layout once.

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
| `edi_parse` | file (+ layout, or none) → records as JSON, table or CSV |

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
