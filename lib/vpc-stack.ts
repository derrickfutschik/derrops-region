import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { DerropsConventions } from 'derrops-conventions';

/**
 * Design-time naming segments for the region VPC stack. All resource names
 * (VPC, subnets, route tables, NACL, SSM params, the stack name, and the CDK
 * construct id in `bin/`) are generated from this single instance via
 * `derrops-conventions` — never hand-assembled.
 *
 * The network topology is domain-scoped: `subnet` / `networkAcl` / `routeTable`
 * names carry `org`+`domain` (+`kind`/`az`), not `service`, so the `service:
 * 'network'` segment above only names the stack itself. A single region-wide
 * network domain (`region`) partitions the address space.
 *
 * The names are deliberately *not* region-qualified. Everything named here —
 * the CloudFormation stack, VPC, subnets, route tables, NACL, SSM parameters —
 * is scoped to a region by AWS, so the identical name in `us-east-1` and
 * `ap-southeast-2` refers to two independent resources and never collides.
 */
export const naming = new DerropsConventions({
  org: 'derrops',
  domain: 'region',
  service: 'network',
}).tagPrefix('derrops:');

/** The single network domain the region VPC's address space is carved into. */
const NETWORK_DOMAIN = 'region';

/** Subnet tiers, in CIDR-slot order. Append-only — never insert or reorder. */
const SUBNET_KINDS = ['private', 'public', 'isolated'] as const;

export interface VpcStackProps extends cdk.StackProps {
  /**
   * VPC CIDR block. A /16 gives each network domain a /20 (4096 addresses),
   * each tier a /22, and each per-AZ subnet a /24.
   *
   * @default '10.0.0.0/16'
   */
  readonly vpcCidr?: string;

  /**
   * Availability-zone suffixes to spread subnets across, e.g. `['1a', '1b', '1c']`
   * for `us-east-1a` / `us-east-1b` / `us-east-1c`. Array position is the CIDR
   * slot: **append** a further AZ later and every existing subnet keeps its
   * CIDR — CloudFormation only provisions the new ones.
   *
   * The suffix carries the region's **AZ-group number**, which differs per
   * region (`1a` in `us-east-1`, `2a` in `ap-southeast-2`), so the default is
   * derived from the stack's region rather than being a constant. Only override
   * this to change the *number* of AZs or their order — if you hardcode a group
   * number you will pin the stack to one region.
   *
   * @default the region's first three AZs — e.g. `['1a','1b','1c']` in
   * `us-east-1`, `['2a','2b','2c']` in `ap-southeast-2`.
   */
  readonly availabilityZoneSuffixes?: string[];
}

