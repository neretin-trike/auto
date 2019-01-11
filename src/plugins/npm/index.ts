import * as fs from 'fs';
import parseAuthor from 'parse-author';
import { promisify } from 'util';

import getPackages from 'get-monorepo-packages';
import { gt } from 'semver';
import { IExtendedCommit } from '../../log-parse';
import { AutoRelease, IPlugin } from '../../main';
import SEMVER from '../../semver';
import execPromise from '../../utils/exec-promise';
import { ILogger } from '../../utils/logger';
import getConfigFromPackageJson from './package-config';

const readFile = promisify(fs.readFile);

function isMonorepo() {
  return fs.existsSync('lerna.json');
}

async function greaterRelease(
  prefixRelease: (release: string) => string,
  name: any,
  packageVersion: string
) {
  const publishedVersion = prefixRelease(
    await execPromise('npm', ['view', name, 'version'])
  );

  return gt(packageVersion, publishedVersion)
    ? packageVersion
    : publishedVersion;
}

export async function changedPackages(sha: string, logger: ILogger) {
  const packages = new Set<string>();
  const changedFiles = await execPromise('git', [
    'show',
    '--first-parent',
    sha,
    '--name-only',
    '--pretty='
  ]);

  changedFiles.split('\n').forEach(filePath => {
    const parts = filePath.split('/');

    if (parts[0] !== 'packages' || parts.length < 3) {
      return;
    }

    packages.add(
      parts.length > 3 && parts[1][0] === '@'
        ? `${parts[1]}/${parts[2]}`
        : parts[1]
    );
  });

  if (packages.size > 0) {
    logger.veryVerbose.info(`Got changed packages for ${sha}:\n`, packages);
  }

  return [...packages];
}

interface INotePartition {
  [key: string]: string[];
}

/**
 * Attempt to create a map of monorepo packages
 */
function partitionPackages(
  labelCommits: IExtendedCommit[],
  lineRender: (commit: IExtendedCommit) => string
) {
  const packageCommits: INotePartition = {};

  labelCommits.map(commit => {
    const line = lineRender(commit);

    const packages =
      commit.packages && commit.packages.length
        ? commit.packages.map(p => `\`${p}\``).join(', ')
        : 'monorepo';

    if (!packageCommits[packages]) {
      packageCommits[packages] = [];
    }

    packageCommits[packages].push(line);
  });

  return packageCommits;
}

export default class NPMPlugin implements IPlugin {
  public name = 'NPM';

  public apply(auto: AutoRelease) {
    auto.hooks.getAuthor.tapPromise('NPM', async () => {
      auto.logger.verbose.info(
        'NPM: Getting repo information from package.json'
      );
      const packageJson = JSON.parse(await readFile('package.json', 'utf-8'));

      if (packageJson.author) {
        const { author } = packageJson;

        if (typeof author === 'string') {
          return parseAuthor(author);
        }

        return author;
      }
    });

    auto.hooks.getPreviousVersion.tapPromise('NPM', async prefixRelease => {
      let previousVersion = '';

      if (isMonorepo()) {
        auto.logger.veryVerbose.info(
          'Using monorepo to calculate previous release'
        );
        const monorepoVersion = prefixRelease(
          JSON.parse(await readFile('lerna.json', 'utf-8')).version
        );

        const packages = getPackages(process.cwd());
        const releasedPackage = packages.reduce(
          (greatest, subPackage) => {
            if (subPackage.package.version && !subPackage.package.private) {
              return gt(greatest.version!, subPackage.package.version)
                ? greatest
                : subPackage.package;
            }

            return greatest;
          },
          { version: '0.0.0' } as IPackageJSON
        );

        if (!releasedPackage) {
          previousVersion = monorepoVersion;
        } else {
          previousVersion = await greaterRelease(
            prefixRelease,
            releasedPackage.name,
            monorepoVersion
          );
        }
      } else if (fs.existsSync('package.json')) {
        auto.logger.veryVerbose.info(
          'Using package.json to calculate previous version'
        );
        const { version, name } = JSON.parse(
          await readFile('package.json', 'utf-8')
        );

        previousVersion = await greaterRelease(
          prefixRelease,
          name,
          prefixRelease(version)
        );
      }

      auto.logger.verbose.info(
        'NPM: Got previous version from package.json',
        previousVersion
      );

      return previousVersion;
    });

    auto.hooks.getRepository.tapPromise('NPM', async () => {
      auto.logger.verbose.info(
        'NPM: getting repo information from package.json'
      );
      return getConfigFromPackageJson();
    });

    auto.hooks.renderChangelogLine.tapPromise(
      'NPM',
      async (commits, renderLine) => {
        if (isMonorepo()) {
          await Promise.all(
            commits.map(async commit => {
              commit.packages = await changedPackages(commit.hash, auto.logger);
            })
          );

          const packageCommits = partitionPackages(commits, renderLine);
          const pkgCount = Object.keys(packageCommits).length;
          const hasRepoCommits =
            packageCommits.monorepo && packageCommits.monorepo.length > 0;

          if (pkgCount > 0 && (pkgCount !== 1 || !packageCommits.monorepo)) {
            const section: string[] = [];

            if (hasRepoCommits) {
              packageCommits.monorepo.forEach(note => section.push(note));
              delete packageCommits.monorepo;
            }

            Object.entries(packageCommits).map(([pkg, lines]) => {
              section.push(`- ${pkg}`);
              lines.map(note => section.push(`  ${note}`));
            });

            return section;
          }
        }
      }
    );

    auto.hooks.publish.tapPromise('NPM', async (version: SEMVER) => {
      if (isMonorepo()) {
        await execPromise('npx', [
          'lerna',
          'publish',
          '--yes',
          '--force-publish=*',
          version,
          '-m',
          "'%v [skip ci]'"
        ]);
      } else {
        await execPromise('npm', [
          'version',
          version,
          '-m',
          '"Bump version to: %s [skip ci]"'
        ]);
        await execPromise('npm', ['publish']);
        await execPromise('git', [
          'push',
          '--follow-tags',
          '--set-upstream',
          'origin',
          '$branch'
        ]);
      }
    });
  }
}
