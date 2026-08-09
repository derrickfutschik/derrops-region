import { ensureAmiParameter, type AmiParameterOps } from '../lib/ensure-ami-parameter';

const PARAM = '/derrops/region/bastion/ami-id';
const LATEST_POINTER = '/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-6.1-arm64';

/**
 * A stub parameter store: whatever is in `store` exists, everything else does
 * not. Writes are recorded so a test can assert nothing was written at all —
 * which is the property that matters most here.
 */
function ops(store: Record<string, string>) {
  const puts: Array<{ name: string; value: string }> = [];
  const io: AmiParameterOps = {
    getParameter: async (name) => store[name],
    putParameter: async (name, value) => {
      puts.push({ name, value });
      store[name] = value;
    },
  };
  return { io, puts };
}

test('seeds the pin with the latest AL2023 arm64 image when absent', async () => {
  const { io, puts } = ops({ [LATEST_POINTER]: 'ami-latest' });

  const result = await ensureAmiParameter('ap-southeast-2', PARAM, io);

  expect(result).toEqual({ action: 'seeded', amiId: 'ami-latest' });
  expect(puts).toEqual([{ name: PARAM, value: 'ami-latest' }]);
});

// The whole point of the pin: a deploy must never move the AMI, or it replaces
// the hand-configured instance. An existing value wins even when AWS has since
// published a newer image.
test('leaves an existing pin alone, even when a newer image exists', async () => {
  const { io, puts } = ops({ [PARAM]: 'ami-pinned', [LATEST_POINTER]: 'ami-newer' });

  const result = await ensureAmiParameter('ap-southeast-2', PARAM, io);

  expect(result).toEqual({ action: 'kept', amiId: 'ami-pinned' });
  expect(puts).toEqual([]);
});

test('is idempotent — a second call keeps what the first one seeded', async () => {
  const { io, puts } = ops({ [LATEST_POINTER]: 'ami-latest' });

  await ensureAmiParameter('ap-southeast-2', PARAM, io);
  const second = await ensureAmiParameter('ap-southeast-2', PARAM, io);

  expect(second).toEqual({ action: 'kept', amiId: 'ami-latest' });
  expect(puts).toHaveLength(1);
});

// Better to fail than to write something that is not an AMI id — the deploy
// would then fail at the CloudFormation parameter with a worse message.
test('raises rather than seeding when the AWS pointer returns nothing', async () => {
  const { io, puts } = ops({});

  await expect(ensureAmiParameter('ap-southeast-2', PARAM, io)).rejects.toThrow(
    /returned no value/,
  );
  expect(puts).toEqual([]);
});
