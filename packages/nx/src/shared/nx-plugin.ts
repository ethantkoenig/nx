import { sync } from 'fast-glob';
import { existsSync } from 'fs';
import * as path from 'path';

import { appRootPath } from '../utils/app-root';
import { readJsonFile } from '../utils/fileutils';
import { registerTsProject } from '../utils/register';
import { PackageJson } from './package-json';
import { ProjectGraphProcessor } from './project-graph';
import { Workspaces } from './workspace';
import {
  ProjectConfiguration,
  TargetConfiguration,
  WorkspaceJsonConfiguration,
} from './workspace.model';

export type ProjectTargetConfigurator = (
  file: string
) => Record<string, TargetConfiguration>;

/**
 * A plugin for Nx
 */
export interface NxPlugin {
  name: string;
  processProjectGraph?: ProjectGraphProcessor;
  registerProjectTargets?: ProjectTargetConfigurator;

  /**
   * A glob pattern to search for non-standard project files.
   * @example: ["*.csproj", "pom.xml"]
   */
  projectFilePatterns?: string[];
}

// Short lived cache (cleared between cmd runs)
// holding resolved nx plugin objects.
// Allows loadNxPlugins to be called multiple times w/o
// executing resolution mulitple times.
let nxPluginCache: NxPlugin[] = null;
export function loadNxPlugins(
  plugins?: string[],
  paths = [appRootPath]
): NxPlugin[] {
  return plugins?.length
    ? nxPluginCache ||
        (nxPluginCache = plugins.map((moduleName) => {
          let pluginPath: string;
          try {
            pluginPath = require.resolve(moduleName, {
              paths,
            });
          } catch (e) {
            if (e.code === 'MODULE_NOT_FOUND') {
              const plugin = resolveLocalNxPlugin(moduleName);
              const main = readPluginMainFromProjectConfiguration(
                plugin.projectConfig
              );
              pluginPath = main ? path.join(appRootPath, main) : plugin.path;
            } else {
              throw e;
            }
          }
          const packageJsonPath = path.join(pluginPath, 'package.json');
          const { name } =
            !['.ts', '.js'].some((x) => x === path.extname(pluginPath)) && // Not trying to point to a ts or js file
            existsSync(packageJsonPath) // plugin has a package.json
              ? readJsonFile(packageJsonPath) // read name from package.json
              : { name: path.basename(pluginPath) }; // use the name of the file we point to
          const plugin = require(pluginPath) as NxPlugin;
          plugin.name = name;

          return plugin;
        }))
    : [];
}

export function mergePluginTargetsWithNxTargets(
  projectRoot: string,
  targets: Record<string, TargetConfiguration>,
  plugins: NxPlugin[]
): Record<string, TargetConfiguration> {
  let newTargets: Record<string, TargetConfiguration> = {};
  for (const plugin of plugins) {
    if (!plugin.projectFilePatterns?.length || !plugin.registerProjectTargets) {
      continue;
    }

    const projectFiles = sync(`+(${plugin.projectFilePatterns.join('|')})`, {
      cwd: path.join(appRootPath, projectRoot),
    });
    for (const projectFile of projectFiles) {
      newTargets = {
        ...newTargets,
        ...plugin.registerProjectTargets(path.join(projectRoot, projectFile)),
      };
    }
  }
  return { ...newTargets, ...targets };
}

export function readPluginPackageJson(
  pluginName: string,
  paths = [appRootPath]
): {
  path: string;
  json: PackageJson;
} {
  let packageJsonPath: string;
  try {
    packageJsonPath = require.resolve(`${pluginName}/package.json`, {
      paths,
    });
  } catch (e) {
    if (e.code === 'MODULE_NOT_FOUND') {
      const localPluginPath = resolveLocalNxPlugin(pluginName);
      if (localPluginPath) {
        const localPluginPackageJson = path.join(
          localPluginPath.path,
          'package.json'
        );
        return {
          path: localPluginPackageJson,
          json: readJsonFile(localPluginPackageJson),
        };
      }
    }
    throw e;
  }
  return { json: readJsonFile(packageJsonPath), path: packageJsonPath };
}

/**
 * Builds a plugin package and returns the path to output
 * @param importPath What is the import path that refers to a potential plugin?
 * @returns The path to the built plugin, or null if it doesn't exist
 */
const localPluginCache: Record<
  string,
  { path: string; projectConfig: ProjectConfiguration }
> = {};
export function resolveLocalNxPlugin(
  importPath: string,
  root = appRootPath
): { path: string; projectConfig: ProjectConfiguration } | null {
  localPluginCache[importPath] ??= lookupLocalPlugin(importPath, root);
  return localPluginCache[importPath];
}

let tsNodeAndPathsRegistered = false;
function registerTSTranspiler() {
  if (!tsNodeAndPathsRegistered) {
    registerTsProject(appRootPath, 'tsconfig.base.json');
  }
  tsNodeAndPathsRegistered = true;
}

function lookupLocalPlugin(importPath: string, root = appRootPath) {
  const workspace = new Workspaces(root).readWorkspaceConfiguration({
    _ignorePluginInference: true,
  });
  const plugin = findNxProjectForImportPath(importPath, workspace, root);
  if (!plugin) {
    return null;
  }

  if (!tsNodeAndPathsRegistered) {
    registerTSTranspiler();
  }

  const projectConfig = workspace.projects[plugin];
  return { path: path.join(root, projectConfig.root), projectConfig };
}

function findNxProjectForImportPath(
  importPath: string,
  workspace: WorkspaceJsonConfiguration,
  root = appRootPath
): string | null {
  const tsConfigPaths: Record<string, string[]> = readTsConfigPaths(root);
  const possiblePaths = tsConfigPaths[importPath]?.map((p) =>
    path.resolve(root, p)
  );
  if (tsConfigPaths[importPath]) {
    const projectRootMappings = Object.entries(workspace.projects).reduce(
      (m, [project, config]) => {
        m[path.resolve(root, config.root)] = project;
        return m;
      },
      {}
    );
    for (const root of Object.keys(projectRootMappings)) {
      if (possiblePaths.some((p) => p.startsWith(root))) {
        return projectRootMappings[root];
      }
    }
    if (process.env.NX_VERBOSE_LOGGING) {
      console.log(
        'Unable to find local plugin',
        possiblePaths,
        projectRootMappings
      );
    }
    throw new Error(
      'Unable to resolve local plugin with import path ' + importPath
    );
  }
}

let tsconfigPaths: Record<string, string[]>;
function readTsConfigPaths(root: string = appRootPath) {
  if (!tsconfigPaths) {
    const tsconfigPath: string | null = ['tsconfig.base.json', 'tsconfig.json']
      .map((x) => path.join(root, x))
      .filter((x) => existsSync(x))[0];
    if (!tsconfigPath) {
      throw new Error('unable to find tsconfig.base.json or tsconfig.json');
    }
    const { compilerOptions } = readJsonFile(tsconfigPath);
    tsconfigPaths = compilerOptions?.paths;
  }
  return tsconfigPaths;
}

function readPluginMainFromProjectConfiguration(
  plugin: ProjectConfiguration
): string | null {
  const { main } =
    Object.values(plugin.targets).find((x) =>
      ['@nrwl/js:tsc', '@nrwl/js:swc', '@nrwl/node:package'].includes(
        x.executor
      )
    )?.options ||
    plugin.targets?.build?.options ||
    {};
  return main;
}
