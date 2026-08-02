import * as cdk from 'aws-cdk-lib/core';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { VpcStack } from '../lib/vpc-stack';

const env = { account: '123456789012', region: 'us-east-1' };

function synth(props: Partial<ConstructorParameters<typeof VpcStack>[2]> = {}) {
  const app = new cdk.App();
  const stack = new VpcStack(app, 'TestVpcStack', { env, ...props });
  return Template.fromStack(stack);
}

test('creates a /16 VPC with DNS enabled', () => {
  const template = synth();
  template.resourceCountIs('AWS::EC2::VPC', 1);
  template.hasResourceProperties('AWS::EC2::VPC', {
    CidrBlock: '10.0.0.0/16',
    EnableDnsHostnames: true,
    EnableDnsSupport: true,
  });
});

test('creates all three subnet tiers across three AZs (9 subnets)', () => {
  const template = synth();
  // 3 kinds x 3 AZs.
  template.resourceCountIs('AWS::EC2::Subnet', 9);
  // Convention-named, correctly-CIDR'd, correctly-AZ'd subnets per tier.
  template.hasResourceProperties('AWS::EC2::Subnet', {
    CidrBlock: '10.0.0.0/24',
    AvailabilityZone: 'us-east-1a',
    MapPublicIpOnLaunch: false, // private
    Tags: Match.arrayWith([{ Key: 'Name', Value: 'derrops--region--private--1a' }]),
  });
  template.hasResourceProperties('AWS::EC2::Subnet', {
    CidrBlock: '10.0.4.0/24',
    AvailabilityZone: 'us-east-1a',
    MapPublicIpOnLaunch: true, // public
    Tags: Match.arrayWith([{ Key: 'Name', Value: 'derrops--region--public--1a' }]),
  });
  template.hasResourceProperties('AWS::EC2::Subnet', {
    CidrBlock: '10.0.8.0/24',
    MapPublicIpOnLaunch: false, // isolated
    Tags: Match.arrayWith([{ Key: 'Name', Value: 'derrops--region--isolated--1a' }]),
  });
});

test('is cost-optimized: an Internet Gateway but no NAT Gateways', () => {
  const template = synth();
  template.resourceCountIs('AWS::EC2::InternetGateway', 1);
  template.resourceCountIs('AWS::EC2::VPCGatewayAttachment', 1);
  // The whole point of the cost model: no NAT Gateways.
  template.resourceCountIs('AWS::EC2::NatGateway', 0);
});

test('only the public tier has a default route, and it points at the IGW', () => {
  const template = synth();
  // Exactly one 0.0.0.0/0 route in the whole VPC (the public tier's IGW route);
  // private and isolated tiers deliberately have none.
  template.resourceCountIs('AWS::EC2::Route', 1);
  template.hasResourceProperties('AWS::EC2::Route', {
    DestinationCidrBlock: '0.0.0.0/0',
    GatewayId: Match.anyValue(),
  });
  // One route table per tier.
  template.resourceCountIs('AWS::EC2::RouteTable', 3);
});

test('publishes discovery params, including the Tailscale relay subnet pointer', () => {
  const template = synth();
  template.hasResourceProperties('AWS::SSM::Parameter', {
    Name: '/derrops/region/network/vpc-id',
    Type: 'String',
  });
  // The per-tier subnet ids are published as StringList, not a String the
  // reader has to split.
  for (const tier of ['public', 'private', 'isolated']) {
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: `/derrops/region/network/subnet-ids/${tier}`,
      Type: 'StringList',
    });
  }
  // The recommendation ("run the Tailscale box in a public subnet") is encoded
  // as a concrete pointer, not just prose.
  template.hasResourceProperties('AWS::SSM::Parameter', {
    Name: '/derrops/region/network/tailscale-relay-subnet-id',
  });
});

