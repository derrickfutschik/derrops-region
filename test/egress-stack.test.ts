import * as cdk from 'aws-cdk-lib/core';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { EgressStack } from '../lib/egress-stack';

const env = { account: '123456789012', region: 'us-east-1' };

function synth(stackEnv = env) {
  const app = new cdk.App();
  // A throwaway host stack to mint real VPC / route table / instance tokens.
  const host = new cdk.Stack(app, 'Host', { env: stackEnv });
  const vpc = new ec2.CfnVPC(host, 'Vpc', { cidrBlock: '10.0.0.0/16' });
  const privateRouteTable = new ec2.CfnRouteTable(host, 'PrivateRt', { vpcId: vpc.ref });
  const instance = new ec2.CfnInstance(host, 'Bastion', {
    instanceType: 't4g.nano',
    imageId: 'ami-12345678',
  });
  const stack = new EgressStack(app, 'TestEgressStack', {
    env: stackEnv,
    vpc,
    privateRouteTable,
    target: { kind: 'instance', instance },
  });
  return Template.fromStack(stack);
}

test('routes the private tier 0.0.0.0/0 to the NAT instance', () => {
  const template = synth();
  template.resourceCountIs('AWS::EC2::Route', 1);
  template.hasResourceProperties('AWS::EC2::Route', {
    DestinationCidrBlock: '0.0.0.0/0',
    RouteTableId: Match.anyValue(),
    InstanceId: Match.anyValue(),
    GatewayId: Match.absent(),
    NatGatewayId: Match.absent(),
  });
});

test('creates no NAT Gateway (the bastion is the NAT)', () => {
  const template = synth();
  template.resourceCountIs('AWS::EC2::NatGateway', 0);
});

test('adds a free S3 gateway endpoint on the private route table, convention-named', () => {
  const template = synth();
  template.resourceCountIs('AWS::EC2::VPCEndpoint', 1);
  template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
    ServiceName: 'com.amazonaws.us-east-1.s3',
    VpcEndpointType: 'Gateway',
    RouteTableIds: [Match.anyValue()],
    Tags: Match.arrayWith([{ Key: 'Name', Value: 'derrops--region--egress' }]),
  });
});

// The S3 service name is region-derived; this catches a hardcoded region.
test('builds the S3 service name from the stack region (ap-southeast-2)', () => {
  const template = synth({ account: '123456789012', region: 'ap-southeast-2' });
  template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
    ServiceName: 'com.amazonaws.ap-southeast-2.s3',
  });
});

test('names the stack by convention', () => {
  const app = new cdk.App();
  const host = new cdk.Stack(app, 'Host', { env });
  const vpc = new ec2.CfnVPC(host, 'Vpc', { cidrBlock: '10.0.0.0/16' });
  const stack = new EgressStack(app, 'TestEgressStack', {
    env,
    vpc,
    privateRouteTable: new ec2.CfnRouteTable(host, 'Rt', { vpcId: vpc.ref }),
    target: {
      kind: 'instance',
      instance: new ec2.CfnInstance(host, 'I', { imageId: 'ami-12345678' }),
    },
  });
  expect(stack.stackName).toBe('derrops--region--egress');
});

test('rejects an unresolved (token) region', () => {
  const app = new cdk.App();
  const host = new cdk.Stack(app, 'Host');
  const vpc = new ec2.CfnVPC(host, 'Vpc', { cidrBlock: '10.0.0.0/16' });
  expect(
    () =>
      new EgressStack(app, 'TestEgressStack', {
        vpc,
        privateRouteTable: new ec2.CfnRouteTable(host, 'Rt', { vpcId: vpc.ref }),
        target: {
          kind: 'instance',
          instance: new ec2.CfnInstance(host, 'I', { imageId: 'ami-12345678' }),
        },
      }),
  ).toThrow(/concrete region/);
});
