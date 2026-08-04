# Sandbox package deployment PASS

Candidate version: `0.4.4`.

Pack:

```bash
npm pack /Users/jgp/Eddie-Personal-Space/work/lab-36-senpi-accounts \
  --pack-destination /tmp/lab36-package-sandbox --json
```

Artifact:

```text
/tmp/lab36-package-sandbox/eddieparc-senpi-accounts-0.4.4.tgz
```

Install:

```bash
npm install --prefix /tmp/lab36-package-sandbox \
  /tmp/lab36-package-sandbox/eddieparc-senpi-accounts-0.4.4.tgz \
  --omit=dev --ignore-scripts
```

Installed version:

```text
0.4.4
```

Packaged Alibaba smoke:

```text
provider              model      context  max-out  thinking  images
alibaba-model-studio  qwen-plus  131.1K   16.4K    no        no
```

Packaged Codex pool smoke:

```text
provider    model
codex-pool  gpt-5.3-codex-spark
codex-pool  gpt-5.4
codex-pool  gpt-5.4-mini
codex-pool  gpt-5.5
codex-pool  gpt-5.6-luna
codex-pool  gpt-5.6-sol
codex-pool  gpt-5.6-terra
```

All pack/install/smoke commands exited 0.
