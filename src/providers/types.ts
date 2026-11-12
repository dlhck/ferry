/** The interface of a cloud provider for `ferry box create` and `ferry box destroy`. */

/** The label that marks a machine of Ferry. Its value is the box name. */
export const BOX_LABEL = "ferry-box";

/** What Ferry asks the provider to create. */
export type MachineSpec = {
  /** The box name. The provider puts it in the `ferry-box` label of the machine. */
  readonly box: string;
  readonly serverType: string;
  readonly image: string;
  readonly location: string;
  /** The public SSH key of the operator, one OpenSSH line. The machine gets no password login. */
  readonly sshPublicKey: string;
  /** The cloud-init user data. The provider stores it, so it must hold no secret. */
  readonly userData: string;
};

/** A machine that the provider created for a box. */
export type Machine = {
  /** The id of the machine at the provider. */
  readonly id: string;
  /** The name of the machine at the provider. */
  readonly name: string;
  /** The value of the `ferry-box` label. */
  readonly box: string;
  readonly ipv4: string | null;
  readonly ipv6: string | null;
  readonly serverType: string;
  readonly location: string;
};

/** The size and price of a server type in a location, for the plan. */
export type MachineType = {
  readonly name: string;
  readonly cores: number;
  readonly memoryGb: number;
  readonly diskGb: number;
  readonly architecture: string;
  /** The gross price for one month in the location, such as "8.99", or null when the provider has no price. */
  readonly monthlyPrice: string | null;
  readonly currency: string;
};

/**
 * A cloud provider. Each call uses the token of the operator, and no error
 * message has the token.
 */
export interface Provider {
  readonly id: string;
  /** The name for the output, such as "Hetzner Cloud". */
  readonly label: string;
  /** The server type in the location. It throws when the provider does not have it. */
  machineType(serverType: string, location: string): Promise<MachineType>;
  /** Create the machine and return when it runs. */
  create(spec: MachineSpec): Promise<Machine>;
  /**
   * Remove the machine and the resources that `create` made for it alone. It
   * throws when the machine stays. It returns a warning for each other resource that stays.
   */
  destroy(machine: Machine): Promise<string[]>;
  /** The machines with the `ferry-box` label. */
  list(): Promise<Machine[]>;
}