/**
 * The region's shared VPC, with all three subnet tiers (`private`, `public`,
 * `isolated`), sized and named by `derrops-conventions`. One VPC per region you
 * light up — not per application, and not per account. Deploy this stack again
 * with a different `-c region=` to stand up the next region; the CIDR plan is
 * identical in each, since the VPCs never peer by default.
 *
 * ## Cost model: IGW yes, NAT no
 *
 * The stack creates exactly one **Internet Gateway** (free — you pay only for
 * data transfer, which you'd pay regardless) and **no NAT Gateways**. A NAT
 * Gateway is ~$0.045/hr (~$32/mo) plus $0.045/GB processed; for an account
 * whose primary tenant is a single small relay box, that would dominate the
 * bill for no benefit. Consequently:
 *
 *   - `public`  subnets route `0.0.0.0/0` → IGW (in + out).
 *   - `private` subnets get a route table with **no default route**. To give
 *     the private tier outbound later, pick the cheapest option that fits:
 *       • an **egress-only IGW** (free, but IPv6-only — requires enabling IPv6);
 *       • routing `0.0.0.0/0` through the Tailscale box as a NAT/subnet router;
 *       • a NAT **instance** (a tiny EC2 running NAT — ~$3–4/mo);
 *       • a managed **NAT Gateway** (simplest, but the ~$32/mo option).
 *   - `isolated` subnets have no internet route in either direction (databases,
 *     caches) — reachable only from within the VPC.
 *
 * ## Where the Tailscale relay EC2 should go (NOT created here)
 *
 * Run the small Tailscale EC2 in a **`public` subnet** — the SSM parameter
 * `.../tailscale-relay-subnet-id` (in this region) points at the recommended
 * one. Rationale:
 *
 *   - Tailscale is **outbound-initiated** (WireGuard to the coordination server
 *     + DERP relays), so a public subnet reaches the internet via the free IGW
 *     — no NAT Gateway needed. This is the cost-optimal placement.
 *   - A public IP improves NAT traversal, so Tailscale forms **direct** encrypted
 *     tunnels instead of relaying via DERP (lower latency, less relay traffic).
 *     The public IPv4 charge (~$3.6/mo) is far below any NAT option.
 *   - Its security group needs **no inbound rules** from the internet (optionally
 *     UDP 41641 to aid direct connections; Tailscale falls back to DERP without
 *     it). Allow all egress.
 *   - As a Tailscale **subnet router / exit node**, the box advertises routes so
 *     tailnet peers (including your local dev server) can reach VPC-internal
 *     `private` / `isolated` resources, and it exposes the local dev server's
 *     services onto the tailnet — all while sitting in the cheap public tier and
 *     reaching the other tiers over the VPC's internal routing.
 *
 * A future stack creates the instance; it discovers where to launch via the
 * exposed `publicSubnets` (in-app, by reference) or the SSM parameters below
 * (out-of-app).
 */
export class VpcStack extends cdk.Stack {
  /** The region VPC — consumers receive it by reference. */
  public readonly vpc: ec2.CfnVPC;
  /** Public-tier subnets (IGW-routed) — where the Tailscale relay should run. */
  public readonly publicSubnets: ec2.CfnSubnet[] = [];
  /** Private-tier subnets (no default route by default; see class docs). */
  public readonly privateSubnets: ec2.CfnSubnet[] = [];
  /** Isolated-tier subnets (no internet route at all). */
  public readonly isolatedSubnets: ec2.CfnSubnet[] = [];