test('every subnet is wired to a route table and the single domain NACL', () => {
  const template = synth();
  // One NACL for the whole network domain.
  template.resourceCountIs('AWS::EC2::NetworkAcl', 1);
  // Each of the 9 subnets gets exactly one route-table + one NACL association.
  template.resourceCountIs('AWS::EC2::SubnetRouteTableAssociation', 9);
  template.resourceCountIs('AWS::EC2::SubnetNetworkAclAssociation', 9);
});

test('the custom NACL has allow-all entries in both directions', () => {
  const template = synth();
  // A custom NACL defaults to deny-all; without these entries every subnet is
  // cut off from the internet. One inbound + one outbound allow-all rule.
  template.resourceCountIs('AWS::EC2::NetworkAclEntry', 2);
  for (const egress of [false, true]) {
    template.hasResourceProperties('AWS::EC2::NetworkAclEntry', {
      RuleNumber: 100,
      Protocol: -1,
      RuleAction: 'allow',
      Egress: egress,
      CidrBlock: '0.0.0.0/0',
    });
  }
});

test('resources carry the derrops org tags and convention Name tags', () => {
  const template = synth();
  // Each tag asserted independently (arrayWith matches an ordered subsequence,
  // and CDK does not emit tags in the order we add them).
  for (const tag of [
    { Key: 'Name', Value: 'derrops' },
    { Key: 'derrops:domain', Value: 'region' },
    { Key: 'derrops:service', Value: 'network' },
  ]) {
    template.hasResourceProperties('AWS::EC2::VPC', {
      Tags: Match.arrayWith([tag]),
    });
  }
});

test('appending a fourth AZ keeps the three default AZs and adds one tier x AZ each', () => {
  const template = synth({ availabilityZoneSuffixes: ['1a', '1b', '1c', '1d'] });
  template.resourceCountIs('AWS::EC2::Subnet', 12); // 3 kinds x 4 AZs
  template.hasResourceProperties('AWS::EC2::Subnet', {
    // Appended AZ keeps existing CIDRs stable; the new private 1d lands at +3 /24.
    CidrBlock: '10.0.3.0/24',
    AvailabilityZone: 'us-east-1d',
    Tags: Match.arrayWith([{ Key: 'Name', Value: 'derrops--region--private--1d' }]),
  });
});

// ── Region portability ──────────────────────────────────────────────────────
// The AZ suffix carries the region's AZ-group number, so a constant default
// ('1a') would build `ap-southeast-1a` here — a real AZ in a *different*
// region. These guard the stack's deployability outside us-east-1.

function synthIn(region: string) {
  const app = new cdk.App();
  const stack = new VpcStack(app, 'RegionalVpcStack', {
    env: { account: '123456789012', region },
  });
  return Template.fromStack(stack);
}

test('derives AZ names from the target region, not a hardcoded AZ group', () => {
  const template = synthIn('ap-southeast-2');
  template.resourceCountIs('AWS::EC2::Subnet', 9);
  for (const az of ['ap-southeast-2a', 'ap-southeast-2b', 'ap-southeast-2c']) {
    template.hasResourceProperties('AWS::EC2::Subnet', { AvailabilityZone: az });
  }
  // The AZ segment flows into the convention name too.
  template.hasResourceProperties('AWS::EC2::Subnet', {
    AvailabilityZone: 'ap-southeast-2a',
    CidrBlock: '10.0.4.0/24',
    Tags: Match.arrayWith([{ Key: 'Name', Value: 'derrops--region--public--2a' }]),
  });
});

test('produces the same names in every region (names are region-scoped in AWS)', () => {
  const template = synthIn('ap-southeast-2');
  // Identical to the us-east-1 expectations above. SSM parameters and stack
  // names are per-region, so repeating them is the design, not a collision.
  template.hasResourceProperties('AWS::SSM::Parameter', {
    Name: '/derrops/region/network/vpc-id',
  });
});

test('refuses to synth without a concrete region', () => {
  const app = new cdk.App();
  // No env → `this.region` is an unresolved token and every AZ name would be
  // garbage; fail loudly instead.
  expect(() => new VpcStack(app, 'AgnosticVpcStack')).toThrow(
    /requires a concrete region/,
  );
});
