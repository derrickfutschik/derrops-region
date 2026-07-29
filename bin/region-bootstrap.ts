#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { VpcStack, naming as vpcNaming } from '../lib/vpc-stack';
import { BastionStack, naming as bastionNaming } from '../lib/bastion-stack';

const app = new cdk.App();

// The region is a required, explicit input — every stack here is deployed once
// per region you want to light up, so there is no sensible default. Falling
// back to the ambient profile's region is how a VPC ends up in the wrong place,
// and the stack names are identical in every region, so the mistake is not
// visible in `cdk diff`.
const region = app.node.tryGetContext('region');
if (!region) {
  throw new Error(
    'Region is required. Pass it as context, e.g.\n' +
      '  npx cdk deploy --all -c region=ap-southeast-2',
  );
}

const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region,
};

// Construct ids follow the derrops convention (they match each stack name).

// The region's shared network. One VPC per region, all subnet tiers, no NAT
// Gateways (cost). See the stack docs for where the Tailscale relay EC2 runs.
const vpc = new VpcStack(app, vpcNaming.name({ type: 'cloudFormationStack' }), {
  env,
  description:
    "The region's shared VPC (all subnet tiers, IGW-only/no-NAT) — one per region.",
});

// Tiny t4g.nano bastion in a public subnet, reachable via SSM Session Manager.
// Meant to be joined to a tailnet manually (over SSM) to bridge the VPC and a
// local server. Consumes the VPC by reference, so it deploys after it.
const bastion = new BastionStack(
  app,
  bastionNaming.name({ type: 'cloudFormationStack' }),
  {
    env,
    description:
      'Tiny t4g.nano bastion (public subnet, SSM-only access) to bridge this region to a tailnet.',
    vpc: vpc.vpc,
    publicSubnets: vpc.publicSubnets,
  },
);
bastion.addStackDependency(vpc);

app.synth();
