# Releasing Ferry

A tag push starts the release. The owner creates a draft GitHub release with the notes, then pushes the tag `vX.Y.Z`. Only a person with write access sees a draft, and `releases/latest` does not return it. The workflow publishes the release as its last step, so a release is never visible without its files. See [Publish a release](#publish-a-release).

After the tag push, `.github/workflows/release.yml` does these steps in this order:

1. It reads the version from the tag. It refuses a tag that is not `vX.Y.Z` or `vX.Y.Z-<pre-release>`. It stops when there is no release for the tag.
2. It compiles `ferry-darwin-arm64`, `ferry-darwin-x64`, `ferry-linux-arm64` and `ferry-linux-x64` with `bun build --compile`. The build sets the version from the tag with `--define`, so `ferry --version` prints it. The two darwin binaries compile on macOS runners, `macos-latest` for arm64 and `macos-15-intel` for x64. Each gets an ad-hoc signature with `codesign --force --sign -`, and then passes `codesign -v`, `ferry --help`, and `ferry --version`. macOS kills an arm64 executable that has no valid signature, and a darwin binary compiled on Linux does not have a valid signature.
3. It builds `ferry-menubar-macos.zip` on `macos-latest` with `macos/build.sh`: the menu bar app as a universal binary, with the version of the tag and an ad-hoc signature.
4. It writes `SHA256SUMS` for the four binaries and the zip, and attaches all of them to the draft release. `install.sh` and `ferry menubar install` verify their downloads against `SHA256SUMS`.
5. It publishes the npm packages with provenance through trusted publishing (OIDC). There is no npm token. It publishes the four platform packages first. npm shows a new version some time after the publish, and not in the publish order. So the workflow waits until npm shows the four platform packages, at most 15 minutes for each, and then publishes `@dlhck/ferry`.
6. It waits until npm shows all five packages, at most 15 minutes for each. It checks that the draft has the six files. Then it publishes the release.

npm comes before the GitHub release for two reasons. npm cannot take a version back, so the npm publish runs only after all steps that can fail without a trace. And the clients read the new version from the latest GitHub release, so at that time the files and the npm packages are there. Between the publish of `@dlhck/ferry` and the publish of the release, `npm install` gives the new version and `ferry self-update` does not offer it yet. This time is the wait of step 6.

A version with a pre-release part, for example `1.2.0-rc.1`, goes to the npm dist-tag `next`, and the workflow publishes its release as a GitHub pre-release. A pre-release is never the latest release. All other versions go to `latest`.

The workflow runs only in `dlhck/ferry`. A tag push never comes from a pull request. On pull requests, `.github/workflows/npm-pack.yml` stages the packages, runs `npm publish --dry-run` for each package, and installs the packed tarballs to run `ferry --help` on Linux. It also compiles and signs the two darwin binaries on the same macOS runners as the release and runs `ferry --help` and `ferry --version`. That workflow has no npm token and no `id-token` permission.

## npm packages

The files in `npm/` are the package templates:

- `npm/ferry` is `@dlhck/ferry`. Its `bin` is `bin/ferry.js`, a Node launcher with no dependencies. The launcher finds the binary of the platform package and runs it with the same arguments, stdio and exit code. It forwards `SIGINT`, `SIGTERM`, `SIGHUP` and `SIGQUIT`.
- `npm/ferry-<os>-<arch>` is `@dlhck/ferry-<os>-<arch>`. Each package has `os` and `cpu` fields and holds one binary at `bin/ferry`. `@dlhck/ferry` lists the four packages as `optionalDependencies`, so npm installs only the package for the current platform.

`node npm/stage.mjs <version> <dist-dir> <out-dir>` copies the templates to `<out-dir>`, sets the version in all packages, and copies the binaries from `<dist-dir>`. The version in the templates stays `0.0.0`. The root `package.json` is the development package. It stays private, and npm never publishes it.

To check the packages on your machine:

```sh
for target in darwin-arm64 darwin-x64 linux-arm64 linux-x64; do
  bun build --compile --target="bun-$target" src/cli.ts --outfile "dist/ferry-$target"
done
node npm/stage.mjs 0.0.0-local dist out
npm pack ./out/ferry-darwin-arm64 ./out/ferry --pack-destination packs
npm install --global --offline --prefix /tmp/ferry-prefix ./packs/*.tgz
/tmp/ferry-prefix/bin/ferry --help
```

Use the platform package of your machine in place of `ferry-darwin-arm64`. Use `./` in front of each path. Without it, npm reads `out/ferry` as a GitHub repository.

## One-time setup

The release workflow publishes only through trusted publishing (OIDC). Trusted publishing cannot create a package. The package must exist on npm before you can add a trusted publisher to it ([npm docs](https://docs.npmjs.com/trusted-publishers), [npm/cli#8544](https://github.com/npm/cli/issues/8544)). A granular token with "Bypass two-factor authentication" does not work either: `npm publish` fails with `EOTP`. Thus you publish the first version of each new package by hand with two-factor authentication. After that, CI publishes all releases.

### Before the first release

1. Make the `dlhck/ferry` repository public. npm provenance needs a public source repository.
2. On npmjs.com, enable two-factor authentication on the `dlhck` account if it is not on. The manual publish and `npm trust` need it.
3. Create the GitHub environment `npm`:

   ```sh
   gh api --method PUT repos/dlhck/ferry/environments/npm
   ```

   Optional: in **Settings > Environments > npm**, set **Deployment branches and tags** to **Selected branches and tags** and add the tag rule `v*`.

### Publish a new package for the first time

Do these steps on a Mac, from the tag of the release, for each package that is not on npm yet. Use npm 11.15.0 or later.

1. Compile the four binaries with the release version. Give the two darwin binaries an ad-hoc signature:

   ```sh
   VERSION=1.2.0
   for target in darwin-arm64 darwin-x64 linux-arm64 linux-x64; do
     bun build --compile --target="bun-$target" --define "FERRY_VERSION=\"$VERSION\"" src/cli.ts --outfile "dist/ferry-$target"
   done
   for target in darwin-arm64 darwin-x64; do
     codesign --force --sign - "dist/ferry-$target"
     codesign -v "dist/ferry-$target"
   done
   node npm/stage.mjs "$VERSION" dist out
   ```

2. Log in and publish the platform packages first, then `@dlhck/ferry`. npm asks for a one-time password. A local publish cannot add provenance.

   ```sh
   npm login
   for dir in ./out/ferry-darwin-arm64 ./out/ferry-darwin-x64 ./out/ferry-linux-arm64 ./out/ferry-linux-x64 ./out/ferry; do
     npm publish "$dir" --access public
   done
   ```

   For a pre-release version, add `--tag next`.

3. Add a trusted publisher to each package. `npm trust` asks for a one-time password:

   ```sh
   for name in ferry ferry-darwin-arm64 ferry-darwin-x64 ferry-linux-arm64 ferry-linux-x64; do
     npm trust github "@dlhck/$name" --repo dlhck/ferry --file release.yml --env npm --allow-publish
   done
   ```

   The trusted publisher is bound to the file name `release.yml` and the environment `npm`. Do not rename them.

   You can also do this on npmjs.com. Open **Settings** of each package, then **Trusted Publisher**, then **GitHub Actions**. Set **Organization or user** to `dlhck`, **Repository** to `ferry`, **Workflow filename** to `release.yml`, and **Environment name** to `npm`.

4. Delete the old token secret if it exists, and delete the token on npmjs.com in **Access Tokens**:

   ```sh
   gh secret delete NPM_TOKEN --env npm --repo dlhck/ferry
   ```

5. Optional: in **Settings** of each package, set **Publishing access** to **Require two-factor authentication and disallow tokens**. Trusted publishing continues to work with this setting.

Do these steps before you push the tag, or after the publish job of that version failed. When the release workflow of that version runs, the publish step skips the packages that are already on npm. Later releases publish from CI.

Trusted publishing needs npm 11.5.1 or later. The workflow uses Node 24 and stops before it publishes if its npm is older. The workflow does not give `setup-node` a `registry-url`, because then `setup-node` writes an `.npmrc` that reads a token from `NODE_AUTH_TOKEN`.

## Publish a release

1. Merge the changes to `main`.
2. Create the draft release with the notes. For example:

   ```sh
   gh release create v1.2.0 --draft --target main --notes-file notes.md
   ```

   `--generate-notes` in place of `--notes-file` writes the notes from the pull requests. A draft does not create the tag and does not start a workflow.
3. Push the tag. The tag push starts the **Release** workflow:

   ```sh
   git fetch origin main
   git tag v1.2.0 origin/main
   git push origin v1.2.0
   ```

4. Watch the workflow:

   ```sh
   gh run watch "$(gh run list --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status
   ```

5. Check the result:

   ```sh
   gh release view v1.2.0 --json isDraft,isPrerelease,assets --jq '{isDraft, isPrerelease, assets: [.assets[].name]}'
   npm view @dlhck/ferry dist-tags
   ```

   `isDraft` is `false`, and the release has the four binaries, `ferry-menubar-macos.zip`, and `SHA256SUMS`.

For a pre-release, use a tag such as `v1.2.0-rc.1`. The workflow marks the release as a pre-release.

Do not change the version in any `package.json`. The tag sets the version.

Do not run `gh release create` without `--draft`. It creates the tag, so the workflow runs, but the release is visible without its files until the attach step ends. The workflow gives a warning for it.

## When the release workflow fails

The release stays a draft until the last step. Thus a failed run shows nothing on GitHub, and `ferry self-update` and `install.sh` continue to see the release before it. What to do depends on the step that failed.

| Failed step | What is visible | What to do |
| --- | --- | --- |
| Check release: there is no release for the tag | Only the tag | Create the draft release (step 2). Then run `gh run rerun <run-id> --failed`. |
| Build, menu bar app, or attach | Only the tag. The draft can have some files | For a runner problem, run `gh run rerun <run-id> --failed`. The attach step replaces files that are there. For a problem in the code, see "Fix the code" below. |
| npm publish | The draft, and the packages that npm accepted. If `@dlhck/ferry` is not on npm, no install gets the new version, because only `@dlhck/ferry` refers to the platform packages | Fix the cause and run `gh run rerun <run-id> --failed`. The publish step skips each package version that npm shows. |
| Wait for npm, or the last step | All five packages are on npm, and `npm install` gives the new version. The release is a draft | Run `gh run rerun <run-id> --failed` some minutes later. |

More rules:

- A second run uses the workflow file and the code at the tag.
- If `npm publish` says that the version is there already, npm accepted the package and does not show it yet. Run the failed jobs again some minutes later.
- To publish the release by hand, first make sure that the draft has the six files and that npm shows the five packages. Then run `gh release edit v1.2.0 --draft=false`. Add `--prerelease` for a pre-release.
- Fix the code, when no package of the version is on npm: delete the tag with `git push origin :refs/tags/v1.2.0` and `git tag -d v1.2.0`, merge the fix, and push the tag again (step 3). The draft stays and takes the new tag.
- Fix the code, when a package of the version is on npm: npm does not let you publish the same version twice. Delete the draft with `gh release delete v1.2.0 --cleanup-tag --yes`, and publish a new patch release. If `@dlhck/ferry` of the failed version is on npm, run `npm deprecate @dlhck/ferry@1.2.0 "Use 1.2.1"`, and for a version on `latest` make sure that the new patch release takes `latest`.
