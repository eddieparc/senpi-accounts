# Final release-candidate validation

Candidate: `@eddieparc/senpi-accounts@0.4.4`

Validation after adding `alibaba-model-studio/glm-5.2`:

- LSP `src/`: 37 files, 0 errors; 5 pre-existing unused-symbol hints.
- LSP `test/`: 35 files, 0 errors; 2 pre-existing unused-symbol hints.
- `npm test`: 35 files passed, 273 tests passed.
- `npm run typecheck`: exit 0.
- `npm run build`: exit 0.
- `git diff --check`: exit 0.
- `npm pack --dry-run --json`: exit 0.
  - package `@eddieparc/senpi-accounts@0.4.4`
  - 75 entries
  - packed size 84,241 bytes
  - unpacked size 298,314 bytes
  - SHA-1 `d2fbf62249cd48379c2104119c84ec1c9651d23e`
  - integrity
    `sha512-2MkszWGUad+pJMpr+1qEwReFvIA/hiwDw+hOpEh8qKKhDJ5o1EWW46rXPyvyDF71sl5soDbe7TAoUccnY6HuEw==`

Secret evidence remains valid after the final model-catalog edit:

- previous full scan: 96 files; no literal replacement key and no
  real-length `sk-ws-` key.
- the only later implementation change added the literal model ID
  `glm-5.2`.
- subsequent evidence additions contain only redacted prefixes, an HTTP
  request ID, and hashes; no credential plaintext.
- the intentionally short test sentinel `sk-ws-test-secret` remains.

Stock Codex fallback real-surface evidence:

- screenshot:
  `/var/folders/8b/wc4w7rz95w3_6b0xm_r869yw0000gn/T/orca-computer-use/63dc098a-54bc-4b53-8b04-68d59bf8e67a-screenshot.png`
- SHA-256:
  `d000eed202f2a8f8b9b2804de346671a22276428e613493f90a3d46a52df9710`
- visually inspected: `(openai-codex) gpt-5.6-sol:high`, active tool work,
  and `Working`.
