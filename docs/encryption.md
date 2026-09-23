# Encrypted vault: design notes

> **Status (2026-09-23): parked, deliberately.** The code in `src/crypto/` and
> `src/accounts/` is complete and tested and is not wired into the server. The reason
> is the delivery question below, now answered by the hardware: the only reader in use
> speaks HTTP Basic and nothing else, so decryption would have to happen on the server
> with the password each request carries. That defends a stolen disk or a leaked backup
> and nothing more — and the site is one person's reading list on their own VPS. Not
> worth a key-unwrap per request until the threat changes. Revisit if a second real user
> arrives, or if the server ever moves to hardware someone else controls.

This describes the crypto core in `src/crypto/` and `src/accounts/`. It is a standalone
layer: it seals and opens byte strings and manages account key material, and it knows
nothing about OPDS, HTTP or where anything is stored.

That separation is deliberate. The delivery model — whether the server decrypts, or a
bridge on the user's own hardware does, or a browser extension does — is still open, and
the key handling and on-disk format must not change when it is decided.

## What this protects against, and what it does not

| Threat | Protected |
|---|---|
| Stolen disk, leaked backup, hosting-provider snapshot | **Yes** |
| Another user reading your library | **Yes** |
| A curious operator reading files or the database | **Yes** |
| A blob moved between accounts or articles to confuse the system | **Yes** |
| An operator who *modifies the server code* | **Only if decryption happens off the server** |
| A court order compelling the operator | **Only if decryption happens off the server** |

The last two rows are the whole architecture question. If the server ever holds the
passphrase — even briefly, in RAM, to serve an unmodified e-reader — then whoever controls
the server can capture it by changing the code. No amount of cryptography below fixes
that; only moving decryption onto hardware the user controls does.

Be precise about this in anything user-facing. "Encrypted at rest with a key we never
store" is true of a server-side design. "We cannot read your library" is not.

## Key hierarchy

```
passphrase ──Argon2id(salt, m=64MiB t=3)──> KEK ──HKDF──┬─> authKey   sent to the server
                                                        └─> wrapKey   never leaves the holder

masterKey (32 random bytes)
  ├── sealed under wrapKey          ──> wrapped_master
  └── sealed under recoveryWrapKey  ──> wrapped_master_recovery

masterKey ──HKDF──┬─> file-wrap key    wraps each per-article content key
                  ├─> metadata key     seals the metadata blob
                  └─> blind-index key  HMAC for deduplication
```

Three properties follow from this shape:

**The server can authenticate without being able to decrypt.** `authKey` is a one-way
derivation from the KEK, so it proves knowledge of the passphrase but cannot be run
backwards to recover the wrap key. The server stores only a slow hash of it, so a stolen
database cannot even be replayed against the login endpoint.

**Changing the passphrase is instant.** Only the wrapped master key is rewritten. An
account with ten thousand articles rotates in about a second, because not one stored
article is touched. This is also how an account picks up stronger KDF parameters later:
the parameters live beside each account, not in a constant.

**Losing the passphrase loses the library.** There is no reset, because a reset an
operator can perform is a backdoor an operator can be compelled to use. The recovery code
is a second, independently wrapped copy of the same master key, shown once at signup. It
is 160 bits of Crockford base32, which tolerates the letter/digit confusions people make
when retyping from paper.

## Container format

Written to permanent storage, so it is versioned and self-describing:

```
offset  size  field
0       6     magic "OPDSEV"
6       1     format version
7       1     cipher suite (1 = AES-256-GCM / Argon2id / HKDF-SHA256)
8       1     flags (bit 0: payload is length-prefixed and padded)
9       1     reserved
10      2     wrapped content-key length, big endian
12      n     wrapped content key   (nonce ‖ ciphertext ‖ tag)
12+n    ...   sealed payload        (nonce ‖ ciphertext ‖ tag)
```

A reader must reject a version or suite it does not implement rather than guessing.

The wrapped content key travels **inside** the container rather than in the database, so a
blob plus the account's master key is enough to recover the content. Backups and exports
stay self-describing, and losing the database does not lose the library.

Every ciphertext is bound to its context through the AEAD's additional authenticated data:

```
opds-feed:v1:content:<userId>:<itemId>
opds-feed:v1:content-key:<userId>:<itemId>
opds-feed:v1:metadata:<userId>:<itemId>
```

So a blob cannot be moved to another record, or into another account, and still decrypt.

Nonces are random 96-bit values. That is safe to roughly 2^32 messages under one key;
content keys are used exactly once, and the wrapping keys would need billions of articles
to approach the bound.

## Metadata and the blind index

Titles, URLs, authors, sites and tags all go into one sealed blob. In this product the
**source URL is the single most sensitive field** — far more revealing than the article
body — so it must not sit in a queryable column.

That breaks deduplication, which needs a uniqueness constraint over URLs. The fix is a
blind index: `HMAC-SHA256(blind-index key, normalised URL)`. The server can enforce
uniqueness and answer "does this account already have that article?" without learning any
URL. The key is per account, so the same URL in two accounts produces two unrelated
indexes and nothing can be correlated across users.

Server-side search and the "by site" and "by tag" shelves cannot work over ciphertext.
They move to the client, which pulls the index and filters locally — fine for a personal
library of a few thousand items.

## What the server can still see

Encryption does not make an account opaque, and pretending otherwise would be dishonest:

- Email address, signup time, and every login time
- How many items an account holds, and each one's approximate size and timestamps
- Total storage used
- Which items were downloaded and when

Ciphertext length is padded to 16 KiB blocks, which stops an observer fingerprinting a
specific known file by its exact byte count. It does not hide the difference between an
article and a novel. Metadata blobs are padded to 256 bytes for the same reason.

## Operational notes

**KDF cost.** Argon2id at m=64 MiB, t=3 takes about 1.4 s in pure JavaScript. That is the
right order for a key derived once per unlock, and it is comfortably above the OWASP floor
of 19 MiB / t=2. Two consequences:

- Each derivation allocates 64 MiB. If a design ever derives per request, that is a
  denial-of-service lever; cache the unlocked vault against a short-lived session token
  instead.
- The parameters are stored per account, so raising them later is a re-wrap at next
  login, not a migration.

**Key material in memory.** `Vault.destroy()` zeroes the keys, but JavaScript gives no
guarantee the garbage collector left no copy. It narrows the window; it does not close it.

**Moderation stays possible.** `status`, `strikes` and per-item deletion are all
content-blind. Suspending an account and deleting an item by id need no ability to read
anything, and keeping those levers is what preserves the DSA Article 6 hosting exemption
while still being unable to inspect content. See the notes in `src/accounts/schema.ts`.

## Not built yet

This layer is finished and tested; the application still runs single-user and unencrypted.
Wiring it up means, at minimum:

1. `user_id` on articles, with the metadata columns replaced by a sealed blob and a blind
   index column carrying the uniqueness constraint.
2. Replacing HTTP Basic against one config user with account login.
3. Deciding where decryption happens — the question this layer was deliberately built to
   stay neutral about.

Step 3 should come first. Steps 1 and 2 look quite different depending on the answer.

## Running it

```bash
npm test          # 24 tests: round-trips, tamper detection, rotation, recovery, quota
npm run vault-demo    # full lifecycle at real KDF cost, with timings
```
