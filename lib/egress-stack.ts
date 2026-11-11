import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { DerropsConventions } from 'derrops-conventions';

/**
 * Design-time naming segments for the region egress stack. The route itself
 * has no name or tags in CloudFormation; the S3 gateway endpoint's `Name` tag
 * and the stack name come from this instance.
 */
export const naming = new DerropsConventions({
  org: 'derrops',
  domain: 'region',
  service: 'egress',
}).tagPrefix('derrops:');

/**
 * Where the private tier's internet-bound traffic goes.
 *
 * Only a NAT instance today: the region bastion. To move to a managed NAT
 * Gateway later, add a `{ kind: 'natGateway' }` variant here that creates the
 * Elastic IP and `AWS::EC2::NatGateway` in a public subnet, and point the route
 * at it. Changing a route's target is an in-place update, so the switch is one
 * deploy of this stack with no gap in egress.
 */
export type EgressTarget = {
  readonly kind: 'instance';
  /** A NAT instance with its source/destination check off (`BastionStack`). */
  readonly instance: ec2.CfnInstance;
};

export interface EgressStackProps extends cdk.StackProps {
  /** The region VPC (from `VpcStack`), for the S3 gateway endpoint. */
  readonly vpc: ec2.CfnVPC;
  /**
   * The private tier's route table (`VpcStack.privateRouteTable`). This stack
   * owns its `0.0.0.0/0` route; nothing else may add one, since a route table
   * holds only one route per destination.
   */
  readonly privateRouteTable: ec2.CfnRouteTable;
  /** Where the private tier's default route points. */
  readonly target: EgressTarget;
}

/**
 * Outbound internet access for the region VPC's **private** tier, which
 * `VpcStack` deliberately creates with no default route (no NAT Gateway, for
 * cost).
 *
 * ## Why a stack of its own
 *
 * The private tier's `0.0.0.0/0` route has exactly one owner, and it is this
 * stack. If the bastion stack owned it, moving to a NAT Gateway in another stack
 * would need two deploys with no egress in between, because the new stack can't
 * add a second route for the same destination while the old one exists. Here,
 * changing the egress is an edit to `target` and one deploy.
 *
 * ## What it creates
 *
 *   - The private tier's default route, to the `target`. Today that's the
 *     bastion, used as a NAT instance: it already sits in a public subnet with
 *     an Elastic IP, costs nothing extra, and the private tier's main consumer
 *     (the derrops-cloud API Lambda) already depends on it for Postgres and
 *     OpenSearch. The NAT itself (`ip_forward` and a `MASQUERADE` rule) is set
 *     up by hand on the box; see `docs/derrops--region--egress.md`.
 *   - An **S3 gateway endpoint** on the private route table. Gateway endpoints
 *     are free, and this keeps S3 traffic off the NAT.
 *
 * The isolated tier is untouched: it has no internet route in either
 * direction, by design.
 */
export class EgressStack extends cdk.Stack {
  /** The private tier's default route. */
  public readonly defaultRoute: ec2.CfnRoute;
  /** The S3 gateway endpoint on the private route table. */
  public readonly s3Endpoint: ec2.CfnVPCEndpoint;

  constructor(scope: Construct, id: string, props: EgressStackProps) {
    super(scope, id, {
      ...props,
      stackName: props.stackName ?? naming.name({ type: 'cloudFormationStack' }),
    });

    naming.applyTags((k, v) => this.addStackTag(k, v));
    naming.applyTags((k, v) => cdk.Tags.of(this).add(k, v));

    // The S3 service name is built from the region, so an env-agnostic stack
    // can't work. Fail here rather than emit `com.amazonaws.${Token}.s3`.
    if (cdk.Token.isUnresolved(this.region)) {
      throw new Error(
        'EgressStack requires a concrete region — pass env.region (the app takes it from `-c region=<aws-region>`).',
      );
    }

    // ── Private tier default route ──────────────────────────────────────────
    this.defaultRoute = new ec2.CfnRoute(this, 'PrivateDefaultRoute', {
      routeTableId: props.privateRouteTable.ref,
      destinationCidrBlock: '0.0.0.0/0',
      instanceId: props.target.instance.ref,
    });

    // ── S3 gateway endpoint ─────────────────────────────────────────────────
    const endpointName = naming.name({ type: 'vpcEndpoint' });
    this.s3Endpoint = new ec2.CfnVPCEndpoint(this, 'S3GatewayEndpoint', {
      vpcId: props.vpc.ref,
      serviceName: `com.amazonaws.${this.region}.s3`,
      vpcEndpointType: 'Gateway',
      routeTableIds: [props.privateRouteTable.ref],
    });
    cdk.Tags.of(this.s3Endpoint).add('Name', endpointName);
  }
}
