/** Install `ferry tunnel --follow` for one box under the platform user service manager. */

import {
  installUserService,
  uninstallUserService,
  type UserService,
  type WatchServiceDependencies,
  type WatchServiceInput,
  type WatchServiceResult,
} from "./watch-service.ts";

export type TunnelServiceInput = WatchServiceInput & {
  /** A valid box name, so it is safe in file names and the launchd label. */
  readonly box: string;
};

export type TunnelServiceUninstallResult = WatchServiceResult & { readonly removed: boolean };

/** Each box has its own service. The service names the box, so a later default_box does not change it. */
export function tunnelService(box: string): UserService {
  return {
    command: "tunnel",
    label: `dev.ferry.tunnel.${box}`,
    log: `ferry-tunnel-${box}.log`,
    unit: `ferry-tunnel-${box}.service`,
    description: `Ferry tunnel --follow for ${box}`,
    args: ["tunnel", "--follow", "--box", box],
    // The follow connects again after a drop. The service starts it again after each exit.
    restart: "always",
  };
}

export function installTunnelService(
  input: TunnelServiceInput,
  dependencies: WatchServiceDependencies = {},
): Promise<WatchServiceResult> {
  const { box, ...rest } = input;
  return installUserService(tunnelService(box), rest, dependencies);
}

export function uninstallTunnelService(
  input: TunnelServiceInput,
  dependencies: WatchServiceDependencies = {},
): Promise<TunnelServiceUninstallResult> {
  const { box, ...rest } = input;
  return uninstallUserService(tunnelService(box), rest, dependencies);
}
