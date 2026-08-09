#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { VpcStack, naming as vpcNaming } from '../lib/vpc-stack';
import {
  BastionStack,
  amiParameterName,
  naming as bastionNaming,
} from '../lib/bastion-stack';
import { ensureAmiParameter } from '../lib/ensure-ami-parameter';

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

// ── Seed the bastion's AMI pin, if this region has never had one ────────────
// The one piece of setup that cannot live in a stack: `BastionStack` reads the
// AMI as an `AWS::SSM::Parameter::Value<>`, and CloudFormation resolves those
// before it touches any resource, so the parameter has to exist before the
// deploy starts. This is create-if-absent and reads AWS's latest-AL2023-arm64
// pointer for the default, so a brand-new region just works and an existing
// pin — including one edited by hand — is never disturbed.
//
// Failures are reported and swallowed on purpose. This runs on every `cdk`
// command, including `list` and `synth`, which must keep working without
// credentials; if the parameter really is missing the deploy fails on its own,
// loudly, before changing anything.
//
// Awaited rather than fired off: the CDK CLI moves straight from this process
// to the deploy, so the seed has to have landed by the time synth returns.
async function main(): Promise<void> {
  try {
    const { action, amiId } = await ensureAmiParameter(region, amiParameterName);
    if (action === 'seeded') {
      console.error(
        `Seeded ${amiParameterName} in ${region} with ${amiId} (latest AL2023 arm64).`,
      );
    }
  } catch (err: unknown) {
    console.error(
      `Warning: could not ensure ${amiParameterName} in ${region}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  app.synth();
}

void main();
