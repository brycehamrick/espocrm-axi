# Contributing espocrm-axi to the AXI catalog

Do this only AFTER Bryce says so - npm package published, repo public, dogfooded.
One-time per release; the entry stays. Source of truth:
<https://github.com/kunchenguid/axi/blob/main/CONTRIBUTING.md>

## The catalog entry

Append to the `community` list in `catalog.yaml` (one-to-two clause style like its
neighbors; keep the description free of any instance/domain/user specifics):

```yaml
      - name: espocrm-axi
        url: https://github.com/brycehamrick/espocrm-axi
        author: brycehamrick
        domain: CRM
        description: "List, search, create, and update any EspoCRM record type, read the inbox and send or reply to email with delivery verification, and manage stream, activities, pipelines, settings, mass actions, and exports over the REST API with token-efficient TOON output and `--confirm`-gated mutations."
```

## Steps

1. Fork `kunchenguid/axi`, clone the PARENT repo, point `origin` at it, branch:

   ```sh
   git clone git@github.com:kunchenguid/axi.git && cd axi
   git remote set-url origin git@github.com:kunchenguid/axi.git
   git checkout -b add-espocrm-axi
   ```

2. Append the entry above to `catalog.yaml`.

3. Regenerate the docs tables with Node 24 (matches CI):

   ```sh
   pnpm install --frozen-lockfile
   pnpm run docs:gen
   ```

4. Run the gates CI runs:

   ```sh
   pnpm run format:check
   pnpm run lint
   pnpm --dir packages/axi-sdk-js run build
   pnpm --dir packages/axi-sdk-js test
   ```

5. Commit exactly `catalog.yaml`, `README.md`, `docs/index.html` with a
   conventional message (`docs: add espocrm-axi to catalog`). Never hand-edit the
   generated table regions, `packages/axi-sdk-js/CHANGELOG.md`, or
   `.release-please-manifest.json`.

6. Push THROUGH the no-mistakes gate (human PRs to `main` require its signature;
   fork-based contributions need no-mistakes v1.30.1+):

   ```sh
   no-mistakes init --fork-url git@github.com:brycehamrick/axi.git
   git push no-mistakes
   no-mistakes   # attach, fix findings or auto-fix
   ```

7. The pipeline pushes to the fork and opens the PR; `Require no-mistakes` and
   `Guard generated files` must both pass.

## Publishing this package first

```sh
npm ci && npm run check      # typecheck, secret scan, tests, skill check
npm login && npm publish     # prepublishOnly runs the same check + build
npx -y espocrm-axi@latest --version
npx -y skills@latest add brycehamrick/espocrm-axi --skill espocrm-axi -g
```
