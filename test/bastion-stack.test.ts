import * as cdk from 'aws-cdk-lib/core';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { BastionStack } from '../lib/bastion-stack';

const env = { account: '123456789012', region: 'us-east-1' };

function synth(
  props: Partial<ConstructorParameters<typeof BastionStack>[2]> = {},
  vpcCidr = '10.0.0.0/16',
) {
  const app = new cdk.App();
  // A throwaway host stack to mint real CfnVPC / CfnSubnet tokens to hand in.
  const host = new cdk.Stack(app, 'Host', { env });
  const vpc = new ec2.CfnVPC(host, 'Vpc', { cidrBlock: vpcCidr });
  const publicSubnets = [
    new ec2.CfnSubnet(host, 'PublicA', {
      vpcId: vpc.ref,
      cidrBlock: '10.0.4.0/24',
      availabilityZone: 'us-east-1a',
    }),
  ];
  const stack = new BastionStack(app, 'TestBastionStack', {
    env,
    vpc,
    publicSubnets,
    ...props,
  });
  return Template.fromStack(stack);
}

test('creates a single t4g.nano instance', () => {
  const template = synth();
  template.resourceCountIs('AWS::EC2::Instance', 1);
  template.hasResourceProperties('AWS::EC2::Instance', {
    InstanceType: 't4g.nano',
    // `kind: 'public-blocked'` — in a public subnet, but with all inbound blocked.
    Tags: Match.arrayWith([
      { Key: 'Name', Value: 'derrops--region--bastion--public-blocked' },
    ]),
  });
});

test('instanceType is overridable', () => {
  const template = synth({ instanceType: 't4g.micro' });
  template.hasResourceProperties('AWS::EC2::Instance', { InstanceType: 't4g.micro' });
});

test('lands in the provided public subnet', () => {
  const template = synth();
  template.hasResourceProperties('AWS::EC2::Instance', {
    SubnetId: Match.anyValue(),
  });
});

test('is reachable via SSM Session Manager (instance profile with SSM core)', () => {
  const template = synth();
  template.resourceCountIs('AWS::IAM::InstanceProfile', 1);
  // EC2 assume-role trust.
  template.hasResourceProperties('AWS::IAM::Role', {
    AssumeRolePolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Principal: { Service: 'ec2.amazonaws.com' },
        }),
      ]),
    },
    ManagedPolicyArns: Match.arrayWith([
      Match.objectLike({
        'Fn::Join': Match.arrayWith([
          Match.arrayWith([':iam::aws:policy/AmazonSSMManagedInstanceCore']),
        ]),
      }),
    ]),
  });
});

test('the bastion role has no pinned name, so it survives a second region', () => {
  const template = synth();
  // IAM is account-global: a fixed convention name would collide the moment
  // this stack is deployed to a second region in the same account. CDK must be
  // left to generate a unique physical name.
  template.hasResourceProperties('AWS::IAM::Role', {
    RoleName: Match.absent(),
  });
});

test('security group allows all egress and inbound from the VPC only', () => {
  const template = synth();
  template.hasResourceProperties('AWS::EC2::SecurityGroup', {
    GroupName: 'derrops--region--bastion--bastion',
    SecurityGroupEgress: [
      Match.objectLike({ IpProtocol: '-1', CidrIp: '0.0.0.0/0' }),
    ],
    // Exactly one ingress rule, and its CIDR is the VPC's own (taken off the
    // VPC, not restated in BastionStack — the host VPC above is 10.0.0.0/16).
    // Anything from outside that range, i.e. the internet, matches nothing.
    SecurityGroupIngress: [
      {
        IpProtocol: '-1',
        CidrIp: '10.0.0.0/16',
        Description: Match.anyValue(),
      },
    ],
  });
});

test('the inbound CIDR follows the VPC it is given, not a literal', () => {
  const template = synth({}, '172.31.0.0/16');
  template.hasResourceProperties('AWS::EC2::SecurityGroup', {
    SecurityGroupIngress: [Match.objectLike({ CidrIp: '172.31.0.0/16' })],
  });
});

test('the security group opens nothing to 0.0.0.0/0 inbound', () => {
  const template = synth();
  // The guard that matters: a public-subnet box with a public IPv4 must never
  // grow an internet-facing ingress rule.
  const sgs = template.findResources('AWS::EC2::SecurityGroup');
  for (const sg of Object.values(sgs)) {
    for (const rule of sg.Properties?.SecurityGroupIngress ?? []) {
      expect(rule.CidrIp).not.toBe('0.0.0.0/0');
      expect(rule.CidrIpv6).not.toBe('::/0');
    }
  }
});

test('publishes an instance-id discovery parameter', () => {
  const template = synth();
  template.hasResourceProperties('AWS::SSM::Parameter', {
    Name: '/derrops/region/bastion/instance-id',
  });
});

test('resources carry the derrops org tags', () => {
  const template = synth();
  for (const tag of [
    { Key: 'derrops:domain', Value: 'region' },
    { Key: 'derrops:service', Value: 'bastion' },
  ]) {
    template.hasResourceProperties('AWS::EC2::Instance', {
      Tags: Match.arrayWith([tag]),
    });
  }
});
