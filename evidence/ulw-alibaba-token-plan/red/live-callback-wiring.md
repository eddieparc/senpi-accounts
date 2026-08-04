# RED — real Senpi login callback wiring

Surface: Orca visible xterm terminal running:

```bash
ALIBABA_MODEL_STUDIO_BASE_URL=https://ws-tzcu53xu4sxxeqq4.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1 \
SENPI_CODING_AGENT_DIR=/tmp/lab-36-senpi-qa2 \
senpi -e /Users/jgp/Eddie-Personal-Space/work/lab-36-senpi-accounts/dist/index.js
```

Interaction:

1. `/login alibaba-model-studio`
2. Enter to select `Alibaba Model Studio (workspace)`

Observed:

```text
→ alibaba-model-studio  Alibaba Model Studio (workspace) · subscription/API key
Login to Alibaba Model Studio (workspace)
Error: Failed to login to Alibaba Model Studio (workspace):
Alibaba Model Studio login needs an interactive prompt
```

Sanitized state inspection:

```json
{"exists":true,"providers":[],"alibaba":null}
```

Root cause: the extension looked for `callbacks.prompt`; Senpi 2026.8.3 invokes
provider login prompts through `callbacks.onPrompt`.

Security cleanup: the terminal tab and screenshot were durably deleted, the
sandbox directory was removed, and the possibly exposed key was reset in the
authenticated Alibaba console before any retry.