  constructor(scope: Construct, id: string, props: VpcStackProps = {}) {
    super(scope, id, {
      ...props,
      stackName: props.stackName ?? naming.name({ type: 'cloudFormationStack' }),
    });

    naming.applyTags((k, v) => this.addStackTag(k, v));
    // Standard org tags (derrops:domain / derrops:service) on every resource.
    naming.applyTags((k, v) => cdk.Tags.of(this).add(k, v));

    const vpcCidr = props.vpcCidr ?? '10.0.0.0/16';

    // Every AZ name below is built from the concrete region, so an env-agnostic
    // stack (where `this.region` is an unresolved token) cannot work. Fail here
    // rather than emitting a template with garbage availability zones.
    if (cdk.Token.isUnresolved(this.region)) {
      throw new Error(
        'VpcStack requires a concrete region — pass env.region (the app takes it from `-c region=<aws-region>`).',
      );
    }

    // The AZ suffix carries the region's AZ-group number ('1a' in us-east-1,
    // '2a' in ap-southeast-2), so the default must come from the region. A
    // constant here would build `ap-southeast-1a` in ap-southeast-2 — a real AZ
    // in a *different* region, which fails the deploy rather than misbehaving
    // quietly, but only after the stack is half rolled out.
    const azGroup = this.region.match(/\d+$/)?.[0];
    if (!azGroup) {
      throw new Error(
        `Cannot derive an AZ group from region '${this.region}'; pass availabilityZoneSuffixes explicitly.`,
      );
    }
    const azSuffixes =
      props.availabilityZoneSuffixes ?? ['a', 'b', 'c'].map((l) => `${azGroup}${l}`);

    // Template validation warns (W3010) about the literal AZ names on the
    // subnets below. Its advice — `Fn::GetAZs` or an AZ parameter — is wrong for
    // this stack: array position in `azSuffixes` *is* the CIDR slot, so a subnet
    // must land in the same zone on every deploy, and `Fn::GetAZs` returns an
    // order AWS does not guarantee (it would silently re-shuffle CIDRs across
    // zones). The names are still region-derived, never hardcoded in source.
    cdk.Validations.of(this).acknowledge({
      id: 'CloudFormation-Validate::W3010',
      reason:
        'Subnet AZ names are derived from the stack region and deliberately pinned per CIDR slot.',
    });

    // Full name + stable-CIDR plan for the whole VPC. `subnet` is a naming-only
    // convention Resource, but building it currently requires an ARN context
    // (see TODO(topology-resource-arn) upstream) — the account id is never used
    // to build an ARN here, only to satisfy that requirement.
    const plan = naming
      .domain([NETWORK_DOMAIN])
      .arnContext({ accountId: this.account })
      .topology({
        vpcCidr,
        azs: azSuffixes,
        kinds: [...SUBNET_KINDS],
      });

    // The AZ suffix (e.g. '1a') already carries the region's AZ-group number, so
    // the full AZ name is the region with its trailing digits stripped + suffix:
    // 'us-east-1' → 'us-east-' + '1a' = 'us-east-1a'. (Do NOT concatenate the raw
    // region + suffix.)
    const azBase = this.region.replace(/\d+$/, '');
    const azNameFor = (suffix: string) => `${azBase}${suffix}`;

    // ── VPC ────────────────────────────────────────────────────────────────
    this.vpc = new ec2.CfnVPC(this, plan.vpc.name, {
      cidrBlock: plan.vpc.cidr,
      enableDnsHostnames: true,
      enableDnsSupport: true,
    });
    cdk.Tags.of(this.vpc).add('Name', plan.vpc.name);

    // ── Internet Gateway (public tier only) ────────────────────────────────
    const igw = new ec2.CfnInternetGateway(this, `${plan.vpc.name}--igw`, {});
    cdk.Tags.of(igw).add('Name', `${plan.vpc.name}--igw`);
    new ec2.CfnVPCGatewayAttachment(this, `${plan.vpc.name}--igw-attach`, {
      vpcId: this.vpc.ref,
      internetGatewayId: igw.ref,
    });

    const domain = plan.domains[NETWORK_DOMAIN]!;

    // ── Network ACL (one per network domain) ───────────────────────────────
    const nacl = new ec2.CfnNetworkAcl(this, domain.nacl, { vpcId: this.vpc.ref });
    cdk.Tags.of(nacl).add('Name', domain.nacl);

    // A *custom* NACL (unlike the VPC default) starts with only the implicit
    // `deny *` rules, so an entry-less NACL blocks ALL traffic in and out of
    // every associated subnet — nothing reaches the internet or vice versa.
    // Add allow-all entries in both directions and let the (stateful) security
    // groups be the real control. NACLs are stateless, so a one-directional
    // rule would also require the matching ephemeral-port return rule; allow-all
    // both ways sidesteps that trap. Rule 100 sits before the implicit deny.
    for (const [dir, egress] of [['in', false], ['out', true]] as const) {
      new ec2.CfnNetworkAclEntry(this, `${domain.nacl}--allow-all-${dir}`, {
        networkAclId: nacl.ref,
        ruleNumber: 100,
        protocol: -1, // -1 = all protocols
        ruleAction: 'allow',
        egress,
        cidrBlock: '0.0.0.0/0',
      });
    }

    const subnetsByKind: Record<string, ec2.CfnSubnet[]> = {
      private: this.privateSubnets,
      public: this.publicSubnets,
      isolated: this.isolatedSubnets,
    };

    for (const kind of SUBNET_KINDS) {
      // ── Route table (one per tier) ───────────────────────────────────────
      const rtName = domain.routeTables[kind]!;
      const routeTable = new ec2.CfnRouteTable(this, rtName, { vpcId: this.vpc.ref });
      cdk.Tags.of(routeTable).add('Name', rtName);

      // Only the public tier gets a default route — to the free IGW. The
      // private and isolated tiers are intentionally left with no 0.0.0.0/0
      // route (no NAT Gateway); see the class docs for how to add egress later.
      if (kind === 'public') {
        new ec2.CfnRoute(this, `${rtName}--default`, {
          routeTableId: routeTable.ref,
          destinationCidrBlock: '0.0.0.0/0',
          gatewayId: igw.ref,
        });
      }

      // ── Subnets (one per AZ) ─────────────────────────────────────────────
      for (const { resource, cidr, az } of domain.subnets[kind]!) {
        const subnet = new ec2.CfnSubnet(this, resource.name, {
          vpcId: this.vpc.ref,
          cidrBlock: cidr,
          availabilityZone: azNameFor(az),
          // Only public subnets auto-assign a public IP on launch.
          mapPublicIpOnLaunch: kind === 'public',
        });
        // Tag from the subnet's own segments (adds kind/az beyond the stack tags).
        resource.applyTags((k, v) => cdk.Tags.of(subnet).add(k, v));
        cdk.Tags.of(subnet).add('Name', resource.name);

        new ec2.CfnSubnetRouteTableAssociation(this, `${resource.name}--rta`, {
          subnetId: subnet.ref,
          routeTableId: routeTable.ref,
        });
        new ec2.CfnSubnetNetworkAclAssociation(this, `${resource.name}--nacl`, {
          subnetId: subnet.ref,
          networkAclId: nacl.ref,
        });

        subnetsByKind[kind]!.push(subnet);
      }
    }

    // ── Discovery for out-of-app areas (SDK/CLI read at runtime) ────────────
    // Derived values that track the stack → plain StringParameters (not the
    // create-if-absent SeedParameter, which is for editable config).
    // The per-tier subnet ids are a list, so publish them as `StringList`
    // parameters — the SSM SDK/CLI hands the reader back an array instead of a
    // string they have to split. (CloudFormation still stores the underlying
    // value comma-joined; the type is what makes it a list to consumers.)
    const ids = (subnets: ec2.CfnSubnet[]) => subnets.map((s) => s.ref);

    new ssm.StringParameter(this, 'VpcIdParam', {
      parameterName: naming.name({ type: 'ssmParam', key: 'vpc-id' }),
      stringValue: this.vpc.ref,
      description: 'ID of the region VPC.',
    });
    new ssm.StringListParameter(this, 'PublicSubnetIdsParam', {
      parameterName: naming.name({ type: 'ssmParam', key: 'subnet-ids', purpose: 'public' }),
      stringListValue: ids(this.publicSubnets),
      description: 'IDs of the region VPC public subnets.',
    });
    new ssm.StringListParameter(this, 'PrivateSubnetIdsParam', {
      parameterName: naming.name({ type: 'ssmParam', key: 'subnet-ids', purpose: 'private' }),
      stringListValue: ids(this.privateSubnets),
      description: 'IDs of the region VPC private subnets.',
    });
    new ssm.StringListParameter(this, 'IsolatedSubnetIdsParam', {
      parameterName: naming.name({ type: 'ssmParam', key: 'subnet-ids', purpose: 'isolated' }),
      stringListValue: ids(this.isolatedSubnets),
      description: 'IDs of the region VPC isolated subnets.',
    });
    // Encode the "run the Tailscale relay here" recommendation as a concrete,
    // machine-readable pointer at the first public subnet.
    new ssm.StringParameter(this, 'TailscaleRelaySubnetIdParam', {
      parameterName: naming.name({ type: 'ssmParam', key: 'tailscale-relay-subnet-id' }),
      stringValue: this.publicSubnets[0]!.ref,
      description:
        'Recommended subnet for the Tailscale relay/subnet-router EC2 — a public ' +
        'subnet (free IGW egress, direct WireGuard via public IP, no NAT Gateway).',
    });
  }
}
