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
    // No `purpose` segment — the service is already 'bastion', so adding one
    // would stutter (derrops--region--bastion--bastion).
    GroupName: 'derrops--region--bastion',
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

test('allocates a VPC Elastic IP and associates it with the instance', () => {
  const template = synth();
  template.resourceCountIs('AWS::EC2::EIP', 1);
  template.hasResourceProperties('AWS::EC2::EIP', {
    Domain: 'vpc',
    // An EIP has no name property — the convention name lands on the Name tag.
    // `ec2ElasticIp` is an org/domain/service type, so there is no key segment.
    Tags: Match.arrayWith([{ Key: 'Name', Value: 'derrops--region--bastion' }]),
  });
  template.resourceCountIs('AWS::EC2::EIPAssociation', 1);
  template.hasResourceProperties('AWS::EC2::EIPAssociation', {
    AllocationId: { 'Fn::GetAtt': [Match.anyValue(), 'AllocationId'] },
    InstanceId: { Ref: Match.anyValue() },
  });
});

test('publishes each access detail under a parameter named for its exact value', () => {
  const template = synth();
  const params = Object.values(template.findResources('AWS::SSM::Parameter'));
  const byName = new Map(params.map((p) => [p.Properties.Name, p.Properties.Value]));

  expect([...byName.keys()].sort()).toEqual([
    '/derrops/region/bastion/eip-allocation-id',
    '/derrops/region/bastion/instance-id',
    '/derrops/region/bastion/private-dns-name',
    '/derrops/region/bastion/private-ip',
    '/derrops/region/bastion/public-ip',
    '/derrops/region/bastion/security-group-id',
  ]);

  // Each value comes off the right attribute of the right resource — the point
  // of naming them precisely is defeated if one carries the wrong address.
  expect(byName.get('/derrops/region/bastion/private-ip')).toEqual({
    'Fn::GetAtt': ['BastionInstance', 'PrivateIp'],
  });
  expect(byName.get('/derrops/region/bastion/private-dns-name')).toEqual({
    'Fn::GetAtt': ['BastionInstance', 'PrivateDnsName'],
  });
  expect(byName.get('/derrops/region/bastion/security-group-id')).toEqual({
    'Fn::GetAtt': ['BastionSecurityGroup', 'GroupId'],
  });
  expect(byName.get('/derrops/region/bastion/eip-allocation-id')).toEqual({
    'Fn::GetAtt': ['BastionEip', 'AllocationId'],
  });
});

test('public-ip comes off the Elastic IP, never the instance', () => {
  const template = synth();
  const params = Object.values(template.findResources('AWS::SSM::Parameter'));
  const publicIp = params.find(
    (p) => p.Properties.Name === '/derrops/region/bastion/public-ip',
  );
  // The instance's own PublicIp/PublicDnsName attributes are captured at create
  // time, before the EIP is associated, so they would be stale forever. The EIP
  // is the authoritative source for the address.
  expect(publicIp?.Properties.Value).toEqual({
    'Fn::GetAtt': ['BastionEip', 'PublicIp'],
  });
  for (const p of params) {
    expect(JSON.stringify(p.Properties.Value)).not.toContain('PublicDnsName');
    expect(p.Properties.Value).not.toEqual({
      'Fn::GetAtt': ['BastionInstance', 'PublicIp'],
    });
  }
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
