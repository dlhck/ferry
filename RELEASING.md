# Releasing Ferry

A GitHub release starts the release. The owner publishes a release from a tag `vX.Y.Z`. Then `.github/workflows/release.yml` does these steps:

1. It reads the version from the tag. It refuses a tag that is not `vX.Y.Z` or `vX.Y.Z-<pre-release>`.
2. It compiles `ferry-darwin-arm64`, `ferry-darwin-x64`, `ferry-linux-arm64` and `ferry-linux-x64` with `bun build --compile`.
3. It attaches the four binaries to the release.
4. It publishes the npm packages with provenance. It publishes the four platform packages first, then `@dlhck/ferry`.

A version with a pre-release part, for example `1.2.0-rc.1`, goes to the npm dist-tag `next`. All other versions go to `latest`.

The workflow runs only in `dlhck/ferry`. A release event never comes from a pull request. On pull requests, `.github/workflows/npm-pack.yml` stages the packages, runs `npm publish --dry-run` for each package, and installs the packed tarballs to run `ferry --help`. That workflow has no npm token and no `id-token` permission.

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

npm trusted publishing (OIDC) cannot create a package. The package must exist on npm before you can add a trusted publisher to it ([npm docs](https://docs.npmjs.com/trusted-publishers), [npm/cli#8544](https://github.com/npm/cli/issues/8544)). Thus the first release publishes with a short-lived granular token. After that release, trusted publishing replaces the token.

### Before the first release

1. Make the `dlhck/ferry` repository public. npm provenance needs a public source repository.
2. On npmjs.com, enable two-factor authentication on the `dlhck` account if it is not on. `npm trust` needs it.
3. On npmjs.com, open **Access Tokens**, then **Generate New Token**, then **Granular Access Token**. Set these values:
   - **Expiration:** 7 days.
   - **Packages and scopes:** **Read and write**, **Only select packages and scopes**, then select the scope `@dlhck`. A scope lets the token create the new packages.
   - **Bypass two-factor authentication:** on. The workflow cannot type a one-time password.
4. Create the GitHub environment `npm` and store the token in it:

   ```sh
   gh api --method PUT repos/dlhck/ferry/environments/npm
   gh secret set NPM_TOKEN --env npm --repo dlhck/ferry
   ```

   Optional: in **Settings > Environments > npm**, set **Deployment branches and tags** to **Selected branches and tags** and add the tag rule `v*`.

### After the first release

1. Add a trusted publisher to each of the five packages. `npm trust` needs npm 11.15.0 or later and asks for a one-time password:

   ```sh
   for name in ferry ferry-darwin-arm64 ferry-darwin-x64 ferry-linux-arm64 ferry-linux-x64; do
     npm trust github "@dlhck/$name" --repo dlhck/ferry --file release.yml --env npm --allow-publish
   done
   ```

   You can also do this on npmjs.com. Open **Settings** of each package, then **Trusted Publisher**, then **GitHub Actions**. Set **Organization or user** to `dlhck`, **Repository** to `ferry`, **Workflow filename** to `release.yml`, and **Environment name** to `npm`.
2. Remove the token:

   ```sh
   gh secret delete NPM_TOKEN --env npm --repo dlhck/ferry
   ```

   Then delete the token on npmjs.com in **Access Tokens**.
3. Optional: in **Settings** of each package, set **Publishing access** to **Require two-factor authentication and disallow tokens**. Trusted publishing continues to work with this setting.

When `NPM_TOKEN` is not set, npm uses trusted publishing. Trusted publishing needs npm 11.5.1 or later. The workflow uses Node 24 and prints the npm version before it publishes.

## Publish a release

1. Merge the changes to `main`.
2. Create the tag and publish the release. For example:

   ```sh
   gh release create v1.2.0 --target main --generate-notes
   ```

   For a pre-release, use a tag such as `v1.2.0-rc.1` and add `--prerelease`.
3. Watch the **Release** workflow in the **Actions** tab.

Do not change the version in any `package.json`. The tag sets the version.

If the workflow fails after some packages are on npm, fix the cause and run the failed jobs again. The publish step skips each package version that is already on npm. A new run uses the workflow and the code at the tag. If the fix needs a change in the repository, publish a new patch release. npm does not let you publish the same version twice.
